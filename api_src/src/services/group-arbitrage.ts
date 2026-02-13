import { PolymarketSDK, RateLimiter, ApiType, PolymarketError, ErrorCode, withRetry } from '../../../dist/index.js';
import { TradingClientOverride as TradingClient } from '../clients/trading-client-override.js';
import { CTFClient } from '../../../dist/clients/ctf-client.js';
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { RelayClient, RelayerTxType } from '@polymarket/builder-relayer-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { createWalletClient, http, encodeFunctionData, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { computeAskDepthUsd } from '../utils/orderbook-depth.js';
import { buildOrderbookSnapshot } from '../utils/orderbook-replay.js';
import { runSweepBuyLive, runSweepBuyLiveBurst } from './sweep-buy.js';
import { getSharedMarketData, type SharedMarketData } from './shared-market-data.js';

export interface GroupArbOpportunity {
    marketId: string;
    gammaId: string; // Store Gamma ID explicitly for links
    question: string;
    slug: string;
    outcomes: string[];
    tokenIds: string[];
    prices: number[];
    yesPrice: number;
    noPrice: number;
    totalCost: number;
    spreadSum?: number;
    yesSpread?: number;
    noSpread?: number;
    profit: number;
    profitPercent: number;
    liquidity: number;
    bidSum: number;
    endDate: string; // Added End Date for frontend visibility
    isWeather: boolean; // Flag to highlight weather markets
    ratioScore: number; // 0.0 to 1.0 (1.0 = perfect 50/50 split)
    image?: string; // Market icon URL
    volume24hr?: number;
}

interface StrategySettings {
    targetProfitPercent: number;
    cutLossPercent: number;
    trailingStopPercent: number;
    enableOneLegTimeout?: boolean;
    oneLegTimeoutMinutes: number;
    autoCancelUnfilledOnTimeout?: boolean;
    wideSpreadCents: number;
    forceMarketExitFromPeakPercent: number;
    enableHedgeComplete?: boolean;
    oneLegTimeoutAction?: 'UNWIND_EXIT' | 'HEDGE_COMPLETE';
    maxSpreadCentsForHedge?: number;
    maxSlippageCents?: number;
}

interface MonitoredLeg {
    outcome: 'Yes' | 'No';
    tokenId: string;
    orderId: string;
    entryPrice: number;
    size: number;
    filledSize: number;
    peakMid: number;
    status: 'live' | 'filled' | 'closed';
}

interface MonitoredPosition {
    marketId: string;
    createdAt: number;
    mode: 'semi' | 'auto';
    settings: StrategySettings;
    legs: { yes: MonitoredLeg; no: MonitoredLeg };
    status: 'orders_live' | 'one_leg_filled' | 'both_legs_filled' | 'exited';
}

export class GroupArbitrageScanner {
    private sdk: PolymarketSDK;
    private tradingClient: TradingClient;
    private ctf?: CTFClient;
    private redeemProvider?: ethers.providers.JsonRpcProvider;
    private redeemWallet?: ethers.Wallet;
    private relayerSafe?: RelayClient;
    private relayerProxy?: RelayClient;
    private relayerConfigured = false;
    public latestResults: GroupArbOpportunity[] = [];
    public latestLogs: string[] = [];
    public orderHistory: any[] = []; // In-memory order history
    private orderHistoryPath: string = '';
    private orderHistoryLoadedAt: string | null = null;
    private orderHistoryPersistedAt: string | null = null;
    private orderHistoryPersistLastError: string | null = null;
    private orderHistoryPersistTimer: any = null;
    private monitoredPositions: Map<string, MonitoredPosition> = new Map();
    private orderStatusCache: Map<string, { updatedAtMs: number; data: any }> = new Map();
    private systemCanceledOrderIds: Set<string> = new Set();
    private marketMetaCache: Map<string, { title?: string; slug?: string; eventSlug?: string }> = new Map();
    private dataApiPositionsCache: Map<string, { atMs: number; data: any[] }> = new Map();
    private dataApiPositionsInFlight: Map<string, Promise<any[]>> = new Map();
    private dataApiValueCache: Map<string, { atMs: number; value: number }> = new Map();
    private dataApiValueInFlight: Map<string, Promise<number>> = new Map();
    private pnlSnapshots: Array<{ ts: number; equity: number; cash: number; positionsValue: number }> = [];
    private pnlTimer: any = null;
    private pnlPersistencePath: string;
    private pnlWriteTimer: any = null;
    private tradingInitTimer: any = null;
    private tradingInitBackoffMs = 5_000;
    private tradingInitNextAllowedAtMs = 0;
    private autoRedeemConfig: { enabled: boolean; intervalMs: number; maxPerCycle: number } = { enabled: false, intervalMs: 5_000, maxPerCycle: 20 };
    private autoRedeemTimer: any = null;
    private autoRedeemLast: any = null;
    private autoRedeemNextAt: string | null = null;
    private autoRedeemLastError: string | null = null;
    private autoRedeemConfigPath: string = '';
    private autoRedeemConfigLoadedAt: string | null = null;
    private autoRedeemConfigPersistedAt: string | null = null;
    private autoRedeemConfigPersistLastError: string | null = null;
    private crypto15mAutoEnabled = false;
    private crypto15mAutoDryRun = false;
    private crypto15mAutoTimer: any = null;
    private crypto15mAutoInFlight = false;
    private crypto15mAutoConfigPath: string | null = null;
    private crypto15mAutoConfigLoadedAt: string | null = null;
    private crypto15mAutoConfigPersistedAt: string | null = null;
    private crypto15mAutoConfigPersistLastError: string | null = null;
    private crypto15mAutoConfig: {
        pollMs: number;
        expiresWithinSec: number;
        minProb: number;
        amountUsd: number;
        buySizingMode: 'fixed' | 'orderbook_max' | 'all_capital';
        sweepEnabled: boolean;
        sweepWindowSec: number;
        sweepMaxOrdersPerMarket: number;
        sweepMaxTotalUsdPerMarket: number;
        sweepMinIntervalMs: number;
        trendEnabled: boolean;
        trendMinutes: number;
        staleMsThreshold: number;
        stoplossEnabled: boolean;
        stoplossCut1DropCents: number;
        stoplossCut1SellPct: number;
        stoplossCut2DropCents: number;
        stoplossCut2SellPct: number;
        stoplossMinSecToExit: number;
        adaptiveDeltaEnabled: boolean;
        adaptiveDeltaBigMoveMultiplier: number;
        adaptiveDeltaRevertNoBuyCount: number;
    } = {
        pollMs: 2_000,
        expiresWithinSec: 180,
        minProb: 0.9,
        amountUsd: 1,
        buySizingMode: 'fixed',
        sweepEnabled: true,
        sweepWindowSec: 30,
        sweepMaxOrdersPerMarket: 10,
        sweepMaxTotalUsdPerMarket: 600,
        sweepMinIntervalMs: 400,
        trendEnabled: true,
        trendMinutes: 1,
        staleMsThreshold: 5_000,
        stoplossEnabled: false,
        stoplossCut1DropCents: 1,
        stoplossCut1SellPct: 50,
        stoplossCut2DropCents: 2,
        stoplossCut2SellPct: 100,
        stoplossMinSecToExit: 25,
        adaptiveDeltaEnabled: true,
        adaptiveDeltaBigMoveMultiplier: 2,
        adaptiveDeltaRevertNoBuyCount: 4,
    };
    private crypto15mLastScanAt: string | null = null;
    private crypto15mLastError: string | null = null;
    private crypto15mLastDecision: any = null;
    private crypto15mLastCandidateStats: any = null;
    private crypto15mLastOrderAttempt: any = null;
    private crypto15mOrderLocks: Map<string, { atMs: number; symbol: string; expiresAtMs: number; conditionId: string; status: 'placing' | 'ordered' | 'failed' }> = new Map();
    private crypto15mSweepStateByConditionId: Map<string, { conditionId: string; symbol: string; expiresAtMs: number; ordersCount: number; totalUsd: number; lastOrderAtMs: number }> = new Map();
    private crypto15mDeltaThresholdsPath: string | null = null;
    private crypto15mDeltaThresholds: { btcMinDelta: number; ethMinDelta: number; solMinDelta: number; xrpMinDelta: number; updatedAt: string | null; loadedAt: string | null; persistLastError: string | null } = {
        btcMinDelta: 600,
        ethMinDelta: 30,
        solMinDelta: 0.8,
        xrpMinDelta: 0.0065,
        updatedAt: null,
        loadedAt: null,
        persistLastError: null,
    };
    private cryptoAll2DeltaThresholdsPath: string | null = null;
    private cryptoAll2DeltaThresholds: { btcMinDelta: number; ethMinDelta: number; solMinDelta: number; xrpMinDelta: number; updatedAt: string | null; loadedAt: string | null; persistLastError: string | null } = {
        btcMinDelta: 600,
        ethMinDelta: 30,
        solMinDelta: 0.8,
        xrpMinDelta: 0.0065,
        updatedAt: null,
        loadedAt: null,
        persistLastError: null,
    };
    private crypto15mAdaptiveDeltaBySymbol: Map<string, { overrideDelta: number | null; noBuyCount: number; lastBigMoveAt: string | null; lastBigMoveDelta: number | null }> = new Map();
    private crypto15mWatchdogTimer: any = null;
    private crypto15mWatchdog: {
        running: boolean;
        pollMs: number;
        startedAtMs: number;
        endsAtMs: number;
        lastTickAtMs: number;
        lastError: string | null;
        stopReason: string | null;
        thresholds: {
            consecutiveStaleStops: number;
            staleMsThreshold: number;
            consecutiveDataStops: number;
            redeemSubmittedTimeoutMs: number;
            redeemFailedStops: number;
            orderFailedStops: number;
        };
        counters: {
            consecutiveStale: number;
            consecutiveDataError: number;
            redeemFailed: number;
            orderFailed: number;
        };
        issues: Array<{ at: string; type: string; message: string; meta?: any }>;
        reportPaths: { json?: string; md?: string };
    } = {
        running: false,
        pollMs: 30_000,
        startedAtMs: 0,
        endsAtMs: 0,
        lastTickAtMs: 0,
        lastError: null,
        stopReason: null,
        thresholds: {
            consecutiveStaleStops: 5,
            staleMsThreshold: 5_000,
            consecutiveDataStops: 5,
            redeemSubmittedTimeoutMs: 20 * 60_000,
            redeemFailedStops: 1,
            orderFailedStops: 2,
        },
        counters: {
            consecutiveStale: 0,
            consecutiveDataError: 0,
            redeemFailed: 0,
            orderFailed: 0,
        },
        issues: [],
        reportPaths: {},
    };
    private crypto15mHedgeAutoEnabled = false;
    private crypto15mHedgeAutoTimer: any = null;
    private crypto15mHedgeAutoInFlight = false;
    private crypto15mHedgeLastScanAt: string | null = null;
    private crypto15mHedgeLastError: string | null = null;
    private crypto15mHedgeLastDecision: any = null;
    private crypto15mHedgeLastOrderAttempt: any = null;
    private crypto15mHedgeConfigPath: string | null = null;
    private crypto15mHedgeConfigLoadedAt: string | null = null;
    private crypto15mHedgeConfigPersistedAt: string | null = null;
    private crypto15mHedgeConfigPersistLastError: string | null = null;
    private crypto15mHedgeActivesBySymbol: Map<string, any> = new Map();
    private crypto15mHedgeTrackedByCondition: Map<string, any> = new Map();
    private crypto15mHedgeOrderLocks: Map<string, { atMs: number; symbol: string; expiresAtMs: number; conditionId: string; status: 'placing' | 'ordered' | 'failed' }> = new Map();
    private crypto15mHedgeAttemptLogState: Map<string, { atMs: number; reason: string }> = new Map();
    private crypto15mHedgeAutoConfig: {
        pollMs: number;
        expiresWithinSec: number;
        minProb: number;
        amountUsd: number;
        entryRemainingMinSec: number;
        entryRemainingMaxSec: number;
        entryCheapMinCents: number;
        entryCheapMaxCents: number;
        targetProfitCents: number;
        profitDecayEnabled: boolean;
        profitDecayMode: 'linear' | 'per_minute';
        profitDecayPerMinCents: number;
        profitStartCents: number;
        profitEndCents: number;
        profitDecayStartSec: number;
        profitDecayEndSec: number;
        profitStepCents: number;
        mode: 'conservative' | 'balanced' | 'aggressive';
        bufferCents: number;
        maxSpreadCents: number;
        minDepthPct: number;
        minSecToHedge: number;
        hedgeIgnoreSpread: boolean;
        panicHedgeEnabled: boolean;
        panicHedgeStartSec: number;
        panicMaxLossCents: number;
    } = {
        pollMs: 2_000,
        expiresWithinSec: 900,
        minProb: 0,
        amountUsd: 200,
        entryRemainingMinSec: 480,
        entryRemainingMaxSec: 900,
        entryCheapMinCents: 8,
        entryCheapMaxCents: 15,
        targetProfitCents: 10,
        profitDecayEnabled: false,
        profitDecayMode: 'linear',
        profitDecayPerMinCents: 1,
        profitStartCents: 10,
        profitEndCents: 9,
        profitDecayStartSec: 300,
        profitDecayEndSec: 60,
        profitStepCents: 0.1,
        mode: 'balanced',
        bufferCents: 1.5,
        maxSpreadCents: 3,
        minDepthPct: 70,
        minSecToHedge: 90,
        hedgeIgnoreSpread: false,
        panicHedgeEnabled: false,
        panicHedgeStartSec: 120,
        panicMaxLossCents: 20,
    };
    private crypto15mActivesBySymbol: Map<string, any> = new Map();
    private crypto15mTrackedByCondition: Map<string, any> = new Map();
    private crypto15mCooldownUntilBySymbol: Map<string, number> = new Map();
    private crypto15mBeatCache: Map<string, { atMs: number; priceToBeat: number | null; currentPrice: number | null; deltaAbs: number | null; error: string | null }> = new Map();
    private crypto15mCryptoTagId: string | null = null;
    private crypto15mNextScanAllowedAtMs = 0;
    private sharedMarketData: SharedMarketData = getSharedMarketData();
    private get crypto15mMarketSnapshot() { return this.sharedMarketData.crypto15mMarketSnapshot; }
    private set crypto15mMarketSnapshot(v) { this.sharedMarketData.crypto15mMarketSnapshot = v; }
    private get crypto15mBooksSnapshot() { return this.sharedMarketData.crypto15mBooksSnapshot; }
    private set crypto15mBooksSnapshot(v) { this.sharedMarketData.crypto15mBooksSnapshot = v; }
    private get crypto15mMarketInFlight() { return this.sharedMarketData.crypto15mMarketInFlight; }
    private set crypto15mMarketInFlight(v) { this.sharedMarketData.crypto15mMarketInFlight = v; }
    private get crypto15mBooksInFlight() { return this.sharedMarketData.crypto15mBooksInFlight; }
    private set crypto15mBooksInFlight(v) { this.sharedMarketData.crypto15mBooksInFlight = v; }
    private get crypto15mMarketBackoffMs() { return this.sharedMarketData.crypto15mMarketBackoffMs; }
    private set crypto15mMarketBackoffMs(v) { this.sharedMarketData.crypto15mMarketBackoffMs = v; }
    private get crypto15mMarketNextAllowedAtMs() { return this.sharedMarketData.crypto15mMarketNextAllowedAtMs; }
    private set crypto15mMarketNextAllowedAtMs(v) { this.sharedMarketData.crypto15mMarketNextAllowedAtMs = v; }
    private get crypto15mBooksBackoffMs() { return this.sharedMarketData.crypto15mBooksBackoffMs; }
    private set crypto15mBooksBackoffMs(v) { this.sharedMarketData.crypto15mBooksBackoffMs = v; }
    private get crypto15mBooksNextAllowedAtMs() { return this.sharedMarketData.crypto15mBooksNextAllowedAtMs; }
    private set crypto15mBooksNextAllowedAtMs(v) { this.sharedMarketData.crypto15mBooksNextAllowedAtMs = v; }
    private crypto15mWsClients: Map<any, { minProb: number; expiresWithinSec: number; limit: number }> = new Map();
    private crypto15mWsTimer: any = null;
    private cryptoAll2LastError: string | null = null;
    private cryptoAll2LastDecision: any = null;
    private cryptoAll2LastCandidateStats: any = null;
    private cryptoAll2LastOrderAttempt: any = null;
    private cryptoAll2LastSplitLegAttempt: any = null;
    private cryptoAll2OrderLocks: Map<string, { atMs: number; symbol: string; expiresAtMs: number; conditionId: string; status: 'placing' | 'ordered' | 'failed' }> = new Map();
    private cryptoAll2ActivesBySymbol: Map<string, any> = new Map();
    private cryptoAll2TrackedByCondition: Map<string, any> = new Map();
    private cryptoAll2AutoEnabled = false;
    private cryptoAll2AutoTimer: any = null;
    private cryptoAll2AutoInFlight = false;
    private cryptoAll2LastScanAt: string | null = null;
    private cryptoAll2NextScanAllowedAtMs = 0;
    private cryptoAll2AutoConfigPath: string | null = null;
    private cryptoAll2AutoConfigLoadedAt: string | null = null;
    private cryptoAll2AutoConfigPersistedAt: string | null = null;
    private cryptoAll2AutoConfigPersistLastError: string | null = null;
    private cryptoAll2AutoConfig: {
        pollMs: number;
        expiresWithinSec: number;
        minProb: number;
        amountUsd: number;
        symbols: string[];
        dojiGuardEnabled: boolean;
        riskSkipScore: number;
        splitBuyEnabled: boolean;
        splitBuyPct3m: number;
        splitBuyPct2m: number;
        splitBuyPct1m: number;
        splitBuyTrendEnabled: boolean;
        splitBuyTrendMinutes3m: number;
        splitBuyTrendMinutes2m: number;
        splitBuyTrendMinutes1m: number;
        stoplossEnabled: boolean;
        stoplossCut1DropCents: number;
        stoplossCut1SellPct: number;
        stoplossCut2DropCents: number;
        stoplossCut2SellPct: number;
        stoplossMinSecToExit: number;
        adaptiveDeltaEnabled: boolean;
        adaptiveDeltaBigMoveMultiplier: number;
        adaptiveDeltaRevertNoBuyCount: number;
    } = {
        pollMs: 2_000,
        expiresWithinSec: 180,
        minProb: 0.9,
        amountUsd: 1,
        symbols: ['BTC', 'ETH', 'SOL', 'XRP'],
        dojiGuardEnabled: true,
        riskSkipScore: 70,
        splitBuyEnabled: false,
        splitBuyPct3m: 34,
        splitBuyPct2m: 33,
        splitBuyPct1m: 33,
        splitBuyTrendEnabled: true,
        splitBuyTrendMinutes3m: 3,
        splitBuyTrendMinutes2m: 2,
        splitBuyTrendMinutes1m: 1,
        stoplossEnabled: false,
        stoplossCut1DropCents: 1,
        stoplossCut1SellPct: 50,
        stoplossCut2DropCents: 2,
        stoplossCut2SellPct: 100,
        stoplossMinSecToExit: 25,
        adaptiveDeltaEnabled: true,
        adaptiveDeltaBigMoveMultiplier: 2,
        adaptiveDeltaRevertNoBuyCount: 4,
    };
    private cryptoAll2AdaptiveDeltaBySymbol: Map<string, { overrideDelta: number | null; noBuyCount: number; lastBigMoveAt: string | null; lastBigMoveDelta: number | null }> = new Map();
    private cryptoAll2SplitBuyState: Map<string, any> = new Map();
    private cryptoAll2SplitBuyTimer: any = null;
    private cryptoAllAutoEnabled = false;
    private cryptoAllAutoDryRun = false;
    private cryptoAllAutoTimer: any = null;
    private cryptoAllAutoInFlight = false;
    private cryptoAllStoplossTimer: any = null;
    private cryptoAllLastScanSummary: any = null;
    private cryptoAllSplitBuyState: Map<string, any> = new Map();
    private cryptoAllSplitBuyTimer: any = null;
    private cryptoAllAdaptiveDeltaBySymbol: Map<string, { overrideDelta: number | null; noBuyCount: number; lastBigMoveAt: string | null; lastBigMoveDelta: number | null }> = new Map();
    private cryptoAllAutoConfigPath: string | null = null;
    private cryptoAllAutoConfigLoadedAt: string | null = null;
    private cryptoAllAutoConfigPersistedAt: string | null = null;
    private cryptoAllAutoConfigPersistLastError: string | null = null;
    private cryptoAllAutoConfig: {
        pollMs: number;
        expiresWithinSec: number;
        expiresWithinSecByTimeframe: Record<'5m' | '15m' | '1h' | '4h' | '1d', number>;
        minProb: number;
        amountUsd: number;
        symbols: string[];
        timeframes: Array<'5m' | '15m' | '1h' | '4h' | '1d'>;
        dojiGuard: { enabled: boolean; riskSkipScore: number; riskAddOnBlockScore: number };
        addOn: {
            enabled: boolean;
            windowA: { minSec: number; maxSec: number };
            windowB: { minSec: number; maxSec: number };
            windowC: { minSec: number; maxSec: number };
            accelEnabled: boolean;
            multiplierA: number;
            multiplierB: number;
            multiplierC: number;
            trendEnabled: boolean;
            trendMinutesA: number;
            trendMinutesB: number;
            trendMinutesC: number;
            maxTotalStakeUsdPerPosition: number;
            minAttemptIntervalMs: number;
        };
        stoploss: {
            enabled: boolean;
            cut1DropCents: number;
            cut1SellPct: number;
            cut2DropCents: number;
            cut2SellPct: number;
            spreadGuardCents: number;
            minSecToExit: number;
        };
        dojiGuardEnabled: boolean;
        riskSkipScore: number;
        splitBuyEnabled: boolean;
        splitBuyPct3m: number;
        splitBuyPct2m: number;
        splitBuyPct1m: number;
        splitBuyTrendEnabled: boolean;
        splitBuyTrendMinutes3m: number;
        splitBuyTrendMinutes2m: number;
        splitBuyTrendMinutes1m: number;
        stoplossEnabled: boolean;
        stoplossCut1DropCents: number;
        stoplossCut1SellPct: number;
        stoplossCut2DropCents: number;
        stoplossCut2SellPct: number;
        stoplossMinSecToExit: number;
        adaptiveDeltaEnabled: boolean;
        adaptiveDeltaBigMoveMultiplier: number;
        adaptiveDeltaRevertNoBuyCount: number;
    } = {
        pollMs: 2_000,
        expiresWithinSec: 180,
        expiresWithinSecByTimeframe: { '5m': 180, '15m': 180, '1h': 180, '4h': 180, '1d': 180 },
        minProb: 0.9,
        amountUsd: 1,
        symbols: ['BTC', 'ETH', 'SOL', 'XRP'],
        timeframes: ['15m'],
        dojiGuard: { enabled: true, riskSkipScore: 70, riskAddOnBlockScore: 50 },
        addOn: {
            enabled: false,
            windowA: { minSec: 121, maxSec: 180 },
            windowB: { minSec: 61, maxSec: 120 },
            windowC: { minSec: 1, maxSec: 60 },
            accelEnabled: true,
            multiplierA: 1.0,
            multiplierB: 1.3,
            multiplierC: 1.7,
            trendEnabled: true,
            trendMinutesA: 3,
            trendMinutesB: 2,
            trendMinutesC: 1,
            maxTotalStakeUsdPerPosition: 50,
            minAttemptIntervalMs: 1200,
        },
        stoploss: {
            enabled: false,
            cut1DropCents: 1,
            cut1SellPct: 50,
            cut2DropCents: 2,
            cut2SellPct: 100,
            spreadGuardCents: 2,
            minSecToExit: 25,
        },
        dojiGuardEnabled: true,
        riskSkipScore: 70,
        splitBuyEnabled: false,
        splitBuyPct3m: 34,
        splitBuyPct2m: 33,
        splitBuyPct1m: 33,
        splitBuyTrendEnabled: true,
        splitBuyTrendMinutes3m: 3,
        splitBuyTrendMinutes2m: 2,
        splitBuyTrendMinutes1m: 1,
        stoplossEnabled: false,
        stoplossCut1DropCents: 1,
        stoplossCut1SellPct: 50,
        stoplossCut2DropCents: 2,
        stoplossCut2SellPct: 100,
        stoplossMinSecToExit: 25,
        adaptiveDeltaEnabled: true,
        adaptiveDeltaBigMoveMultiplier: 2,
        adaptiveDeltaRevertNoBuyCount: 4,
    };
    private cryptoAllLastScanAt: string | null = null;
    private cryptoAllNextScanAllowedAtMs = 0;
    private cryptoAllLastError: string | null = null;
    private cryptoAllOrderLocks: Map<string, { atMs: number; symbol?: string; key?: string; expiresAtMs: number; conditionId: string; status: 'placing' | 'ordered' | 'failed' }> = new Map();
    private cryptoAllDeltaThresholdsPath: string | null = null;
    private cryptoAllDeltaThresholds: {
        legacy: { btcMinDelta: number; ethMinDelta: number; solMinDelta: number; xrpMinDelta: number };
        byTimeframe: Record<'5m' | '15m' | '1h' | '4h' | '1d', { btcMinDelta: number; ethMinDelta: number; solMinDelta: number; xrpMinDelta: number }>;
        updatedAt: string | null;
        loadedAt: string | null;
        persistLastError: string | null;
    } = {
        legacy: { btcMinDelta: 600, ethMinDelta: 30, solMinDelta: 0.8, xrpMinDelta: 0.0065 },
        byTimeframe: {
            '5m': { btcMinDelta: 600, ethMinDelta: 30, solMinDelta: 0.8, xrpMinDelta: 0.0065 },
            '15m': { btcMinDelta: 600, ethMinDelta: 30, solMinDelta: 0.8, xrpMinDelta: 0.0065 },
            '1h': { btcMinDelta: 600, ethMinDelta: 30, solMinDelta: 0.8, xrpMinDelta: 0.0065 },
            '4h': { btcMinDelta: 600, ethMinDelta: 30, solMinDelta: 0.8, xrpMinDelta: 0.0065 },
            '1d': { btcMinDelta: 600, ethMinDelta: 30, solMinDelta: 0.8, xrpMinDelta: 0.0065 },
        },
        updatedAt: null,
        loadedAt: null,
        persistLastError: null,
    };
    private cryptoAllWatchdogTimer: any = null;
    private cryptoAllWatchdog: {
        running: boolean;
        pollMs: number;
        startedAtMs: number;
        endsAtMs: number;
        lastTickAtMs: number;
        lastError: string | null;
        stopReason: string | null;
        thresholds: {
            consecutiveDataStops: number;
            deltaErrorRateThreshold: number;
            redeemSubmittedTimeoutMs: number;
            redeemFailedStops: number;
            orderFailedStops: number;
        };
        counters: {
            consecutiveDataError: number;
            redeemFailed: number;
            orderFailed: number;
        };
        issues: Array<{ at: string; type: string; message: string; meta?: any }>;
        reportPaths: { json?: string; md?: string };
    } = {
        running: false,
        pollMs: 30_000,
        startedAtMs: 0,
        endsAtMs: 0,
        lastTickAtMs: 0,
        lastError: null,
        stopReason: null,
        thresholds: {
            consecutiveDataStops: 5,
            deltaErrorRateThreshold: 0.7,
            redeemSubmittedTimeoutMs: 20 * 60_000,
            redeemFailedStops: 1,
            orderFailedStops: 2,
        },
        counters: {
            consecutiveDataError: 0,
            redeemFailed: 0,
            orderFailed: 0,
        },
        issues: [],
        reportPaths: {},
    };
    private cryptoAllActivesByKey: Map<string, any> = new Map();
    private cryptoAllTrackedByCondition: Map<string, any> = new Map();
    private cryptoAllAddOnState: Map<string, { positionKey: string; conditionId: string; tokenId: string; direction: 'Up' | 'Down'; outcomeIndex: number; symbol: string; timeframe: '5m' | '15m' | '1h' | '4h' | '1d'; endMs: number; placedA: boolean; placedB: boolean; placedC: boolean; totalStakeUsd: number; lastAttemptAtMs: number }> = new Map();
    private cryptoAllStoplossState: Map<string, {
        positionKey: string;
        strategy: 'crypto15m' | 'cryptoall2' | 'cryptoall';
        conditionId: string;
        tokenId: string;
        symbol: string;
        timeframe: '5m' | '15m' | '1h' | '4h' | '1d';
        endMs: number;
        entryPrice: number;
        totalSize: number;
        soldSize: number;
        soldCut1: boolean;
        soldCut2: boolean;
        lastAttemptAtMs: number;
        lastCancelAtMs: number;
        openOrderIds: string[];
        openOrderPlacedAtMs: number;
        lastBestBid: number;
        stoploss: { cut1DropCents: number; cut1SellPct: number; cut2DropCents: number; cut2SellPct: number; minSecToExit: number };
    }> = new Map();
    private cryptoAllBeatCache: Map<string, { atMs: number; priceToBeat: number | null; currentPrice: number | null; deltaAbs: number | null; error: string | null }> = new Map();
    private cryptoAllBinanceCandleCache: Map<string, { atMs: number; startMs: number; open: number | null; high: number | null; low: number | null; close: number | null; closes1m: number[]; error: string | null }> = new Map();
    private cryptoAllBinanceSpotCache: Map<string, { atMs: number; price: number | null; error: string | null }> = new Map();
    private get cryptoAllMarketSnapshot() { return this.sharedMarketData.cryptoAllMarketSnapshot; }
    private set cryptoAllMarketSnapshot(v) { this.sharedMarketData.cryptoAllMarketSnapshot = v; }
    private get cryptoAllBooksSnapshot() { return this.sharedMarketData.cryptoAllBooksSnapshot; }
    private set cryptoAllBooksSnapshot(v) { this.sharedMarketData.cryptoAllBooksSnapshot = v; }
    private get cryptoAllMarketInFlight() { return this.sharedMarketData.cryptoAllMarketInFlight; }
    private set cryptoAllMarketInFlight(v) { this.sharedMarketData.cryptoAllMarketInFlight = v; }
    private get cryptoAllBooksInFlight() { return this.sharedMarketData.cryptoAllBooksInFlight; }
    private set cryptoAllBooksInFlight(v) { this.sharedMarketData.cryptoAllBooksInFlight = v; }
    private get cryptoAllMarketBackoffMs() { return this.sharedMarketData.cryptoAllMarketBackoffMs; }
    private set cryptoAllMarketBackoffMs(v) { this.sharedMarketData.cryptoAllMarketBackoffMs = v; }
    private get cryptoAllMarketNextAllowedAtMs() { return this.sharedMarketData.cryptoAllMarketNextAllowedAtMs; }
    private set cryptoAllMarketNextAllowedAtMs(v) { this.sharedMarketData.cryptoAllMarketNextAllowedAtMs = v; }
    private get cryptoAllBooksBackoffMs() { return this.sharedMarketData.cryptoAllBooksBackoffMs; }
    private set cryptoAllBooksBackoffMs(v) { this.sharedMarketData.cryptoAllBooksBackoffMs = v; }
    private get cryptoAllBooksNextAllowedAtMs() { return this.sharedMarketData.cryptoAllBooksNextAllowedAtMs; }
    private set cryptoAllBooksNextAllowedAtMs(v) { this.sharedMarketData.cryptoAllBooksNextAllowedAtMs = v; }
    private cryptoAllWsClients: Map<any, { symbols: string[]; timeframes: Array<'5m' | '15m' | '1h' | '4h' | '1d'>; minProb: number; expiresWithinSec: number; expiresWithinSecByTimeframe?: Record<'5m' | '15m' | '1h' | '4h' | '1d', number>; limit: number; includeCandidates: boolean }> = new Map();
    private cryptoAllWsTimer: any = null;
    private cryptoAllSnapshotTimer: any = null;
    private deltaBoxTimer: any = null;
    private deltaBoxBinanceHist: Map<string, Array<{ endMs: number; open: number; close: number; deltaAbs: number }>> = new Map();
    private deltaBoxPmHist: Map<string, Array<{ endMs: number; lastOffsetsSec: Array<number | null>; lastDeltaAtOffsets: Array<number | null> }>> = new Map();
    private deltaBoxPmMarkets: Map<string, { key: string; symbol: string; timeframe: '5m' | '15m' | '1h' | '4h' | '1d'; endMs: number; startMs: number; upTokenId: string; downTokenId: string; lastHasRange: boolean; events: Array<{ atMs: number; deltaAbs: number | null }> }> = new Map();
    private deltaBoxBinanceMeta: Map<string, { lastEndMs: number; nextAllowedAtMs: number }> = new Map();
    private deltaBoxPmNextSampleAtMs = 0;
    private deltaBoxPmNextMarketRefreshAtMs = 0;
    private deltaBoxWantedSymbols: Array<'BTC' | 'ETH' | 'SOL' | 'XRP'> = ['BTC', 'ETH', 'SOL', 'XRP'];
    private deltaBoxWantedTimeframes: Array<'5m' | '15m' | '1h' | '4h' | '1d'> = ['5m', '15m', '1h', '4h', '1d'];
    private globalOrderLocks: Map<string, { atMs: number; strategy: 'crypto15m' | 'cryptoall' | 'other'; status: 'placing' | 'done' | 'failed'; expiresAtMs: number }> = new Map();
    private globalOrderPlaceInFlight = false;
    private redeemDrainRunning = false;
    private redeemDrainLast: any = null;
    private redeemInFlight: Map<string, { conditionId: string; submittedAt: string; method: string; txHash?: string; transactionId?: string; status: 'submitted' | 'confirmed' | 'failed'; error?: string; txStatus?: number | null; payoutUsdc?: number; payoutReceivedUsdc?: number; payoutSentUsdc?: number; payoutNetUsdc?: number; payoutRecipients?: string[]; paid?: boolean; payoutComputedAt?: string; usdcTransfers?: Array<{ token: string; from: string; to: string; amount: number }> }> = new Map();
    private relayerUrl: string = 'https://relayer-v2.polymarket.com';
    private relayerConfigPath: string = '';
    private relayerConfigLoadedAt: string | null = null;
    private relayerConfigPersistedAt: string | null = null;
    private relayerConfigPersistLastError: string | null = null;
    private relayerLastInitError: string | null = null;
    private relayerKeys: Array<{ apiKey: string; secret: string; passphrase: string; label?: string; exhaustedUntil?: string | null; lastError?: string | null; lastUsedAt?: string | null }> = [];
    private relayerActiveIndex = 0;
    private relayerWalletClient: any = null;
    private relayerSafeDeployed = false;
    private rpcUrls: string[] = [];
    private rpcIndex = 0;
    private isRunning = false;
    private hasValidKey = false;
    private rpcPrivateKey: string = '';
    private accountId: string = 'default';

    constructor(arg?: string | { privateKey?: string; proxyAddress?: string; accountId?: string }) {
        const opts: { privateKey?: string; proxyAddress?: string; accountId?: string } =
            (arg != null && typeof arg === 'object') ? (arg as any) : ({ privateKey: arg as any } as any);
        const privateKey = opts.privateKey;
        this.accountId = opts.accountId != null ? String(opts.accountId).trim() || 'default' : 'default';
        const legacyMode = !(arg != null && typeof arg === 'object');
        const stateDirEnv = process.env.POLY_STATE_DIR != null ? String(process.env.POLY_STATE_DIR).trim() : '';
        const stateDirBaseRaw = stateDirEnv || path.join(os.tmpdir(), 'polymarket-tools');
        const stateDirBase = path.isAbsolute(stateDirBaseRaw) ? stateDirBaseRaw : path.resolve(process.cwd(), stateDirBaseRaw);
        const baseDir = legacyMode ? stateDirBase : path.join(stateDirBase, 'accounts', this.accountId);
        try { fs.mkdirSync(baseDir, { recursive: true }); } catch {}
        const maybeMigrateLegacyFile = (filename: string, destPath: string) => {
            if (legacyMode) return;
            if (this.accountId !== 'default') return;
            const srcPath = path.join(stateDirBase, filename);
            try {
                if (fs.existsSync(destPath)) return;
                if (!fs.existsSync(srcPath)) return;
                fs.mkdirSync(path.dirname(destPath), { recursive: true });
                fs.copyFileSync(srcPath, destPath);
                try { fs.chmodSync(destPath, 0o600); } catch {}
            } catch {
            }
        };
        const resolvePath = (envValue: any, filename: string): string => {
            const v = envValue != null ? String(envValue).trim() : '';
            if (v) {
                if (!legacyMode) {
                    if (v.includes('{accountId}')) return v.split('{accountId}').join(this.accountId);
                    if (v.includes('{id}')) return v.split('{id}').join(this.accountId);
                    return path.join(baseDir, filename);
                }
                return v;
            }
            return path.join(baseDir, filename);
        };
        this.sdk = new PolymarketSDK({
            privateKey,
        } as any);

        this.hasValidKey = !!privateKey && privateKey.length > 50; // Simple check
        const effectiveKey = this.hasValidKey ? privateKey! : '0x0000000000000000000000000000000000000000000000000000000000000001';
        this.rpcPrivateKey = effectiveKey;

        // Initialize Trading Client manually since SDK doesn't expose it publically
        const rateLimiter = new RateLimiter(); 
        
        const proxyAddress = opts.proxyAddress != null ? String(opts.proxyAddress).trim() : process.env.POLY_PROXY_ADDRESS;

        this.tradingClient = new TradingClient(rateLimiter, {
            privateKey: effectiveKey,
            chainId: 137,
            proxyAddress: proxyAddress
        });

        if (this.hasValidKey) {
            this.relayerConfigPath = resolvePath(process.env.POLY_RELAYER_CONFIG_PATH, 'relayer.json');
            this.autoRedeemConfigPath = resolvePath(process.env.POLY_AUTO_REDEEM_CONFIG_PATH, 'auto-redeem.json');
            this.orderHistoryPath = resolvePath(process.env.POLY_ORDER_HISTORY_PATH, 'history.json');
            this.crypto15mDeltaThresholdsPath = resolvePath(process.env.POLY_CRYPTO15M_DELTA_THRESHOLDS_PATH, 'crypto15m-delta-thresholds.json');
            this.crypto15mAutoConfigPath = resolvePath(process.env.POLY_CRYPTO15M_CONFIG_PATH, 'crypto15m-config.json');
            this.crypto15mHedgeConfigPath = resolvePath(process.env.POLY_CRYPTO15M_HEDGE_CONFIG_PATH, 'crypto15m-hedge.json');
            this.cryptoAll2DeltaThresholdsPath = resolvePath(process.env.POLY_CRYPTOALL2_DELTA_THRESHOLDS_PATH, 'cryptoall2-delta-thresholds.json');
            this.cryptoAll2AutoConfigPath = resolvePath(process.env.POLY_CRYPTOALL2_CONFIG_PATH, 'crypto_all_2.json');
            this.cryptoAllAutoConfigPath = resolvePath(process.env.POLY_CRYPTOALL_CONFIG_PATH, 'crypto_all_v2.json');
            this.cryptoAllDeltaThresholdsPath = resolvePath(process.env.POLY_CRYPTOALL_DELTA_THRESHOLDS_PATH, 'cryptoall-delta-thresholds.json');

            maybeMigrateLegacyFile('relayer.json', this.relayerConfigPath);
            maybeMigrateLegacyFile('auto-redeem.json', this.autoRedeemConfigPath);
            maybeMigrateLegacyFile('history.json', this.orderHistoryPath);
            maybeMigrateLegacyFile('crypto15m-delta-thresholds.json', this.crypto15mDeltaThresholdsPath);
            maybeMigrateLegacyFile('crypto15m-config.json', this.crypto15mAutoConfigPath);
            maybeMigrateLegacyFile('crypto15m-hedge.json', this.crypto15mHedgeConfigPath);
            maybeMigrateLegacyFile('cryptoall2-delta-thresholds.json', this.cryptoAll2DeltaThresholdsPath);
            maybeMigrateLegacyFile('crypto_all_2.json', this.cryptoAll2AutoConfigPath);
            maybeMigrateLegacyFile('crypto_all_v2.json', this.cryptoAllAutoConfigPath);
            maybeMigrateLegacyFile('cryptoall-delta-thresholds.json', this.cryptoAllDeltaThresholdsPath);
            const envList = process.env.POLY_RPC_URLS || process.env.POLY_CTF_RPC_URLS || process.env.POLY_RPC_FALLBACK_URLS;
            const urls = (envList ? String(envList).split(',') : [
                process.env.POLY_CTF_RPC_URL,
                process.env.POLY_RPC_URL,
                'https://polygon-bor.publicnode.com',
                'https://polygon-rpc.com',
            ])
                .filter(Boolean)
                .map((s) => String(s).trim())
                .filter((s) => s.startsWith('http'));
            this.rpcUrls = urls.length ? urls : ['https://polygon-rpc.com'];
            this.rpcIndex = 0;
            const rpcUrl = this.rpcUrls[this.rpcIndex];
            this.ctf = new CTFClient({ privateKey: effectiveKey, rpcUrl, chainId: 137 });
            this.redeemProvider = this.createRpcProvider(rpcUrl);
            this.redeemWallet = new ethers.Wallet(effectiveKey, this.redeemProvider);

            const account = privateKeyToAccount(effectiveKey as Hex);
            this.relayerWalletClient = createWalletClient({
                account,
                chain: polygon,
                transport: http(rpcUrl),
            });
            this.loadRelayerConfigFromFile();
            this.configureRelayerFromEnv();
            this.loadAutoRedeemConfigFromFile();
            this.loadOrderHistoryFromFile();
            this.loadCrypto15mDeltaThresholdsFromFile();
            this.loadCryptoAll2DeltaThresholdsFromFile();
            this.loadCryptoAllDeltaThresholdsFromFile();
            this.loadCrypto15mAutoConfigFromFile();
            this.loadCrypto15mHedgeConfigFromFile();
            this.loadCryptoAll2AutoConfigFromFile();
            this.loadCryptoAllAutoConfigFromFile();
        }

        this.pnlPersistencePath = process.env.POLY_PNL_SNAPSHOT_PATH
            ? resolvePath(process.env.POLY_PNL_SNAPSHOT_PATH, 'pnl-snapshots.json')
            : path.join(baseDir, 'pnl-snapshots.json');
        maybeMigrateLegacyFile('pnl-snapshots.json', this.pnlPersistencePath);
        
        this.startTradingInitRetry();
        
        // Start monitoring loop for cut-loss/trailing stop
        this.startMonitoring();

        if (this.hasValidKey) {
            this.loadPnlSnapshots().finally(() => this.startPnlSnapshots());
        }
    }

    private cleanupGlobalOrderLocks() {
        const now = Date.now();
        for (const [k, v] of this.globalOrderLocks.entries()) {
            if (!v) { this.globalOrderLocks.delete(k); continue; }
            if (v.expiresAtMs != null && Number.isFinite(Number(v.expiresAtMs)) && now > Number(v.expiresAtMs)) {
                this.globalOrderLocks.delete(k);
            }
        }
    }

    private tryAcquireGlobalOrderLock(key: string, strategy: 'crypto15m' | 'cryptoall' | 'other') {
        this.cleanupGlobalOrderLocks();
        const k = String(key || '').trim().toLowerCase();
        if (!k) return false;
        const now = Date.now();
        const existing = this.globalOrderLocks.get(k);
        if (existing && now < Number(existing.expiresAtMs || 0)) return false;
        this.globalOrderLocks.set(k, { atMs: now, strategy, status: 'placing', expiresAtMs: now + 10 * 60_000 });
        return true;
    }

    private markGlobalOrderLockDone(key: string, ok: boolean) {
        const k = String(key || '').trim().toLowerCase();
        if (!k) return;
        const v = this.globalOrderLocks.get(k);
        if (!v) return;
        const now = Date.now();
        this.globalOrderLocks.set(k, { ...v, status: ok ? 'done' : 'failed', expiresAtMs: now + 10 * 60_000 });
    }

    private configureRelayerFromEnv() {
        const builderKey = process.env.POLY_BUILDER_API_KEY || process.env.BUILDER_API_KEY;
        const builderSecret = process.env.POLY_BUILDER_SECRET || process.env.BUILDER_SECRET;
        const builderPassphrase = process.env.POLY_BUILDER_PASSPHRASE || process.env.BUILDER_PASS_PHRASE || process.env.BUILDER_PASSPHRASE;
        const relayerUrl = process.env.POLY_RELAYER_URL || process.env.POLYMARKET_RELAYER_URL || 'https://relayer-v2.polymarket.com';
        if (!builderKey || !builderSecret || !builderPassphrase) return;
        this.configureRelayer({ apiKey: String(builderKey), secret: String(builderSecret), passphrase: String(builderPassphrase), relayerUrl: String(relayerUrl), persist: true });
    }

    private loadRelayerConfigFromFile() {
        if (!this.relayerConfigPath) return;
        try {
            if (!fs.existsSync(this.relayerConfigPath)) return;
            const raw = fs.readFileSync(this.relayerConfigPath, 'utf8');
            const parsed = JSON.parse(String(raw || '{}'));
            const relayerUrl = parsed?.relayerUrl != null ? String(parsed.relayerUrl) : undefined;
            this.relayerConfigLoadedAt = new Date().toISOString();
            if (Array.isArray(parsed?.keys)) {
                const keys = parsed.keys
                    .map((k: any) => ({
                        apiKey: String(k?.apiKey || k?.key || '').trim(),
                        secret: String(k?.secret || '').trim(),
                        passphrase: String(k?.passphrase || '').trim(),
                        label: k?.label != null ? String(k.label) : undefined,
                        exhaustedUntil: k?.exhaustedUntil != null ? String(k.exhaustedUntil) : null,
                        lastError: k?.lastError != null ? String(k.lastError) : null,
                        lastUsedAt: k?.lastUsedAt != null ? String(k.lastUsedAt) : null,
                    }))
                    .filter((k: any) => !!k.apiKey && !!k.secret && !!k.passphrase);
                const activeIndex = Number.isFinite(Number(parsed?.activeIndex)) ? Math.max(0, Math.floor(Number(parsed.activeIndex))) : 0;
                if (!keys.length) return;
                this.setRelayerKeys({ keys, relayerUrl, activeIndex, persist: false, reconfigure: true });
                return;
            }

            const apiKey = String(parsed?.apiKey || '').trim();
            const secret = String(parsed?.secret || '').trim();
            const passphrase = String(parsed?.passphrase || '').trim();
            if (!apiKey || !secret || !passphrase) return;
            this.setRelayerKeys({ keys: [{ apiKey, secret, passphrase }], relayerUrl, activeIndex: 0, persist: false, reconfigure: true });
        } catch {
        }
    }

    private persistRelayerConfigToFile(options: { relayerUrl: string; keys: Array<{ apiKey: string; secret: string; passphrase: string; label?: string; exhaustedUntil?: string | null; lastError?: string | null; lastUsedAt?: string | null }>; activeIndex: number }) {
        if (!this.relayerConfigPath) return;
        const writeAtomic = (targetPath: string, payload: string) => {
            const dir = path.dirname(targetPath);
            fs.mkdirSync(dir, { recursive: true });
            const bakPath = `${targetPath}.bak`;
            const tmpPath = `${targetPath}.tmp`;
            try {
                if (fs.existsSync(targetPath)) {
                    fs.copyFileSync(targetPath, bakPath);
                    try { fs.chmodSync(bakPath, 0o600); } catch {}
                }
            } catch {
            }
            fs.writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
            try { fs.chmodSync(tmpPath, 0o600); } catch {}
            fs.renameSync(tmpPath, targetPath);
            try { fs.chmodSync(targetPath, 0o600); } catch {}
        };

        try {
            const payload = JSON.stringify(options);
            writeAtomic(this.relayerConfigPath, payload);
            try {
                const stablePath = path.join(os.homedir(), '.polymarket-tools', 'relayer.json');
                writeAtomic(stablePath, payload);
            } catch {
            }
            this.relayerConfigPersistedAt = new Date().toISOString();
            this.relayerConfigPersistLastError = null;
        } catch (e: any) {
            this.relayerConfigPersistLastError = e?.message ? String(e.message) : 'Failed to write relayer config file';
        }
    }

    private isRelayerKeyExhausted(k: { exhaustedUntil?: string | null }): boolean {
        const until = k?.exhaustedUntil ? Date.parse(String(k.exhaustedUntil)) : NaN;
        return Number.isFinite(until) ? until > Date.now() : false;
    }

    private parseRelayerQuotaResetAt(err: any): string | null {
        const msg = String(err?.message || err || '');
        const m = msg.match(/resets\s+in\s+(\d+)\s+seconds/i);
        if (!m) return null;
        const seconds = Number(m[1]);
        if (!Number.isFinite(seconds) || seconds <= 0) return null;
        return new Date(Date.now() + seconds * 1000).toISOString();
    }

    private isRelayerQuotaExceeded(err: any): boolean {
        const msg = String(err?.message || err || '').toLowerCase();
        return msg.includes('quota exceeded') || msg.includes('units remaining');
    }

    private maskApiKey(apiKey: string): string {
        const k = String(apiKey || '');
        if (k.length <= 8) return k;
        return `${k.slice(0, 4)}…${k.slice(-4)}`;
    }

    private persistRelayerKeysSnapshot() {
        if (!this.relayerConfigPath) return;
        this.persistRelayerConfigToFile({ relayerUrl: this.relayerUrl, keys: this.relayerKeys, activeIndex: this.relayerActiveIndex });
    }

    private rotateRelayerKeyOnQuotaExceeded(err: any): boolean {
        if (!this.relayerKeys.length) return false;
        const cur = this.relayerKeys[this.relayerActiveIndex];
        const resetAt = this.parseRelayerQuotaResetAt(err);
        if (cur) {
            cur.exhaustedUntil = resetAt || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
            cur.lastError = String(err?.message || err || '');
        }
        this.persistRelayerKeysSnapshot();

        if (this.relayerKeys.length <= 1) {
            this.relayerConfigured = false;
            this.relayerLastInitError = 'Builder quota exceeded';
            return false;
        }

        const startIndex = this.relayerActiveIndex;
        for (let step = 1; step <= this.relayerKeys.length; step++) {
            const idx = (startIndex + step) % this.relayerKeys.length;
            const k = this.relayerKeys[idx];
            if (!k || this.isRelayerKeyExhausted(k)) continue;
            this.relayerActiveIndex = idx;
            const configured = this.configureRelayerFromActiveKey({ persist: true });
            if (configured?.success) return true;
        }

        this.relayerConfigured = false;
        this.relayerLastInitError = 'Builder quota exceeded';
        return false;
    }

    rotateRelayerKeyOnAuthError(err: any): boolean {
        if (!this.relayerKeys.length) return false;
        const cur = this.relayerKeys[this.relayerActiveIndex];
        if (cur) {
            cur.exhaustedUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
            cur.lastError = String(err?.message || err || '');
        }
        this.persistRelayerKeysSnapshot();

        if (this.relayerKeys.length <= 1) {
            this.relayerConfigured = false;
            this.relayerLastInitError = 'Builder authorization failed';
            return false;
        }

        const startIndex = this.relayerActiveIndex;
        for (let step = 1; step <= this.relayerKeys.length; step++) {
            const idx = (startIndex + step) % this.relayerKeys.length;
            const k = this.relayerKeys[idx];
            if (!k || this.isRelayerKeyExhausted(k)) continue;
            this.relayerActiveIndex = idx;
            const configured = this.configureRelayerFromActiveKey({ persist: true });
            if (configured?.success) return true;
        }

        this.relayerConfigured = false;
        this.relayerLastInitError = 'Builder authorization failed';
        return false;
    }

    async getRelayerDiag() {
        const stablePath = path.join(os.homedir(), '.polymarket-tools', 'relayer.json');
        const tmpPath = path.join(os.tmpdir(), 'polymarket-tools', 'relayer.json');
        const candidates = Array.from(new Set([
            this.relayerConfigPath,
            this.relayerConfigPath ? `${this.relayerConfigPath}.bak` : '',
            stablePath,
            `${stablePath}.bak`,
            tmpPath,
            `${tmpPath}.bak`,
        ].map((p) => String(p || '').trim()).filter((p) => p)));

        const readOne = async (p: string) => {
            try {
                const st = await fs.promises.stat(p);
                const raw = await fs.promises.readFile(p, 'utf8');
                let parsed: any = null;
                let parseError: string | null = null;
                try {
                    parsed = JSON.parse(String(raw || '{}'));
                } catch (e: any) {
                    parseError = e?.message || String(e);
                }
                const relayerUrl = parsed?.relayerUrl != null ? String(parsed.relayerUrl) : null;
                const keysArr = Array.isArray(parsed?.keys) ? parsed.keys : null;
                const keyCount = keysArr
                    ? keysArr.filter((k: any) => k && (k.apiKey || k.key) && k.secret && k.passphrase).length
                    : (parsed?.apiKey && parsed?.secret && parsed?.passphrase ? 1 : 0);
                const apiKeysMasked = keysArr
                    ? keysArr.map((k: any) => this.maskApiKey(String(k?.apiKey || k?.key || ''))).filter((x: string) => x && x.length > 0).slice(0, 8)
                    : (parsed?.apiKey ? [this.maskApiKey(String(parsed.apiKey))] : []);
                return {
                    path: p,
                    exists: true,
                    size: st.size,
                    mtime: st.mtime.toISOString(),
                    relayerUrl,
                    keyCount,
                    apiKeysMasked,
                    parseError,
                };
            } catch (e: any) {
                const msg = e?.code === 'ENOENT' ? null : (e?.message || String(e));
                return { path: p, exists: false, size: null, mtime: null, relayerUrl: null, keyCount: 0, apiKeysMasked: [], parseError: msg };
            }
        };

        const sources = await Promise.all(candidates.map((p) => readOne(p)));
        return {
            status: this.getRelayerStatus(),
            sources,
        };
    }

    private ensureRelayerReadyForRedeem(): boolean {
        if (this.relayerConfigured && (this.relayerSafe || this.relayerProxy)) return true;
        if (!this.relayerKeys.length) return false;
        for (let step = 0; step <= this.relayerKeys.length; step++) {
            const idx = (this.relayerActiveIndex + step) % this.relayerKeys.length;
            const k = this.relayerKeys[idx];
            if (!k || this.isRelayerKeyExhausted(k)) continue;
            this.relayerActiveIndex = idx;
            const configured = this.configureRelayerFromActiveKey({ persist: false });
            if (configured?.success) return true;
        }
        return false;
    }

    private setRelayerKeys(options: { keys: Array<{ apiKey: string; secret: string; passphrase: string; label?: string; exhaustedUntil?: string | null; lastError?: string | null; lastUsedAt?: string | null }>; relayerUrl?: string; activeIndex?: number; persist?: boolean; reconfigure?: boolean }) {
        const keys = (options.keys || [])
            .map((k) => ({
                apiKey: String(k.apiKey || '').trim(),
                secret: String(k.secret || '').trim(),
                passphrase: String(k.passphrase || '').trim(),
                label: k.label != null ? String(k.label) : undefined,
                exhaustedUntil: k.exhaustedUntil != null ? String(k.exhaustedUntil) : null,
                lastError: k.lastError != null ? String(k.lastError) : null,
                lastUsedAt: k.lastUsedAt != null ? String(k.lastUsedAt) : null,
            }))
            .filter((k) => !!k.apiKey && !!k.secret && !!k.passphrase);
        if (!keys.length) {
            this.relayerConfigured = false;
            this.relayerLastInitError = 'Missing builder credentials';
            this.relayerKeys = [];
            this.relayerActiveIndex = 0;
            return { success: false, relayerConfigured: false, error: this.relayerLastInitError };
        }
        const relayerUrl = String(options.relayerUrl || this.relayerUrl || 'https://relayer-v2.polymarket.com').trim();
        const requestedIndex = options.activeIndex != null ? Math.max(0, Math.floor(Number(options.activeIndex))) : this.relayerActiveIndex;
        this.relayerKeys = keys;
        this.relayerActiveIndex = Math.min(requestedIndex, Math.max(0, keys.length - 1));
        this.relayerUrl = relayerUrl;
        if (options.persist !== false) {
            this.persistRelayerConfigToFile({ relayerUrl, keys: this.relayerKeys, activeIndex: this.relayerActiveIndex });
        }
        if (options.reconfigure) {
            return this.configureRelayerFromActiveKey({ persist: false });
        }
        return { success: true, relayerConfigured: this.relayerConfigured };
    }

    configureRelayerKeys(options: { keys: Array<{ apiKey: string; secret: string; passphrase: string; label?: string }>; relayerUrl?: string; activeIndex?: number; persist?: boolean }) {
        return this.setRelayerKeys({ keys: options.keys, relayerUrl: options.relayerUrl, activeIndex: options.activeIndex, persist: options.persist, reconfigure: true });
    }

    setActiveRelayerKeyIndex(index: number, options?: { persist?: boolean }) {
        if (!this.relayerKeys.length) {
            this.relayerConfigured = false;
            this.relayerLastInitError = 'Missing builder credentials';
            return { success: false, relayerConfigured: false, error: this.relayerLastInitError };
        }
        const idx = Math.max(0, Math.floor(Number(index)));
        this.relayerActiveIndex = Math.min(idx, Math.max(0, this.relayerKeys.length - 1));
        const configured = this.configureRelayerFromActiveKey({ persist: false });
        if (options?.persist !== false) this.persistRelayerKeysSnapshot();
        return configured;
    }

    private configureRelayerFromActiveKey(options?: { persist?: boolean }) {
        const key = this.relayerKeys[this.relayerActiveIndex];
        if (!key) {
            this.relayerConfigured = false;
            this.relayerLastInitError = 'Missing builder credentials';
            return { success: false, relayerConfigured: false, error: this.relayerLastInitError };
        }
        if (this.isRelayerKeyExhausted(key)) {
            this.relayerConfigured = false;
            this.relayerLastInitError = 'Builder quota exceeded';
            return { success: false, relayerConfigured: false, error: this.relayerLastInitError };
        }
        return this.configureRelayer({ apiKey: key.apiKey, secret: key.secret, passphrase: key.passphrase, relayerUrl: this.relayerUrl, persist: options?.persist });
    }

    configureRelayer(options: { apiKey: string; secret: string; passphrase: string; relayerUrl?: string; persist?: boolean }) {
        if (!this.hasValidKey || !this.relayerWalletClient) {
            this.relayerConfigured = false;
            this.relayerLastInitError = 'Missing trading private key';
            return { success: false, relayerConfigured: false, error: this.relayerLastInitError };
        }
        const apiKey = String(options.apiKey || '').trim();
        const secret = String(options.secret || '').trim();
        const passphrase = String(options.passphrase || '').trim();
        const relayerUrl = String(options.relayerUrl || this.relayerUrl || 'https://relayer-v2.polymarket.com').trim();

        if (!apiKey || !secret || !passphrase) {
            this.relayerConfigured = false;
            this.relayerLastInitError = 'Missing builder credentials';
            return { success: false, relayerConfigured: false, error: this.relayerLastInitError };
        }

        try {
            const builderConfig = new BuilderConfig({
                localBuilderCreds: { key: apiKey, secret, passphrase },
            } as any);
            this.relayerUrl = relayerUrl;
            this.relayerSafe = new RelayClient(relayerUrl, 137, this.relayerWalletClient as any, builderConfig as any, RelayerTxType.SAFE);
            this.relayerProxy = new RelayClient(relayerUrl, 137, this.relayerWalletClient as any, builderConfig as any, RelayerTxType.PROXY);
            this.relayerConfigured = true;
            this.relayerSafeDeployed = false;
            this.relayerLastInitError = null;
            if (options.persist !== false) {
                if (!this.relayerKeys.length) {
                    this.relayerKeys = [{ apiKey, secret, passphrase }];
                    this.relayerActiveIndex = 0;
                }
                const k = this.relayerKeys[this.relayerActiveIndex];
                if (k) {
                    k.lastError = null;
                    k.lastUsedAt = new Date().toISOString();
                }
                this.persistRelayerConfigToFile({ relayerUrl, keys: this.relayerKeys, activeIndex: this.relayerActiveIndex });
            }
            return { success: true, relayerConfigured: true };
        } catch (e: any) {
            this.relayerConfigured = false;
            this.relayerLastInitError = e?.message || String(e);
            const k = this.relayerKeys[this.relayerActiveIndex];
            if (k) k.lastError = this.relayerLastInitError;
            return { success: false, relayerConfigured: false, error: this.relayerLastInitError };
        }
    }

    getRelayerStatus() {
        const active = this.relayerKeys[this.relayerActiveIndex];
        return {
            relayerConfigured: this.relayerConfigured,
            relayerUrl: this.relayerUrl,
            lastError: this.relayerLastInitError,
            configPath: this.relayerConfigPath || null,
            configFilePresent: this.relayerConfigPath ? fs.existsSync(this.relayerConfigPath) : false,
            configLoadedAt: this.relayerConfigLoadedAt,
            configPersistedAt: this.relayerConfigPersistedAt,
            configPersistLastError: this.relayerConfigPersistLastError,
            activeIndex: this.relayerActiveIndex,
            activeApiKey: active?.apiKey ? this.maskApiKey(active.apiKey) : null,
            keys: this.relayerKeys.map((k, idx) => ({
                index: idx,
                label: k.label || null,
                apiKey: this.maskApiKey(k.apiKey),
                exhaustedUntil: k.exhaustedUntil || null,
                exhausted: this.isRelayerKeyExhausted(k),
                lastError: k.lastError || null,
                lastUsedAt: k.lastUsedAt || null,
            })),
        };
    }

    simulateRelayerQuotaExceeded(options?: { resetsInSeconds?: number }) {
        const seconds = Number(options?.resetsInSeconds ?? 3600);
        const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 3600;
        const err = new Error(`quota exceeded: 0 units remaining, resets in ${safeSeconds} seconds`);
        const rotated = this.rotateRelayerKeyOnQuotaExceeded(err);
        return { rotated, status: this.getRelayerStatus() };
    }

    private async loadPnlSnapshots() {
        try {
            const raw = await fs.promises.readFile(this.pnlPersistencePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                this.pnlSnapshots = parsed
                    .map((p: any) => ({
                        ts: Number(p.ts),
                        equity: Number(p.equity),
                        cash: Number(p.cash),
                        positionsValue: Number(p.positionsValue),
                    }))
                    .filter((p: any) => Number.isFinite(p.ts) && Number.isFinite(p.equity));
            }
        } catch {
        }
    }

    private startPnlSnapshots() {
        if (this.pnlTimer) return;
        const intervalMs = Math.max(60_000, Number(process.env.POLY_PNL_SNAPSHOT_INTERVAL_MS || 300_000));
        this.recordPnlSnapshot().catch(() => null);
        this.pnlTimer = setInterval(() => {
            this.recordPnlSnapshot().catch(() => null);
        }, intervalMs);
    }

    private async recordPnlSnapshot() {
        const funder = this.getFunderAddress();
        const [positionsValue, cash] = await Promise.all([
            this.fetchDataApiPositionsValue(funder),
            this.fetchUsdcBalance(funder),
        ]);
        const equity = Number(positionsValue) + Number(cash);
        const ts = Math.floor(Date.now() / 1000);
        const last = this.pnlSnapshots[this.pnlSnapshots.length - 1];
        if (last && ts - last.ts < 60) return;
        this.pnlSnapshots.push({ ts, equity, cash, positionsValue });
        if (this.pnlSnapshots.length > 20000) this.pnlSnapshots = this.pnlSnapshots.slice(-15000);
        this.schedulePersistPnlSnapshots();
    }

    getPnl(range: '1D' | '1W' | '1M' | 'ALL') {
        const nowSec = Math.floor(Date.now() / 1000);
        const rangeToSec: any = { '1D': 86400, '1W': 604800, '1M': 2592000, 'ALL': Number.POSITIVE_INFINITY };
        const windowSec = rangeToSec[range] ?? 86400;
        const fromSec = windowSec == Number.POSITIVE_INFINITY ? 0 : (nowSec - windowSec);
        const series = this.pnlSnapshots.filter(p => p.ts >= fromSec);
        const first = series[0];
        const last = series[series.length - 1];
        const profitLoss = first && last ? (last.equity - first.equity) : 0;
        const plSeries = series.map(p => ({ ts: p.ts, equity: p.equity, profitLoss: first ? (p.equity - first.equity) : 0 }));
        return { range, fromSec, toSec: nowSec, profitLoss, series: plSeries };
    }

    private schedulePersistPnlSnapshots() {
        if (this.pnlWriteTimer) return;
        this.pnlWriteTimer = setTimeout(() => {
            this.persistPnlSnapshots().finally(() => {
                this.pnlWriteTimer = null;
            });
        }, 2000);
    }

    private async persistPnlSnapshots() {
        try {
            const dir = path.dirname(this.pnlPersistencePath);
            await fs.promises.mkdir(dir, { recursive: true });
            await fs.promises.writeFile(this.pnlPersistencePath, JSON.stringify(this.pnlSnapshots.slice(-15000)), 'utf8');
        } catch {
        }
    }

    private withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
            p.then((v) => {
                clearTimeout(t);
                resolve(v);
            }).catch((e) => {
                clearTimeout(t);
                reject(e);
            });
        });
    }

    private async ensureRelayerSafeDeployed() {
        if (!this.relayerSafe || this.relayerSafeDeployed) return;
        try {
            const resp: any = await this.withTimeout((this.relayerSafe as any).deploy(), 15_000, 'Relayer safe deploy');
            await this.withTimeout(resp.wait(), 60_000, 'Relayer safe deploy wait');
            this.relayerSafeDeployed = true;
        } catch (e: any) {
            const msg = String(e?.message || e || '');
            if (msg.toLowerCase().includes('already deployed') || msg.toLowerCase().includes('already')) {
                this.relayerSafeDeployed = true;
                return;
            }
            this.relayerSafeDeployed = false;
            throw new Error(`Relayer safe deploy failed: ${e?.message || String(e)}`);
        }
    }

    private isRelayerAuthError(e: any): boolean {
        const msg = String(e?.message || e || '');
        return msg.includes('invalid authorization') || msg.includes('"status":401') || msg.includes('status\\\":401') || msg.includes('Unauthorized');
    }

    clearRelayerConfig(options?: { deleteFile?: boolean }) {
        this.relayerConfigured = false;
        this.relayerLastInitError = null;
        this.relayerSafe = undefined;
        this.relayerProxy = undefined;
        this.relayerSafeDeployed = false;
        this.relayerKeys = [];
        this.relayerActiveIndex = 0;
        if (options?.deleteFile && this.relayerConfigPath) {
            try {
                if (fs.existsSync(this.relayerConfigPath)) fs.unlinkSync(this.relayerConfigPath);
            } catch {
            }
        }
    }

    private async redeemViaRelayer(conditionId: string): Promise<{ txHash: string; txType: 'PROXY' | 'SAFE' }> {
        if (!this.relayerConfigured || (!this.relayerSafe && !this.relayerProxy)) {
            throw new Error('Relayer not configured');
        }

        const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
        const USDCe_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
        const parentCollectionId = await this.getRedeemParentCollectionId(conditionId);
        const ctfAbi = parseAbi([
            'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)'
        ]);
        const calldata = encodeFunctionData({
            abi: ctfAbi,
            functionName: 'redeemPositions',
            args: [USDCe_ADDRESS, parentCollectionId as any, conditionId as any, [1n, 2n]],
        });

        const tx = { to: CTF_ADDRESS, data: calldata, value: '0' };
        const shouldTryProxy = this.tradingClient.getFunderAddress().toLowerCase() !== this.tradingClient.getSignerAddress().toLowerCase();

        const tryClient = async (client: RelayClient, txType: 'PROXY' | 'SAFE') => {
            const resp: any = await this.withTimeout((client as any).execute([tx], `redeem ${conditionId}`), 15_000, `Relayer execute (${txType})`);
            const result: any = await this.withTimeout(resp.wait(), 60_000, `Relayer wait (${txType})`);
            const txHash = result?.transactionHash || result?.transaction_hash;
            if (!txHash) throw new Error('Missing transaction hash');
            return { txHash: String(txHash), txType };
        };

        let proxyErr: any = null;
        let safeErr: any = null;

        if (shouldTryProxy && this.relayerProxy) {
            try {
                return await tryClient(this.relayerProxy, 'PROXY');
            } catch (e: any) {
                proxyErr = e;
                if (this.isRelayerQuotaExceeded(e)) {
                    const rotated = this.rotateRelayerKeyOnQuotaExceeded(e);
                    if (rotated) return await this.redeemViaRelayer(conditionId);
                }
                if (this.isRelayerAuthError(e)) {
                    const rotated = this.rotateRelayerKeyOnAuthError(e);
                    if (rotated) return await this.redeemViaRelayer(conditionId);
                    throw new Error(`Relayer proxy auth failed: ${e?.message || String(e)}`);
                }
            }
        }

        if (this.relayerSafe) {
            try {
                await this.ensureRelayerSafeDeployed();
                return await tryClient(this.relayerSafe, 'SAFE');
            } catch (e: any) {
                safeErr = e;
                if (this.isRelayerQuotaExceeded(e)) {
                    const rotated = this.rotateRelayerKeyOnQuotaExceeded(e);
                    if (rotated) return await this.redeemViaRelayer(conditionId);
                }
                if (this.isRelayerAuthError(e)) {
                    const rotated = this.rotateRelayerKeyOnAuthError(e);
                    if (rotated) return await this.redeemViaRelayer(conditionId);
                    throw new Error(`Relayer safe auth failed: ${e?.message || String(e)}`);
                }
            }
        }

        if (!shouldTryProxy && this.relayerProxy) {
            try {
                return await tryClient(this.relayerProxy, 'PROXY');
            } catch (e: any) {
                proxyErr = e;
                if (this.isRelayerQuotaExceeded(e)) {
                    const rotated = this.rotateRelayerKeyOnQuotaExceeded(e);
                    if (rotated) return await this.redeemViaRelayer(conditionId);
                }
                if (this.isRelayerAuthError(e)) {
                    const rotated = this.rotateRelayerKeyOnAuthError(e);
                    if (rotated) return await this.redeemViaRelayer(conditionId);
                    throw new Error(`Relayer proxy auth failed: ${e?.message || String(e)}`);
                }
            }
        }

        if (proxyErr && safeErr) throw new Error(`Relayer failed (proxy then safe): proxy=${proxyErr?.message || String(proxyErr)}; safe=${safeErr?.message || String(safeErr)}`);
        if (proxyErr) throw new Error(`Relayer failed (proxy): ${proxyErr?.message || String(proxyErr)}`);
        if (safeErr) throw new Error(`Relayer failed (safe): ${safeErr?.message || String(safeErr)}`);
        throw new Error('No relayer client available');
    }

    // Start background scanning loop
    async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        console.log('🚀 Starting Background Arbitrage Scanner...');
        
        // Run forever
        const runLoop = async () => {
            while (this.isRunning) {
                try {
                    const result = await this.scanInternal();
                    this.latestResults = result.opportunities;
                    this.latestLogs = result.logs;
                    console.log(`✅ Background Scan Complete: Found ${result.opportunities.length} opportunities`);
                    
                    // Wait 30 seconds before next scan to be nice to API
                    await new Promise(r => setTimeout(r, 30000));
                } catch (e) {
                    console.error('Scan cycle failed:', e);
                    await new Promise(r => setTimeout(r, 10000));
                }
            }
        };
        runLoop(); // Don't await, let it run in background
    }

    async scanInternal(minLiquidity = 10, limit = 50): Promise<{ opportunities: GroupArbOpportunity[], logs: string[] }> {
        const logs: string[] = [];
        const log = (msg: string) => {
            console.log(msg);
            logs.push(msg);
        };

        log('🔍 Scanning top 2000 markets (Parallel Fetch + Weather Focus)...');
        
        let allMarkets: any[] = [];
        
        // Fetch 2000 markets in PARALLEL (20 batches of 100)
        // Gamma API handles rate limits, but we batch them slightly to be safe
        const offsets = Array.from({ length: 20 }, (_, i) => i * 100); 
        
        // Split into 4 chunks of 5 requests to avoid overwhelming
        const parallelChunks = [];
        for (let i = 0; i < offsets.length; i += 5) {
            parallelChunks.push(offsets.slice(i, i + 5));
        }

        for (const chunk of parallelChunks) {
            const promises = chunk.map(offset => 
                withRetry(() => this.sdk.gammaApi.getMarkets({
                    closed: false,
                    active: true,
                    limit: 100,
                    offset: offset,
                    order: 'endDate', 
                    ascending: true
                }), { maxRetries: 3 })
                .catch(e => {
                    log(`Error fetching offset ${offset}: ${e.message}`);
                    return [];
                })
            );

            const results = await Promise.all(promises);
            results.forEach(markets => allMarkets = allMarkets.concat(markets));
            log(`   Fetched batch (Total so far: ${allMarkets.length})`);
        }
        
        log(`Total markets fetched: ${allMarkets.length}`);

        let weatherCount = 0;
        let timeSkippedCount = 0;

        const multiOutcomeMarkets = allMarkets.filter((m: any) => {
            const q = m.question.toLowerCase();
            
            // 1. Strict Weather Filtering
            const isWeather = q.includes('temperature') || q.includes('weather') || q.includes('rain') || q.includes('snow') || q.includes('degree') || q.includes('°');
            if (!isWeather) return false;

            // 2. Filter out Crypto (Bitcoin, Ethereum, Solana, etc.) just in case
            if (q.includes('bitcoin') || q.includes('ethereum') || q.includes('solana') || q.includes('xrp') || q.includes('crypto')) {
                return false;
            }

            if (!m.outcomes) return false;
            let outcomeList = m.outcomes;
            if (typeof m.outcomes === 'string') {
                try { outcomeList = JSON.parse(m.outcomes); } catch { return false; }
            }
            if (!Array.isArray(outcomeList) || outcomeList.length < 2) return false;

            weatherCount++;
            return true;
        });

        log(`Found ${weatherCount} potential weather markets. Processing details...`);

        const opportunities: GroupArbOpportunity[] = [];
        const chunkSize = 10; 
        const marketsToProcess = multiOutcomeMarkets; 

        for (let i = 0; i < marketsToProcess.length; i += chunkSize) {
            const batch = marketsToProcess.slice(i, i + chunkSize);
            
            await Promise.all(batch.map(async (market: any) => {
                try {
                    // 1. Time Constraint: -24h to 96h (Widened to catch expiring/just expired)
                    const minTime = -24 * 60 * 60 * 1000; 
                    const maxTime = 96 * 60 * 60 * 1000; // 4 days
                    
                    let endTime = 0;
                    if (typeof market.endDate === 'number') {
                        // If endDate is huge, it's ms. If small, it's seconds.
                        endTime = market.endDate > 1_000_000_000_000 ? market.endDate : market.endDate * 1000;
                    } else {
                        endTime = new Date(market.endDate).getTime();
                    }

                    const now = Date.now();
                    const remainingTime = endTime - now;
                    
                    if (!market.endDate || remainingTime < minTime || remainingTime > maxTime) {
                        timeSkippedCount++;
                        return;
                    }

                    let clobMarket;
                    try {
                        clobMarket = await withRetry(() => this.sdk.clobApi.getMarket(market.conditionId), {
                            maxRetries: 2,
                        });
                    } catch (e: any) { return; }

                    const tokens = clobMarket.tokens;
                    if (!tokens || tokens.length < 2) return;

                    const isHighTemp = market.question.toLowerCase().includes('highest temperature');
                    if (!isHighTemp) return;

                    const getTokenId = (t: any): string | undefined => t?.token_id ?? t?.tokenId ?? t?.id;
                    const bestAskCentsByOutcome: Record<string, number> = {};
                    const spreadCentsByOutcome: Record<string, number> = {};
                    const tokenIds: string[] = [];

                    let bidSumCents = 0;
                    let minLiquidityFound = 999999;

                    const orderbookPromises = tokens.map((token: any) => {
                        const tokenId = getTokenId(token);
                        if (!tokenId) return Promise.resolve({ token, book: { asks: [], bids: [] } });
                        return withRetry(() => this.sdk.clobApi.getOrderbook(tokenId), { maxRetries: 1 })
                            .then((book: any) => ({ token, book }))
                            .catch(() => ({ token, book: { asks: [], bids: [] } }));
                    });

                    const orderbooks = await Promise.all(orderbookPromises);

                    for (const { token, book } of orderbooks) {
                        const tokenId = getTokenId(token);
                        if (tokenId) tokenIds.push(tokenId);

                        const outcome = String(token?.outcome ?? token?.name ?? '').toLowerCase();
                        const bestAsk = Number(book?.asks?.[0]?.price);
                        const askSize = Number(book?.asks?.[0]?.size);
                        const bestBid = Number(book?.bids?.[0]?.price);

                        if (!Number.isFinite(bestAsk) || bestAsk <= 0) return;
                        const askCents = bestAsk * 100;
                        bestAskCentsByOutcome[outcome] = askCents;

                        if (Number.isFinite(bestBid) && bestBid > 0) {
                            bidSumCents += bestBid * 100;
                            spreadCentsByOutcome[outcome] = Math.max(0, (bestAsk - bestBid) * 100);
                        }
                        if (Number.isFinite(askSize) && askSize > 0) minLiquidityFound = Math.min(minLiquidityFound, askSize * askCents);
                    }

                    const yesCents = bestAskCentsByOutcome['yes'];
                    const noCents = bestAskCentsByOutcome['no'];
                    if (!Number.isFinite(yesCents) || !Number.isFinite(noCents)) return;

                    const totalCostCents = yesCents + noCents;
                    if (!(totalCostCents >= 99 && totalCostCents <= 130)) return;

                    const profitPercent = 100 - totalCostCents;
                    const profit = profitPercent / 100;
                    const ratioScore = 1 - Math.min(1, Math.abs((yesCents / totalCostCents) - 0.5) * 2);
                    const yesSpread = spreadCentsByOutcome['yes'];
                    const noSpread = spreadCentsByOutcome['no'];
                    const spreadSum = (Number.isFinite(yesSpread) ? yesSpread : 0) + (Number.isFinite(noSpread) ? noSpread : 0);

                    if (true) {
                        opportunities.push({
                            marketId: market.conditionId,
                            gammaId: market.id,
                            question: market.question,
                            slug: market.slug || '',
                            outcomes: market.outcomes,
                            tokenIds,
                            prices: [yesCents, noCents],
                            yesPrice: yesCents,
                            noPrice: noCents,
                            totalCost: totalCostCents,
                            spreadSum: Number.isFinite(spreadSum) ? spreadSum : undefined,
                            yesSpread: Number.isFinite(yesSpread) ? yesSpread : undefined,
                            noSpread: Number.isFinite(noSpread) ? noSpread : undefined,
                            profit,
                            profitPercent,
                            liquidity: minLiquidityFound,
                            bidSum: bidSumCents,
                            endDate: market.endDate,
                            isWeather: true,
                            ratioScore,
                            image: market.image || market.icon,
                            volume24hr: (() => {
                                const raw = market.volume24hr ?? market.volume24h ?? market.volume ?? market.volumeNum;
                                const n = typeof raw === 'string' ? Number(raw) : Number(raw);
                                return Number.isFinite(n) ? n : undefined;
                            })()
                        });
                    }

                } catch (e) {
                    // ignore
                }
            }));
            
            await new Promise(r => setTimeout(r, 100));
        }
        
        log(`skipped ${timeSkippedCount} markets due to time window (0h-96h).`);
        log(`✅ Found ${opportunities.length} opportunities.`);

        return { 
            opportunities: opportunities.sort((a, b) => {
                const sa = a.spreadSum ?? Number.POSITIVE_INFINITY;
                const sb = b.spreadSum ?? Number.POSITIVE_INFINITY;
                if (a.ratioScore !== b.ratioScore) return b.ratioScore - a.ratioScore;
                if (sa !== sb) return sa - sb;
                if (a.totalCost !== b.totalCost) return a.totalCost - b.totalCost;
                return (b.liquidity ?? 0) - (a.liquidity ?? 0);
            }), 
            logs 
        };
    }

    // Public method for route to get cached results
    getResults() {
        return {
            opportunities: this.latestResults,
            logs: this.latestLogs,
            count: this.latestResults.length
        };
    }

    // Get Active Orders (For Monitoring)
    async getActiveOrders(marketId?: string): Promise<any[]> {
        // If marketId is provided, fetch for that market.
        if (marketId) {
             const orders = await this.tradingClient.getOpenOrders(marketId);
             return orders || [];
        }
        
        return [];
    }

    getFunderAddress(): string {
        return this.tradingClient.getFunderAddress();
    }

    getEoaAddress(): string {
        return this.tradingClient.getSignerAddress();
    }

    hasPrivateKey(): boolean {
        return this.hasValidKey;
    }

    getTradingInitStatus(): any {
        return (this.tradingClient as any).getInitStatus ? (this.tradingClient as any).getInitStatus() : { initialized: false, hasCredentials: false, lastInitError: 'unsupported', signatureType: 0, signer: this.getEoaAddress(), funder: this.getFunderAddress() };
    }

    private startTradingInitRetry() {
        if (this.tradingInitTimer) return;
        const tick = () => {
            this.tryInitTradingClient().catch(() => {});
        };
        tick();
        this.tradingInitTimer = setInterval(tick, 5_000);
    }

    private async tryInitTradingClient() {
        const st = this.getTradingInitStatus();
        if (st?.initialized === true) {
            if (this.tradingInitTimer) {
                clearInterval(this.tradingInitTimer);
                this.tradingInitTimer = null;
            }
            return;
        }
        const now = Date.now();
        if (now < this.tradingInitNextAllowedAtMs) return;
        try {
            await this.tradingClient.initialize();
            this.tradingInitBackoffMs = 5_000;
            this.tradingInitNextAllowedAtMs = now + 60_000;
        } catch {
            const next = Math.min(120_000, Math.max(5_000, Math.floor(this.tradingInitBackoffMs * 1.7)));
            this.tradingInitBackoffMs = next;
            this.tradingInitNextAllowedAtMs = now + next;
        }
    }

    async getAllOpenOrders(): Promise<any[]> {
        const orders = await this.tradingClient.getOpenOrders();
        const list = orders || [];
        const orderIdToStrategy = this.buildOrderIdToStrategyMap();
        const enriched = await Promise.all(list.map(async (o: any) => {
            const marketId = String(o?.marketId || o?.market || '').trim();
            if (!marketId) return o;
            const meta = await this.resolveMarketMeta(marketId);
            const orderId = String(o?.id || o?.orderId || '').trim();
            const strategy = orderId ? orderIdToStrategy.get(orderId) : undefined;
            const source = strategy ? 'tool' : 'external';
            const status = String(o?.status || '').toUpperCase();
            return { ...o, status, strategy: strategy || 'external', source, marketQuestion: meta.title, slug: meta.slug, eventSlug: meta.eventSlug };
        }));
        return enriched;
    }

    shutdown() {
        this.isRunning = false;
        this.crypto15mAutoEnabled = false;
        this.cryptoAll2AutoEnabled = false;
        this.cryptoAllAutoEnabled = false;
        if (this.tradingInitTimer) { clearInterval(this.tradingInitTimer); this.tradingInitTimer = null; }
        if (this.crypto15mAutoTimer) { clearInterval(this.crypto15mAutoTimer); this.crypto15mAutoTimer = null; }
        if (this.crypto15mWatchdogTimer) { clearInterval(this.crypto15mWatchdogTimer); this.crypto15mWatchdogTimer = null; }
        if (this.crypto15mWsTimer) { clearInterval(this.crypto15mWsTimer); this.crypto15mWsTimer = null; }
        if (this.cryptoAll2AutoTimer) { clearInterval(this.cryptoAll2AutoTimer); this.cryptoAll2AutoTimer = null; }
        if (this.cryptoAll2SplitBuyTimer) { clearInterval(this.cryptoAll2SplitBuyTimer); this.cryptoAll2SplitBuyTimer = null; }
        this.cryptoAll2SplitBuyState.clear();
        if (this.cryptoAllAutoTimer) { clearInterval(this.cryptoAllAutoTimer); this.cryptoAllAutoTimer = null; }
        if (this.cryptoAllStoplossTimer) { clearInterval(this.cryptoAllStoplossTimer); this.cryptoAllStoplossTimer = null; }
        if (this.cryptoAllWatchdogTimer) { clearInterval(this.cryptoAllWatchdogTimer); this.cryptoAllWatchdogTimer = null; }
        if (this.cryptoAllWsTimer) { clearInterval(this.cryptoAllWsTimer); this.cryptoAllWsTimer = null; }
        if (this.cryptoAllSnapshotTimer) { clearInterval(this.cryptoAllSnapshotTimer); this.cryptoAllSnapshotTimer = null; }
        if (this.autoRedeemTimer) { clearInterval(this.autoRedeemTimer); this.autoRedeemTimer = null; }
        if (this.orderHistoryPersistTimer) { clearInterval(this.orderHistoryPersistTimer); this.orderHistoryPersistTimer = null; }
        if (this.pnlTimer) { clearInterval(this.pnlTimer); this.pnlTimer = null; }
        if (this.pnlWriteTimer) { clearInterval(this.pnlWriteTimer); this.pnlWriteTimer = null; }
    }

    async getTrades(params?: any): Promise<any[]> {
        const trades = await this.tradingClient.getTrades(params);
        const list = trades || [];
        const orderIdToStrategy = this.buildOrderIdToStrategyMap();
        const enriched = await Promise.all(list.map(async (t: any) => {
            const marketId = String(t?.market || t?.marketId || t?.conditionId || '').trim();
            const candidates: string[] = [];
            if (t?.taker_order_id) candidates.push(String(t.taker_order_id));
            if (Array.isArray(t?.maker_orders)) {
                for (const mo of t.maker_orders) {
                    if (mo?.order_id) candidates.push(String(mo.order_id));
                }
            }
            let strategy: string | undefined;
            for (const id of candidates) {
                const s = orderIdToStrategy.get(id);
                if (s) {
                    strategy = s;
                    break;
                }
            }
            const source = strategy ? 'tool' : 'external';
            if (!marketId) return { ...t, strategy: strategy || 'external', source, orderIds: candidates };
            const meta = await this.resolveMarketMeta(marketId);
            const status = String(t?.status || '').toUpperCase();
            return { ...t, status, marketId, strategy: strategy || 'external', source, orderIds: candidates, title: t?.title ?? meta.title, slug: t?.slug ?? meta.slug, eventSlug: t?.eventSlug ?? meta.eventSlug };
        }));
        return enriched;
    }

    private async probeRecentBuyState(options: { conditionId: string; tokenId: string; orderId?: string | null; maxWaitMs?: number }) {
        const conditionId = String(options.conditionId || '').trim();
        const tokenId = String(options.tokenId || '').trim();
        const orderId0 = options.orderId != null ? String(options.orderId).trim() : '';
        const maxWaitMs = Math.max(0, Math.floor(Number(options.maxWaitMs) || 0));
        const startedAtMs = Date.now();
        const deadlineMs = maxWaitMs > 0 ? (startedAtMs + maxWaitMs) : startedAtMs;
        const normalizeTsMs = (v: any) => {
            const n = typeof v === 'number' ? v : (v != null ? Date.parse(String(v)) : NaN);
            if (!Number.isFinite(n)) return null;
            if (n > 2_000_000_000_000) return n;
            if (n > 2_000_000_000) return n * 1000;
            if (n > 1_000_000_000) return n * 1000;
            return n;
        };
        const probeOnce = async () => {
            let orderId: string | null = orderId0 || null;
            let filledSize: number | null = null;
            let filledUsd: number | null = null;
            let orderStatus: string | null = null;
            let orderFetched = false;
            let hasOpen = false;
            let openOrderId: string | null = null;
            let openRemainingUsd: number | null = null;
            if (orderId) {
                try {
                    const o: any = await this.tradingClient.getOrder(orderId);
                    orderFetched = true;
                    orderStatus = o?.status != null ? String(o.status).toUpperCase() : null;
                    const fs = o?.filledSize != null ? Number(o.filledSize) : NaN;
                    const p = o?.price != null ? Number(o.price) : NaN;
                    filledSize = Number.isFinite(fs) ? fs : null;
                    if (filledSize != null && Number.isFinite(p)) {
                        const v = filledSize * p;
                        filledUsd = Number.isFinite(v) ? v : null;
                    }
                } catch {
                }
            }
            try {
                const nowMs = Date.now();
                const recentWindowMs = 120_000;
                const openOrders = await this.tradingClient.getOpenOrders(conditionId).catch(() => []);
                const list = Array.isArray(openOrders) ? openOrders : [];
                for (const o of list) {
                    const tid = String(o?.tokenId || '').trim();
                    if (tid !== tokenId) continue;
                    const side = String(o?.side || '').toUpperCase();
                    if (side && side !== 'BUY') continue;
                    const createdAtMs = normalizeTsMs(o?.createdAt);
                    if (createdAtMs != null && nowMs - createdAtMs > recentWindowMs) continue;
                    const id = String(o?.id || o?.orderId || '').trim();
                    if (id) {
                        hasOpen = true;
                        openOrderId = id;
                        if (!orderId) orderId = id;
                    }
                    const size = o?.originalSize != null ? Number(o.originalSize) : (o?.size != null ? Number(o.size) : NaN);
                    const fs = o?.filledSize != null ? Number(o.filledSize) : (o?.filled != null ? Number(o.filled) : 0);
                    const price = o?.price != null ? Number(o.price) : NaN;
                    const remaining = Number.isFinite(size) ? Math.max(0, size - (Number.isFinite(fs) ? fs : 0)) : NaN;
                    if (Number.isFinite(remaining) && Number.isFinite(price)) {
                        const remUsd = remaining * price;
                        openRemainingUsd = Number.isFinite(remUsd) ? remUsd : openRemainingUsd;
                    }
                }
            } catch {
            }
            return { orderId, filledSize, filledUsd, orderStatus, orderFetched, hasOpen, openOrderId, openRemainingUsd };
        };
        while (true) {
            const r = await probeOnce();
            const hasEvidence = (r.filledUsd != null && r.filledUsd > 0) || r.hasOpen === true || r.orderFetched === true;
            if (hasEvidence) return r;
            if (Date.now() >= deadlineMs) return r;
            await new Promise((res) => setTimeout(res, 250));
        }
    }

    private buildOrderIdToStrategyMap(): Map<string, string> {
        const m = new Map<string, string>();
        for (const entry of this.orderHistory) {
            const mode = entry?.mode;
            const strategy = mode === 'manual' ? 'manual' : mode === 'auto' ? 'auto' : mode === 'semi' ? 'semi' : undefined;
            if (!strategy) continue;
            const results = Array.isArray(entry?.results) ? entry.results : [];
            for (const r of results) {
                const orderId = r?.orderId;
                if (!orderId) continue;
                m.set(String(orderId), strategy);
            }
        }
        return m;
    }

    async getTradingStatus(): Promise<any> {
        try {
            const ok = await this.tradingClient.getOk();
            return { ok: true, clob: ok, funder: this.getFunderAddress() };
        } catch (e: any) {
            return { ok: false, funder: this.getFunderAddress(), error: e?.message || String(e) };
        }
    }

    async getCtfCustody(marketId: string): Promise<any> {
        const market = await withRetry(() => this.sdk.clobApi.getMarket(marketId), { maxRetries: 2 });
        const tokens: any[] = Array.isArray((market as any)?.tokens) ? (market as any).tokens : [];
        const yesToken = tokens.find((t: any) => String(t?.outcome ?? '').toLowerCase() === 'yes');
        const noToken = tokens.find((t: any) => String(t?.outcome ?? '').toLowerCase() === 'no');
        const yesTokenId = yesToken?.tokenId ?? yesToken?.token_id ?? yesToken?.id;
        const noTokenId = noToken?.tokenId ?? noToken?.token_id ?? noToken?.id;

        const signer = this.tradingClient.getSignerAddress();
        const funder = this.getFunderAddress();

        const provider = new ethers.providers.JsonRpcProvider('https://polygon-rpc.com');
        const conditionalTokens = new ethers.Contract(
            '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
            ['function balanceOf(address account, uint256 id) view returns (uint256)'],
            provider
        );

        const fmt = (v: any) => ethers.utils.formatUnits(v, 6);
        const getBal = async (addr: string, tid: string | undefined) => {
            if (!addr || !tid) return '0';
            const b = await conditionalTokens.balanceOf(addr, tid);
            return fmt(b);
        };

        const [signerYes, signerNo, funderYes, funderNo] = await Promise.all([
            getBal(signer, yesTokenId),
            getBal(signer, noTokenId),
            getBal(funder, yesTokenId),
            getBal(funder, noTokenId),
        ]);

        return {
            marketId,
            question: market.question,
            signer,
            funder,
            tokenIds: { yesTokenId, noTokenId },
            balances: {
                signer: { yes: signerYes, no: signerNo },
                funder: { yes: funderYes, no: funderNo },
            },
        };
    }

    async cancelOrder(orderId: string): Promise<any> {
        this.systemCanceledOrderIds.add(orderId);
        return await this.tradingClient.cancelOrder(orderId);
    }

    // New: Get Persistent Order History
    getHistory() {
        return this.orderHistory;
    }

    async getCrypto15mDiag() {
        const dns = await import('node:dns/promises');
        const startedAt = new Date().toISOString();
        const host = 'clob.polymarket.com';
        const results: any = {
            success: true,
            startedAt,
            host,
            booksSnapshot: {
                atMs: this.crypto15mBooksSnapshot.atMs,
                at: this.crypto15mBooksSnapshot.atMs ? new Date(this.crypto15mBooksSnapshot.atMs).toISOString() : null,
                staleMs: this.crypto15mBooksSnapshot.atMs ? Math.max(0, Date.now() - this.crypto15mBooksSnapshot.atMs) : null,
                lastError: this.crypto15mBooksSnapshot.lastError,
                lastAttemptAtMs: this.crypto15mBooksSnapshot.lastAttemptAtMs,
                lastAttemptAt: this.crypto15mBooksSnapshot.lastAttemptAtMs ? new Date(this.crypto15mBooksSnapshot.lastAttemptAtMs).toISOString() : null,
                lastAttemptError: this.crypto15mBooksSnapshot.lastAttemptError,
                backoffMs: this.crypto15mBooksBackoffMs || 0,
                nextAllowedAtMs: this.crypto15mBooksNextAllowedAtMs || 0,
                nextAllowedAt: this.crypto15mBooksNextAllowedAtMs ? new Date(this.crypto15mBooksNextAllowedAtMs).toISOString() : null,
            },
            booksGlobal: (() => {
                const s: any = (this as any).clobBooksGlobalState || null;
                return s ? {
                    nextAllowedAtMs: Number(s.nextAllowedAtMs || 0),
                    blockedUntilMs: Number(s.blockedUntilMs || 0),
                    blockedBackoffMs: Number(s.blockedBackoffMs || 0),
                    lastStatus: s.lastStatus ?? null,
                    lastError: s.lastError ?? null,
                } : null;
            })(),
            marketSnapshot: {
                atMs: this.crypto15mMarketSnapshot.atMs,
                at: this.crypto15mMarketSnapshot.atMs ? new Date(this.crypto15mMarketSnapshot.atMs).toISOString() : null,
                lastError: this.crypto15mMarketSnapshot.lastError,
                backoffMs: this.crypto15mMarketBackoffMs || 0,
                nextAllowedAtMs: this.crypto15mMarketNextAllowedAtMs || 0,
                nextAllowedAt: this.crypto15mMarketNextAllowedAtMs ? new Date(this.crypto15mMarketNextAllowedAtMs).toISOString() : null,
                marketCount: Array.isArray(this.crypto15mMarketSnapshot.markets) ? this.crypto15mMarketSnapshot.markets.length : 0,
                diag: (this.crypto15mMarketSnapshot as any)?.diag ?? null,
            },
            dns: {},
            markets: {},
            books: {},
        };

        try {
            const addrs = await this.withTimeout(dns.lookup(host, { all: true }), 1500, 'dns lookup');
            results.dns.lookup = addrs;
        } catch (e: any) {
            results.dns.error = e?.message || String(e);
        }

        const fetchWithMs = async (label: string, url: string, init?: any) => {
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), 3500);
            const t0 = Date.now();
            try {
                const res = await fetch(url, { ...(init || {}), signal: controller.signal });
                const ms = Date.now() - t0;
                const text = await res.text().catch(() => '');
                return { ok: res.ok, status: res.status, ms, bodySample: text.slice(0, 300) };
            } catch (e: any) {
                const ms = Date.now() - t0;
                return { ok: false, status: null, ms, error: e?.message || String(e) };
            } finally {
                clearTimeout(t);
            }
        };

        results.markets = await fetchWithMs('markets', 'https://clob.polymarket.com/markets?limit=1');

        try {
            const markets = Array.isArray(this.crypto15mMarketSnapshot.markets) ? this.crypto15mMarketSnapshot.markets : [];
            const tokenIds = Array.from(new Set(markets.flatMap((m: any) => Array.isArray(m?.tokenIds) ? m.tokenIds : []).map((t: any) => String(t || '').trim()).filter((t: any) => !!t))).slice(0, 1);
            if (!tokenIds.length) {
                results.books = { ok: false, status: null, ms: 0, error: 'no tokenId sample available' };
            } else {
                results.books = await fetchWithMs('books', 'https://clob.polymarket.com/books', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', 'accept': 'application/json' },
                    body: JSON.stringify(tokenIds.map((token_id) => ({ token_id }))),
                });
            }
        } catch (e: any) {
            results.books = { ok: false, status: null, ms: 0, error: e?.message || String(e) };
        }

        return results;
    }

    async getCrypto15mHistory(options?: { refresh?: boolean; intervalMs?: number; maxEntries?: number }) {
        const refresh = options?.refresh === true;
        const intervalMs = options?.intervalMs != null ? Number(options.intervalMs) : 1000;
        const maxEntries = options?.maxEntries != null ? Math.max(1, Math.floor(Number(options.maxEntries))) : 50;
        if (refresh) {
            await this.refreshHistoryStatuses({ minIntervalMs: intervalMs, maxEntries: Math.max(50, maxEntries) });
        }
        const funder = this.getFunderAddress();
        const signer = this.tradingClient.getSignerAddress();
        const positions0 = await this.fetchDataApiPositions(funder).catch(() => []);
        const positions1 =
            (!Array.isArray(positions0) || positions0.length === 0) && signer && signer.toLowerCase() !== funder.toLowerCase()
                ? await this.fetchDataApiPositions(signer).catch(() => [])
                : [];
        const positions = (Array.isArray(positions0) ? positions0 : []).concat(Array.isArray(positions1) ? positions1 : []);
        const byCondition = new Map<string, any>();
        for (const p of positions) {
            const k = String(p?.conditionId || '').trim().toLowerCase();
            if (!k) continue;
            const prev = byCondition.get(k);
            if (!prev) { byCondition.set(k, p); continue; }
            const prevScore = Number(prev?.currentValue ?? prev?.size ?? 0);
            const curScore = Number(p?.currentValue ?? p?.size ?? 0);
            if (!Number.isFinite(prevScore) || (Number.isFinite(curScore) && curScore >= prevScore)) {
                byCondition.set(k, p);
            }
        }

        const latestRedeemByCondition = new Map<string, any>();
        for (const e of this.orderHistory) {
            if (!e || String(e?.action || '') !== 'redeem') continue;
            const ts = e?.timestamp ? Date.parse(String(e.timestamp)) : NaN;
            const results = Array.isArray(e?.results) ? e.results : [];
            for (const r of results) {
                const cid = String(r?.conditionId || '').trim();
                if (!cid) continue;
                const key = cid.toLowerCase();
                const prev = latestRedeemByCondition.get(key);
                const prevTs = prev?.__ts != null ? Number(prev.__ts) : NaN;
                const curTs = Number.isFinite(ts) ? ts : Date.now();
                if (!prev || (Number.isFinite(curTs) && (!Number.isFinite(prevTs) || curTs >= prevTs))) {
                    latestRedeemByCondition.set(key, { ...r, __ts: curTs });
                }
            }
        }

        const items = this.orderHistory
            .filter((e: any) => e && String(e?.action || '') === 'crypto15m_order')
            .slice(0, maxEntries)
            .map((e: any) => {
                const conditionId = String(e?.marketId || '').trim();
                const res0 = Array.isArray(e?.results) ? e.results[0] : null;
                const redeem0 = conditionId ? latestRedeemByCondition.get(conditionId.toLowerCase()) : null;
                const inflight = conditionId ? this.redeemInFlight.get(conditionId) : null;
                const pos = conditionId ? byCondition.get(conditionId.toLowerCase()) : null;
                const curPrice = pos?.curPrice != null ? Number(pos.curPrice) : null;
                const redeemable = pos?.redeemable === true;
                const redeemStatus = String(res0?.redeemStatus || redeem0?.redeemStatus || inflight?.status || '').toLowerCase() || null;
                const paid = (res0?.paid ?? redeem0?.paid ?? inflight?.paid) === true;
                const payoutNetUsdc = (res0?.payoutNetUsdc ?? redeem0?.payoutNetUsdc ?? inflight?.payoutNetUsdc) != null ? Number(res0?.payoutNetUsdc ?? redeem0?.payoutNetUsdc ?? inflight?.payoutNetUsdc) : null;
                const txStatus = (res0?.txStatus ?? redeem0?.txStatus ?? inflight?.txStatus) != null ? Number(res0?.txStatus ?? redeem0?.txStatus ?? inflight?.txStatus) : null;
                const cashPnl = pos?.cashPnl != null ? Number(pos.cashPnl) : null;
                const percentPnl = pos?.percentPnl != null ? Number(pos.percentPnl) : null;
                const txHash = res0?.txHash ?? redeem0?.txHash ?? inflight?.txHash ?? null;
                const normalizedRedeemStatus =
                    redeemStatus === 'failed' && txHash && txStatus != null && txStatus !== 0 && payoutNetUsdc != null && payoutNetUsdc <= 0 && paid === false
                        ? 'confirmed'
                        : redeemStatus;
                const redeemConfirmed = normalizedRedeemStatus === 'confirmed';
                const result =
                    redeemConfirmed && paid === true ? 'WIN'
                    : redeemConfirmed && paid === false ? 'LOSS'
                    : curPrice != null && curPrice >= 0.999 ? 'WIN'
                    : curPrice != null && curPrice <= 0.001 ? 'LOSS'
                    : pos ? 'OPEN'
                    : 'UNKNOWN';
                const state =
                    redeemConfirmed && paid === true ? 'confirmed_paid'
                    : redeemConfirmed && paid === false ? 'confirmed_no_payout'
                    : normalizedRedeemStatus === 'submitted' ? 'redeem_submitted'
                    : normalizedRedeemStatus === 'failed' ? 'redeem_failed'
                    : redeemable ? 'redeemable'
                    : pos ? 'open'
                    : 'position_missing';
                const filledShares = res0?.filledSize != null && Number.isFinite(Number(res0.filledSize)) ? Number(res0.filledSize) : 0;
                const pxHint = (res0 as any)?.orderPrice ?? e?.limitPrice ?? e?.bestAsk ?? e?.price ?? null;
                const px = pxHint != null && Number.isFinite(Number(pxHint)) ? Number(pxHint) : null;
                const filledUsd = filledShares > 0 && px != null ? (filledShares * px) : 0;
                const stakeUsd = filledUsd > 0 ? filledUsd : (Number(e?.amountUsd) || 0);
                const realizedPnlUsdc =
                    redeemConfirmed
                        ? (payoutNetUsdc != null ? Number(payoutNetUsdc) - stakeUsd : (paid === false ? 0 - stakeUsd : null))
                        : null;
                const orderStatusNorm = String(res0?.orderStatus || '').toUpperCase();
                const errorMsg = (filledShares > 0 || orderStatusNorm === 'MATCHED' || orderStatusNorm === 'FILLED') ? null : (res0?.errorMsg ?? null);
                return {
                    id: e?.id,
                    timestamp: e?.timestamp,
                    symbol: e?.symbol,
                    slug: e?.slug,
                    title: e?.marketQuestion,
                    conditionId,
                    outcome: e?.outcome,
                    buySizingMode: e?.buySizingMode ?? null,
                    requestedAmountUsd: e?.requestedAmountUsd ?? null,
                    amountUsd: stakeUsd,
                    sizingDepthUsd: e?.sizingDepthUsd ?? null,
                    sizingDepthCap: e?.sizingDepthCap ?? null,
                    sizingAskLevelsUsed: e?.sizingAskLevelsUsed ?? null,
                    bestAsk: e?.bestAsk ?? e?.price ?? null,
                    limitPrice: e?.limitPrice ?? null,
                    orderId: res0?.orderId ?? res0?.id ?? e?.orderId ?? null,
                    orderStatus: res0?.orderStatus ?? (res0?.success === false ? `failed:${String(res0?.errorMsg || 'order_failed').slice(0, 160)}` : null),
                    filledSize: res0?.filledSize ?? null,
                    error: errorMsg,
                    sweepOrders: e?.sweepLog?.summary?.totalOrders ?? null,
                    sweepAttemptedUsd: e?.sweepLog?.summary?.totalAttemptedUsd ?? null,
                    sweepFilledUsd: e?.sweepLog?.summary?.totalFilledUsd ?? null,
                    sweepFilledShares: e?.sweepLog?.summary?.totalFilledShares ?? null,
                    sweepAvgFillPrice: e?.sweepLog?.summary?.avgFillPrice ?? null,
                    sweepStopReason: e?.sweepLog?.summary?.stopReason ?? null,
                    sweepLastLatencyMs: Array.isArray(e?.sweepLog?.orders) ? Math.max(0, ...e.sweepLog.orders.map((o: any) => Number(o?.statusLatencyMs) || 0)) : null,
                    result,
                    state,
                    curPrice,
                    cashPnl,
                    percentPnl,
                    redeemable,
                    redeemStatus: normalizedRedeemStatus,
                    paid,
                    payoutNetUsdc,
                    realizedPnlUsdc,
                    txHash,
                };
            });

        const configEvents = this.orderHistory
            .filter((e: any) => {
                const a = String(e?.action || '');
                return a === 'crypto15m_config_start' || a === 'crypto15m_config_stop' || a === 'crypto15m_config_update';
            })
            .slice(0, Math.max(20, maxEntries))
            .map((e: any) => ({
                id: e?.id,
                timestamp: e?.timestamp,
                action: e?.action,
                enabled: e?.config?.enabled ?? null,
                config: e?.config ?? null,
            }));

        const summary = {
            count: items.length,
            totalStakeUsd: items.reduce((s: number, x: any) => s + (Number(x?.amountUsd) || 0), 0),
            pnlTotalUsdc: items.reduce((s: number, x: any) => s + (Number(x?.realizedPnlUsdc) || 0), 0),
            winCount: items.filter((x: any) => x.result === 'WIN').length,
            lossCount: items.filter((x: any) => x.result === 'LOSS').length,
            openCount: items.filter((x: any) => x.result === 'OPEN').length,
            redeemableCount: items.filter((x: any) => x.redeemable === true).length,
            redeemedCount: items.filter((x: any) => x.redeemStatus === 'confirmed' && x.paid === true).length,
            ...(function () {
                const now = Date.now();
                const within1h = items.filter((x: any) => {
                    const ts = Date.parse(String(x?.timestamp || ''));
                    return Number.isFinite(ts) ? (now - ts) <= 60 * 60_000 : false;
                });
                const totalOrders1h = within1h.length;
                const filledOrders1h = within1h.filter((x: any) => {
                    const fs = Number(x?.filledSize);
                    const st = String(x?.orderStatus || '').toUpperCase();
                    return (Number.isFinite(fs) && fs > 0) || st === 'MATCHED' || st === 'FILLED';
                }).length;
                const filledUsd1h = within1h.reduce((s: number, x: any) => {
                    const fs = Number(x?.filledSize);
                    const st = String(x?.orderStatus || '').toUpperCase();
                    const filled = (Number.isFinite(fs) && fs > 0) || st === 'MATCHED' || st === 'FILLED';
                    return s + (filled ? (Number(x?.amountUsd) || 0) : 0);
                }, 0);
                const fillRate1h = totalOrders1h > 0 ? (filledOrders1h / totalOrders1h) : 0;
                return { totalOrders1h, filledOrders1h, filledUsd1h, fillRate1h };
            })(),
        };

        return { success: true, summary, history: items, configEvents, historyPersist: { path: this.orderHistoryPath, lastError: this.orderHistoryPersistLastError } };
    }

    async getCrypto15mReplay(idRaw: any) {
        const id = Math.floor(Number(idRaw));
        if (!Number.isFinite(id) || id <= 0) return { success: false, error: 'invalid_id' };
        const e: any = this.orderHistory.find((x: any) => x && Math.floor(Number(x?.id)) === id && String(x?.action || '') === 'crypto15m_order') || null;
        if (!e) return { success: false, error: 'not_found' };
        const replay = e?.replay ?? null;
        if (!replay) return { success: false, error: 'replay_not_available' };
        return {
            success: true,
            entry: {
                id: e?.id,
                timestamp: e?.timestamp,
                symbol: e?.symbol,
                conditionId: e?.marketId,
                tokenId: e?.results?.[0]?.tokenId ?? null,
                outcome: e?.outcome ?? null,
                bestAsk: e?.bestAsk ?? e?.price ?? null,
                limitPrice: e?.limitPrice ?? null,
                amountUsd: e?.amountUsd ?? null,
                buySizingMode: e?.buySizingMode ?? null,
                orderId: e?.results?.[0]?.orderId ?? null,
                orderStatus: e?.results?.[0]?.orderStatus ?? null,
                filledSize: e?.results?.[0]?.filledSize ?? null,
                errorMsg: e?.results?.[0]?.errorMsg ?? null,
            },
            replay
        };
    }

    async getCryptoAll2History(options?: { refresh?: boolean; intervalMs?: number; maxEntries?: number; includeSkipped?: boolean }) {
        const refresh = options?.refresh === true;
        const intervalMs = options?.intervalMs != null ? Number(options.intervalMs) : 1000;
        const maxEntries = options?.maxEntries != null ? Math.max(1, Math.floor(Number(options.maxEntries))) : 50;
        const includeSkipped = options?.includeSkipped === true;
        if (refresh) {
            await this.refreshHistoryStatuses({ minIntervalMs: intervalMs, maxEntries: Math.max(50, maxEntries) });
        }
        const funder = this.getFunderAddress();
        const signer = this.tradingClient.getSignerAddress();
        const positions0 = await this.fetchDataApiPositions(funder).catch(() => []);
        const positions1 =
            (!Array.isArray(positions0) || positions0.length === 0) && signer && signer.toLowerCase() !== funder.toLowerCase()
                ? await this.fetchDataApiPositions(signer).catch(() => [])
                : [];
        const positions = (Array.isArray(positions0) ? positions0 : []).concat(Array.isArray(positions1) ? positions1 : []);
        const byCondition = new Map<string, any>();
        for (const p of positions) {
            const k = String(p?.conditionId || '').trim().toLowerCase();
            if (!k) continue;
            const prev = byCondition.get(k);
            if (!prev) { byCondition.set(k, p); continue; }
            const prevScore = Number(prev?.currentValue ?? prev?.size ?? 0);
            const curScore = Number(p?.currentValue ?? p?.size ?? 0);
            if (!Number.isFinite(prevScore) || (Number.isFinite(curScore) && curScore >= prevScore)) {
                byCondition.set(k, p);
            }
        }

        const latestRedeemByCondition = new Map<string, any>();
        for (const e of this.orderHistory) {
            if (!e || String(e?.action || '') !== 'redeem') continue;
            const ts = e?.timestamp ? Date.parse(String(e.timestamp)) : NaN;
            const results = Array.isArray(e?.results) ? e.results : [];
            for (const r of results) {
                const cid = String(r?.conditionId || '').trim();
                if (!cid) continue;
                const key = cid.toLowerCase();
                const prev = latestRedeemByCondition.get(key);
                const prevTs = prev?.__ts != null ? Number(prev.__ts) : NaN;
                const curTs = Number.isFinite(ts) ? ts : Date.now();
                if (!prev || (Number.isFinite(curTs) && (!Number.isFinite(prevTs) || curTs >= prevTs))) {
                    latestRedeemByCondition.set(key, { ...r, __ts: curTs });
                }
            }
        }

        const items = this.orderHistory
            .filter((e: any) => e && String(e?.action || '') === 'cryptoall2_order')
            .filter((e: any) => {
                if (includeSkipped) return true;
                const res0 = Array.isArray(e?.results) ? e.results[0] : null;
                const orderStatus = String(res0?.orderStatus || '').toLowerCase();
                if (orderStatus.startsWith('skipped:')) return false;
                const ok = res0?.success === true;
                const orderId = res0?.orderId != null ? String(res0.orderId) : '';
                return ok || !!orderId;
            })
            .slice(0, maxEntries)
            .map((e: any) => {
                const conditionId = String(e?.marketId || '').trim();
                const res0 = Array.isArray(e?.results) ? e.results[0] : null;
                const redeem0 = conditionId ? latestRedeemByCondition.get(conditionId.toLowerCase()) : null;
                const inflight = conditionId ? this.redeemInFlight.get(conditionId) : null;
                const pos = conditionId ? byCondition.get(conditionId.toLowerCase()) : null;
                const curPrice = pos?.curPrice != null ? Number(pos.curPrice) : null;
                const redeemable = pos?.redeemable === true;
                const redeemStatus = String(res0?.redeemStatus || redeem0?.redeemStatus || inflight?.status || '').toLowerCase() || null;
                const paid = (res0?.paid ?? redeem0?.paid ?? inflight?.paid) === true;
                const payoutNetUsdc = (res0?.payoutNetUsdc ?? redeem0?.payoutNetUsdc ?? inflight?.payoutNetUsdc) != null ? Number(res0?.payoutNetUsdc ?? redeem0?.payoutNetUsdc ?? inflight?.payoutNetUsdc) : null;
                const txStatus = (res0?.txStatus ?? redeem0?.txStatus ?? inflight?.txStatus) != null ? Number(res0?.txStatus ?? redeem0?.txStatus ?? inflight?.txStatus) : null;
                const cashPnl = pos?.cashPnl != null ? Number(pos.cashPnl) : null;
                const percentPnl = pos?.percentPnl != null ? Number(pos.percentPnl) : null;
                const txHash = res0?.txHash ?? redeem0?.txHash ?? inflight?.txHash ?? null;
                const normalizedRedeemStatus =
                    redeemStatus === 'failed' && txHash && txStatus != null && txStatus !== 0 && payoutNetUsdc != null && payoutNetUsdc <= 0 && paid === false
                        ? 'confirmed'
                        : redeemStatus;
                const redeemConfirmed = normalizedRedeemStatus === 'confirmed';
                const result =
                    redeemConfirmed && paid === true ? 'WIN'
                    : redeemConfirmed && paid === false ? 'LOSS'
                    : curPrice != null && curPrice >= 0.999 ? 'WIN'
                    : curPrice != null && curPrice <= 0.001 ? 'LOSS'
                    : pos ? 'OPEN'
                    : 'UNKNOWN';
                const state =
                    redeemConfirmed && paid === true ? 'confirmed_paid'
                    : redeemConfirmed && paid === false ? 'confirmed_no_payout'
                    : normalizedRedeemStatus === 'submitted' ? 'redeem_submitted'
                    : normalizedRedeemStatus === 'failed' ? 'redeem_failed'
                    : redeemable ? 'redeemable'
                    : pos ? 'open'
                    : 'position_missing';
                const stakeUsd = Number(e?.amountUsd) || 0;
                const realizedPnlUsdc =
                    redeemConfirmed
                        ? (payoutNetUsdc != null ? Number(payoutNetUsdc) - stakeUsd : (paid === false ? 0 - stakeUsd : null))
                        : null;
                return {
                    id: e?.id,
                    timestamp: e?.timestamp,
                    timeframe: '15m',
                    symbol: e?.symbol,
                    slug: e?.slug,
                    title: e?.marketQuestion,
                    conditionId,
                    outcome: e?.outcome,
                    amountUsd: e?.amountUsd,
                    bestAsk: e?.bestAsk ?? e?.price ?? null,
                    limitPrice: e?.limitPrice ?? null,
                    orderId: res0?.orderId ?? res0?.id ?? e?.orderId ?? null,
                    orderStatus: res0?.orderStatus ?? null,
                    filledSize: res0?.filledSize ?? null,
                    result,
                    state,
                    curPrice,
                    cashPnl,
                    percentPnl,
                    redeemable,
                    redeemStatus: normalizedRedeemStatus,
                    paid,
                    payoutNetUsdc,
                    realizedPnlUsdc,
                    txHash,
                };
            });

        const configEvents = this.orderHistory
            .filter((e: any) => {
                const a = String(e?.action || '');
                return a === 'cryptoall2_config_start' || a === 'cryptoall2_config_stop' || a === 'cryptoall2_config_update';
            })
            .slice(0, Math.max(20, maxEntries))
            .map((e: any) => ({
                id: e?.id,
                timestamp: e?.timestamp,
                action: e?.action,
                enabled: e?.config?.enabled ?? null,
                config: e?.config ?? null,
            }));

        const summary = {
            count: items.length,
            totalStakeUsd: items.reduce((s: number, x: any) => s + (Number(x?.amountUsd) || 0), 0),
            pnlTotalUsdc: items.reduce((s: number, x: any) => s + (Number(x?.realizedPnlUsdc) || 0), 0),
            winCount: items.filter((x: any) => x.result === 'WIN').length,
            lossCount: items.filter((x: any) => x.result === 'LOSS').length,
            openCount: items.filter((x: any) => x.result === 'OPEN').length,
            redeemableCount: items.filter((x: any) => x.redeemable === true).length,
            redeemedCount: items.filter((x: any) => x.redeemStatus === 'confirmed' && x.paid === true).length,
        };

        return { success: true, summary, history: items, configEvents, historyPersist: { path: this.orderHistoryPath, lastError: this.orderHistoryPersistLastError } };
    }

    getCryptoAll2StoplossHistory(options?: { maxEntries?: number }) {
        const maxEntries = options?.maxEntries != null ? Math.max(1, Math.floor(Number(options.maxEntries))) : 100;
        const items = this.orderHistory
            .filter((e: any) => e && String(e?.action || '') === 'cryptoall2_stoploss_sell')
            .slice(0, maxEntries)
            .map((e: any) => {
                const r: any = e?.result || null;
                return {
                    id: e?.id,
                    timestamp: e?.timestamp,
                    symbol: e?.symbol,
                    timeframe: e?.timeframe || '15m',
                    conditionId: e?.marketId,
                    tokenId: e?.tokenId,
                    reason: e?.reason,
                    targetPct: e?.targetPct,
                    remainingToSellTarget: e?.remainingToSellTarget ?? null,
                    sellAmount: e?.sellAmount ?? null,
                    secondsToExpire: e?.secondsToExpire ?? null,
                    entryPrice: e?.entryPrice ?? null,
                    currentBid: e?.currentBid ?? null,
                    currentAsk: e?.currentAsk ?? null,
                    success: r?.success === true,
                    skipped: r?.skipped === true,
                    error: r?.error ?? null,
                    method: r?.method ?? null,
                    orderId: r?.orderId ?? r?.id ?? null,
                };
            });
        const summary = {
            count: items.length,
            successCount: items.filter((x: any) => x.success === true).length,
            skippedCount: items.filter((x: any) => x.skipped === true).length,
            failedCount: items.filter((x: any) => x.success !== true && x.skipped !== true).length,
        };
        return { success: true, summary, history: items, historyPersist: { path: this.orderHistoryPath, lastError: this.orderHistoryPersistLastError } };
    }

    getCryptoAllStoplossHistory(options?: { maxEntries?: number }) {
        const maxEntries = options?.maxEntries != null ? Math.max(1, Math.floor(Number(options.maxEntries))) : 100;
        const items = this.orderHistory
            .filter((e: any) => e && String(e?.action || '') === 'cryptoall_stoploss_sell')
            .slice(0, maxEntries)
            .map((e: any) => {
                const r: any = e?.result || null;
                return {
                    id: e?.id,
                    timestamp: e?.timestamp,
                    symbol: e?.symbol,
                    timeframe: e?.timeframe || '15m',
                    conditionId: e?.marketId,
                    tokenId: e?.tokenId,
                    reason: e?.reason,
                    targetPct: e?.targetPct,
                    remainingToSellTarget: e?.remainingToSellTarget ?? null,
                    sellAmount: e?.sellAmount ?? null,
                    secondsToExpire: e?.secondsToExpire ?? null,
                    entryPrice: e?.entryPrice ?? null,
                    currentBid: e?.currentBid ?? null,
                    currentAsk: e?.currentAsk ?? null,
                    success: r?.success === true,
                    skipped: r?.skipped === true,
                    error: r?.error ?? null,
                    method: r?.method ?? null,
                    orderId: r?.orderId ?? r?.id ?? null,
                };
            });
        const summary = {
            count: items.length,
            successCount: items.filter((x: any) => x.success === true).length,
            skippedCount: items.filter((x: any) => x.skipped === true).length,
            failedCount: items.filter((x: any) => x.success !== true && x.skipped !== true).length,
        };
        return { success: true, summary, history: items, historyPersist: { path: this.orderHistoryPath, lastError: this.orderHistoryPersistLastError } };
    }

    getCrypto15mStoplossHistory(options?: { maxEntries?: number }) {
        const maxEntries = options?.maxEntries != null ? Math.max(1, Math.floor(Number(options.maxEntries))) : 100;
        const items = this.orderHistory
            .filter((e: any) => e && String(e?.action || '') === 'crypto15m_stoploss_sell')
            .slice(0, maxEntries)
            .map((e: any) => {
                const r: any = e?.result || null;
                return {
                    id: e?.id,
                    timestamp: e?.timestamp,
                    symbol: e?.symbol,
                    timeframe: e?.timeframe || '15m',
                    conditionId: e?.marketId,
                    tokenId: e?.tokenId,
                    reason: e?.reason,
                    targetPct: e?.targetPct,
                    remainingToSellTarget: e?.remainingToSellTarget ?? null,
                    sellAmount: e?.sellAmount ?? null,
                    secondsToExpire: e?.secondsToExpire ?? null,
                    entryPrice: e?.entryPrice ?? null,
                    currentBid: e?.currentBid ?? null,
                    currentAsk: e?.currentAsk ?? null,
                    success: r?.success === true,
                    skipped: r?.skipped === true,
                    error: r?.error ?? null,
                    method: r?.method ?? null,
                    orderId: r?.orderId ?? r?.id ?? null,
                };
            });
        const summary = {
            count: items.length,
            successCount: items.filter((x: any) => x.success === true).length,
            skippedCount: items.filter((x: any) => x.skipped === true).length,
            failedCount: items.filter((x: any) => x.success !== true && x.skipped !== true).length,
        };
        return { success: true, summary, history: items, historyPersist: { path: this.orderHistoryPath, lastError: this.orderHistoryPersistLastError } };
    }

    async getCryptoAllHistory(options?: { refresh?: boolean; intervalMs?: number; maxEntries?: number; includeSkipped?: boolean }) {
        const refresh = options?.refresh === true;
        const intervalMs = options?.intervalMs != null ? Number(options.intervalMs) : 1000;
        const maxEntries = options?.maxEntries != null ? Math.max(1, Math.floor(Number(options.maxEntries))) : 50;
        const includeSkipped = options?.includeSkipped === true;
        if (refresh) {
            await this.refreshHistoryStatuses({ minIntervalMs: intervalMs, maxEntries: Math.max(50, maxEntries) });
        }
        const funder = this.getFunderAddress();
        const signer = this.tradingClient.getSignerAddress();
        const positions0 = await this.fetchDataApiPositions(funder).catch(() => []);
        const positions1 =
            (!Array.isArray(positions0) || positions0.length === 0) && signer && signer.toLowerCase() !== funder.toLowerCase()
                ? await this.fetchDataApiPositions(signer).catch(() => [])
                : [];
        const positions = (Array.isArray(positions0) ? positions0 : []).concat(Array.isArray(positions1) ? positions1 : []);
        const byCondition = new Map<string, any>();
        for (const p of positions) {
            const k = String(p?.conditionId || '').trim().toLowerCase();
            if (!k) continue;
            const prev = byCondition.get(k);
            if (!prev) { byCondition.set(k, p); continue; }
            const prevScore = Number(prev?.currentValue ?? prev?.size ?? 0);
            const curScore = Number(p?.currentValue ?? p?.size ?? 0);
            if (!Number.isFinite(prevScore) || (Number.isFinite(curScore) && curScore >= prevScore)) {
                byCondition.set(k, p);
            }
        }

        const latestRedeemByCondition = new Map<string, any>();
        for (const e of this.orderHistory) {
            if (!e || String(e?.action || '') !== 'redeem') continue;
            const ts = e?.timestamp ? Date.parse(String(e.timestamp)) : NaN;
            const results = Array.isArray(e?.results) ? e.results : [];
            for (const r of results) {
                const cid = String(r?.conditionId || '').trim();
                if (!cid) continue;
                const key = cid.toLowerCase();
                const prev = latestRedeemByCondition.get(key);
                const prevTs = prev?.__ts != null ? Number(prev.__ts) : NaN;
                const curTs = Number.isFinite(ts) ? ts : Date.now();
                if (!prev || (Number.isFinite(curTs) && (!Number.isFinite(prevTs) || curTs >= prevTs))) {
                    latestRedeemByCondition.set(key, { ...r, __ts: curTs });
                }
            }
        }

        const items = this.orderHistory
            .filter((e: any) => e && String(e?.action || '') === 'cryptoall_order')
            .filter((e: any) => {
                if (includeSkipped) return true;
                const res0 = Array.isArray(e?.results) ? e.results[0] : null;
                const orderStatus = String(res0?.orderStatus || '').toLowerCase();
                if (orderStatus.startsWith('skipped:')) return false;
                const ok = res0?.success === true;
                const orderId = res0?.orderId != null ? String(res0.orderId) : '';
                return ok || !!orderId;
            })
            .slice(0, maxEntries)
            .map((e: any) => {
                const conditionId = String(e?.marketId || '').trim();
                const res0 = Array.isArray(e?.results) ? e.results[0] : null;
                const redeem0 = conditionId ? latestRedeemByCondition.get(conditionId.toLowerCase()) : null;
                const inflight = conditionId ? this.redeemInFlight.get(conditionId) : null;
                const pos = conditionId ? byCondition.get(conditionId.toLowerCase()) : null;
                const curPrice = pos?.curPrice != null ? Number(pos.curPrice) : null;
                const redeemable = pos?.redeemable === true;
                const redeemStatus = String(res0?.redeemStatus || redeem0?.redeemStatus || inflight?.status || '').toLowerCase() || null;
                const paid = (res0?.paid ?? redeem0?.paid ?? inflight?.paid) === true;
                const payoutNetUsdc = (res0?.payoutNetUsdc ?? redeem0?.payoutNetUsdc ?? inflight?.payoutNetUsdc) != null ? Number(res0?.payoutNetUsdc ?? redeem0?.payoutNetUsdc ?? inflight?.payoutNetUsdc) : null;
                const txStatus = (res0?.txStatus ?? redeem0?.txStatus ?? inflight?.txStatus) != null ? Number(res0?.txStatus ?? redeem0?.txStatus ?? inflight?.txStatus) : null;
                const cashPnl = pos?.cashPnl != null ? Number(pos.cashPnl) : null;
                const percentPnl = pos?.percentPnl != null ? Number(pos.percentPnl) : null;
                const txHash = res0?.txHash ?? redeem0?.txHash ?? inflight?.txHash ?? null;
                const normalizedRedeemStatus =
                    redeemStatus === 'failed' && txHash && txStatus != null && txStatus !== 0 && payoutNetUsdc != null && payoutNetUsdc <= 0 && paid === false
                        ? 'confirmed'
                        : redeemStatus;
                const redeemConfirmed = normalizedRedeemStatus === 'confirmed';
                const result =
                    redeemConfirmed && paid === true ? 'WIN'
                    : redeemConfirmed && paid === false ? 'LOSS'
                    : curPrice != null && curPrice >= 0.999 ? 'WIN'
                    : curPrice != null && curPrice <= 0.001 ? 'LOSS'
                    : pos ? 'OPEN'
                    : 'UNKNOWN';
                const state =
                    redeemConfirmed && paid === true ? 'confirmed_paid'
                    : redeemConfirmed && paid === false ? 'confirmed_no_payout'
                    : normalizedRedeemStatus === 'submitted' ? 'redeem_submitted'
                    : normalizedRedeemStatus === 'failed' ? 'redeem_failed'
                    : redeemable ? 'redeemable'
                    : pos ? 'open'
                    : 'position_missing';
                const stakeUsd = Number(e?.amountUsd) || 0;
                const realizedPnlUsdc =
                    redeemConfirmed
                        ? (payoutNetUsdc != null ? Number(payoutNetUsdc) - stakeUsd : (paid === false ? 0 - stakeUsd : null))
                        : null;
                return {
                    id: e?.id,
                    timestamp: e?.timestamp,
                    symbol: e?.symbol,
                    timeframe: e?.timeframe,
                    slug: e?.slug,
                    title: e?.marketQuestion,
                    conditionId,
                    outcome: e?.outcome,
                    amountUsd: e?.amountUsd,
                    bestAsk: e?.bestAsk ?? e?.price ?? null,
                    limitPrice: e?.limitPrice ?? null,
                    orderId: res0?.orderId ?? res0?.id ?? e?.orderId ?? null,
                    orderStatus: res0?.orderStatus ?? null,
                    filledSize: res0?.filledSize ?? null,
                    result,
                    state,
                    curPrice,
                    cashPnl,
                    percentPnl,
                    redeemable,
                    redeemStatus: normalizedRedeemStatus,
                    paid,
                    payoutNetUsdc,
                    realizedPnlUsdc,
                    txHash,
                };
            });

        const summary = {
            count: items.length,
            totalStakeUsd: items.reduce((s: number, x: any) => s + (Number(x?.amountUsd) || 0), 0),
            pnlTotalUsdc: items.reduce((s: number, x: any) => s + (Number(x?.realizedPnlUsdc) || 0), 0),
            winCount: items.filter((x: any) => x.result === 'WIN').length,
            lossCount: items.filter((x: any) => x.result === 'LOSS').length,
            openCount: items.filter((x: any) => x.result === 'OPEN').length,
            redeemableCount: items.filter((x: any) => x.redeemable === true).length,
            redeemedCount: items.filter((x: any) => x.redeemStatus === 'confirmed' && x.paid === true).length,
        };

        return { success: true, summary, history: items, historyPersist: { path: this.orderHistoryPath, lastError: this.orderHistoryPersistLastError } };
    }

    async getCryptoAllReplay(idRaw: any) {
        const id = Math.floor(Number(idRaw));
        if (!Number.isFinite(id) || id <= 0) return { success: false, error: 'invalid_id' };
        const e: any = this.orderHistory.find((x: any) => x && Math.floor(Number(x?.id)) === id && String(x?.action || '') === 'cryptoall_order') || null;
        if (!e) return { success: false, error: 'not_found' };
        const replay = e?.replay ?? null;
        if (!replay) return { success: false, error: 'replay_not_available' };
        const res0 = Array.isArray(e?.results) && e.results.length ? e.results[0] : null;
        return {
            success: true,
            entry: {
                id: e?.id,
                timestamp: e?.timestamp,
                symbol: e?.symbol,
                timeframe: e?.timeframe ?? null,
                conditionId: e?.marketId,
                tokenId: e?.tokenId ?? res0?.tokenId ?? null,
                outcome: e?.outcome ?? null,
                bestAsk: e?.bestAsk ?? e?.price ?? null,
                limitPrice: e?.limitPrice ?? null,
                amountUsd: e?.amountUsd ?? null,
                orderId: res0?.orderId ?? null,
                orderStatus: res0?.orderStatus ?? null,
                filledSize: res0?.filledSize ?? null,
                errorMsg: res0?.errorMsg ?? null,
            },
            replay
        };
    }

    private loadOrderHistoryFromFile() {
        if (!this.orderHistoryPath) return;
        try {
            if (!fs.existsSync(this.orderHistoryPath)) return;
            const raw = fs.readFileSync(this.orderHistoryPath, 'utf8');
            const parsed = JSON.parse(String(raw || '[]'));
            if (!Array.isArray(parsed)) return;
            this.orderHistory = parsed.filter((e: any) => !!e && typeof e === 'object').slice(0, 200);
            this.orderHistoryLoadedAt = new Date().toISOString();
        } catch {
        }
    }

    private persistOrderHistoryToFile() {
        if (!this.orderHistoryPath) return;
        const writeAtomic = (targetPath: string, payload: string) => {
            const dir = path.dirname(targetPath);
            fs.mkdirSync(dir, { recursive: true });
            const bakPath = `${targetPath}.bak`;
            const tmpPath = `${targetPath}.tmp`;
            try {
                if (fs.existsSync(targetPath)) {
                    fs.copyFileSync(targetPath, bakPath);
                    try { fs.chmodSync(bakPath, 0o600); } catch {}
                }
            } catch {
            }
            fs.writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
            try { fs.chmodSync(tmpPath, 0o600); } catch {}
            fs.renameSync(tmpPath, targetPath);
            try { fs.chmodSync(targetPath, 0o600); } catch {}
        };

        try {
            const payload = JSON.stringify(this.orderHistory.slice(0, 200));
            writeAtomic(this.orderHistoryPath, payload);
            this.orderHistoryPersistedAt = new Date().toISOString();
            this.orderHistoryPersistLastError = null;
        } catch (e: any) {
            this.orderHistoryPersistLastError = e?.message ? String(e.message) : 'Failed to write history file';
        }
    }

    private schedulePersistOrderHistory() {
        if (!this.orderHistoryPath) return;
        if (this.orderHistoryPersistTimer) return;
        this.orderHistoryPersistTimer = setTimeout(() => {
            this.orderHistoryPersistTimer = null;
            this.persistOrderHistoryToFile();
        }, 250);
    }

    private recordAutoConfigEvent(strategy: 'crypto15m' | 'cryptoall2' | 'cryptoall', event: 'start' | 'stop', config: any) {
        const action = `${strategy}_config_${event}`;
        this.orderHistory.unshift({
            id: Date.now(),
            timestamp: new Date().toISOString(),
            mode: 'config',
            action,
            strategy,
            config,
        });
        if (this.orderHistory.length > 300) this.orderHistory.pop();
        this.schedulePersistOrderHistory();
    }

    private recordConfigUpdateEvent(strategy: 'crypto15m' | 'cryptoall2' | 'cryptoall', payload: any) {
        const action = `${strategy}_config_update`;
        this.orderHistory.unshift({
            id: Date.now(),
            timestamp: new Date().toISOString(),
            mode: 'config',
            action,
            strategy,
            config: payload,
        });
        if (this.orderHistory.length > 300) this.orderHistory.pop();
        this.schedulePersistOrderHistory();
    }

    private loadCrypto15mAutoConfigFromFile() {
        if (!this.crypto15mAutoConfigPath) return;
        try {
            if (!fs.existsSync(this.crypto15mAutoConfigPath)) return;
            const raw = fs.readFileSync(this.crypto15mAutoConfigPath, 'utf8');
            const parsed = JSON.parse(String(raw || '{}'));
            const next = {
                pollMs: parsed?.pollMs != null ? Number(parsed.pollMs) : this.crypto15mAutoConfig.pollMs,
                expiresWithinSec: parsed?.expiresWithinSec != null ? Number(parsed.expiresWithinSec) : this.crypto15mAutoConfig.expiresWithinSec,
                minProb: parsed?.minProb != null ? Number(parsed.minProb) : this.crypto15mAutoConfig.minProb,
                amountUsd: parsed?.amountUsd != null ? Number(parsed.amountUsd) : this.crypto15mAutoConfig.amountUsd,
                buySizingMode: parsed?.buySizingMode != null ? String(parsed.buySizingMode) : this.crypto15mAutoConfig.buySizingMode,
                sweepEnabled: parsed?.sweepEnabled != null ? !!parsed.sweepEnabled : this.crypto15mAutoConfig.sweepEnabled,
                sweepWindowSec: parsed?.sweepWindowSec != null ? Number(parsed.sweepWindowSec) : this.crypto15mAutoConfig.sweepWindowSec,
                sweepMaxOrdersPerMarket: parsed?.sweepMaxOrdersPerMarket != null ? Number(parsed.sweepMaxOrdersPerMarket) : this.crypto15mAutoConfig.sweepMaxOrdersPerMarket,
                sweepMaxTotalUsdPerMarket: parsed?.sweepMaxTotalUsdPerMarket != null ? Number(parsed.sweepMaxTotalUsdPerMarket) : this.crypto15mAutoConfig.sweepMaxTotalUsdPerMarket,
                sweepMinIntervalMs: parsed?.sweepMinIntervalMs != null ? Number(parsed.sweepMinIntervalMs) : this.crypto15mAutoConfig.sweepMinIntervalMs,
                trendEnabled: parsed?.trendEnabled != null ? !!parsed.trendEnabled : this.crypto15mAutoConfig.trendEnabled,
                trendMinutes: parsed?.trendMinutes != null ? Number(parsed.trendMinutes) : this.crypto15mAutoConfig.trendMinutes,
                staleMsThreshold: parsed?.staleMsThreshold != null ? Number(parsed.staleMsThreshold) : this.crypto15mAutoConfig.staleMsThreshold,
                stoplossEnabled: parsed?.stoplossEnabled != null ? !!parsed.stoplossEnabled : this.crypto15mAutoConfig.stoplossEnabled,
                stoplossCut1DropCents: parsed?.stoplossCut1DropCents != null ? Number(parsed.stoplossCut1DropCents) : this.crypto15mAutoConfig.stoplossCut1DropCents,
                stoplossCut1SellPct: parsed?.stoplossCut1SellPct != null ? Number(parsed.stoplossCut1SellPct) : this.crypto15mAutoConfig.stoplossCut1SellPct,
                stoplossCut2DropCents: parsed?.stoplossCut2DropCents != null ? Number(parsed.stoplossCut2DropCents) : this.crypto15mAutoConfig.stoplossCut2DropCents,
                stoplossCut2SellPct: parsed?.stoplossCut2SellPct != null ? Number(parsed.stoplossCut2SellPct) : this.crypto15mAutoConfig.stoplossCut2SellPct,
                stoplossMinSecToExit: parsed?.stoplossMinSecToExit != null ? Number(parsed.stoplossMinSecToExit) : this.crypto15mAutoConfig.stoplossMinSecToExit,
                adaptiveDeltaEnabled: parsed?.adaptiveDeltaEnabled != null ? !!parsed.adaptiveDeltaEnabled : this.crypto15mAutoConfig.adaptiveDeltaEnabled,
                adaptiveDeltaBigMoveMultiplier: parsed?.adaptiveDeltaBigMoveMultiplier != null ? Number(parsed.adaptiveDeltaBigMoveMultiplier) : this.crypto15mAutoConfig.adaptiveDeltaBigMoveMultiplier,
                adaptiveDeltaRevertNoBuyCount: parsed?.adaptiveDeltaRevertNoBuyCount != null ? Number(parsed.adaptiveDeltaRevertNoBuyCount) : this.crypto15mAutoConfig.adaptiveDeltaRevertNoBuyCount,
            };
            this.crypto15mAutoConfig = {
                pollMs: Math.max(500, Math.floor(Number.isFinite(next.pollMs) ? next.pollMs : 2_000)),
                expiresWithinSec: Math.max(5, Math.floor(Number.isFinite(next.expiresWithinSec) ? next.expiresWithinSec : 180)),
                minProb: Math.max(0, Math.min(1, Number.isFinite(next.minProb) ? next.minProb : 0.9)),
                amountUsd: Math.max(1, Number.isFinite(next.amountUsd) ? next.amountUsd : 1),
                buySizingMode: next.buySizingMode === 'orderbook_max' ? 'orderbook_max' : next.buySizingMode === 'all_capital' ? 'all_capital' : 'fixed',
                sweepEnabled: next.sweepEnabled === true,
                sweepWindowSec: Math.max(0, Math.min(900, Math.floor(Number.isFinite(next.sweepWindowSec) ? next.sweepWindowSec : 30))),
                sweepMaxOrdersPerMarket: Math.max(1, Math.min(200, Math.floor(Number.isFinite(next.sweepMaxOrdersPerMarket) ? next.sweepMaxOrdersPerMarket : 10))),
                sweepMaxTotalUsdPerMarket: Math.max(1, Math.min(50_000, Number.isFinite(next.sweepMaxTotalUsdPerMarket) ? next.sweepMaxTotalUsdPerMarket : 600)),
                sweepMinIntervalMs: Math.max(50, Math.min(30_000, Math.floor(Number.isFinite(next.sweepMinIntervalMs) ? next.sweepMinIntervalMs : 400))),
                trendEnabled: next.trendEnabled,
                trendMinutes: Math.max(1, Math.min(10, Math.floor(Number.isFinite(next.trendMinutes) ? next.trendMinutes : 1))),
                staleMsThreshold: Math.max(500, Math.floor(Number.isFinite(next.staleMsThreshold) ? next.staleMsThreshold : 5_000)),
                stoplossEnabled: next.stoplossEnabled,
                stoplossCut1DropCents: Math.max(0, Math.min(50, Math.floor(Number.isFinite(next.stoplossCut1DropCents) ? next.stoplossCut1DropCents : 1))),
                stoplossCut1SellPct: Math.max(0, Math.min(100, Math.floor(Number.isFinite(next.stoplossCut1SellPct) ? next.stoplossCut1SellPct : 50))),
                stoplossCut2DropCents: Math.max(0, Math.min(50, Math.floor(Number.isFinite(next.stoplossCut2DropCents) ? next.stoplossCut2DropCents : 2))),
                stoplossCut2SellPct: Math.max(0, Math.min(100, Math.floor(Number.isFinite(next.stoplossCut2SellPct) ? next.stoplossCut2SellPct : 100))),
                stoplossMinSecToExit: Math.max(0, Math.min(600, Math.floor(Number.isFinite(next.stoplossMinSecToExit) ? next.stoplossMinSecToExit : 25))),
                adaptiveDeltaEnabled: next.adaptiveDeltaEnabled,
                adaptiveDeltaBigMoveMultiplier: Math.max(1, Math.min(10, Number.isFinite(next.adaptiveDeltaBigMoveMultiplier) ? next.adaptiveDeltaBigMoveMultiplier : 2)),
                adaptiveDeltaRevertNoBuyCount: Math.max(1, Math.min(50, Math.floor(Number.isFinite(next.adaptiveDeltaRevertNoBuyCount) ? next.adaptiveDeltaRevertNoBuyCount : 4))),
            };
            this.crypto15mAutoConfigLoadedAt = new Date().toISOString();
            this.crypto15mAutoConfigPersistLastError = null;
        } catch {
        }
    }

    private persistCrypto15mAutoConfigToFile() {
        if (!this.crypto15mAutoConfigPath) return;
        const writeAtomic = (targetPath: string, payload: string) => {
            const dir = path.dirname(targetPath);
            fs.mkdirSync(dir, { recursive: true });
            const bakPath = `${targetPath}.bak`;
            const tmpPath = `${targetPath}.tmp`;
            try {
                if (fs.existsSync(targetPath)) {
                    fs.copyFileSync(targetPath, bakPath);
                    try { fs.chmodSync(bakPath, 0o600); } catch {}
                }
            } catch {
            }
            fs.writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
            try { fs.chmodSync(tmpPath, 0o600); } catch {}
            fs.renameSync(tmpPath, targetPath);
            try { fs.chmodSync(targetPath, 0o600); } catch {}
        };
        try {
            writeAtomic(this.crypto15mAutoConfigPath, JSON.stringify({ ...this.crypto15mAutoConfig }));
            this.crypto15mAutoConfigPersistedAt = new Date().toISOString();
            this.crypto15mAutoConfigPersistLastError = null;
        } catch (e: any) {
            this.crypto15mAutoConfigPersistLastError = e?.message ? String(e.message) : 'Failed to write crypto15m config file';
        }
    }

    private applyCrypto15mHedgeMode(modeRaw: unknown, overrides?: Partial<{ bufferCents: number; maxSpreadCents: number; minDepthPct: number }>) {
        const m = String(modeRaw || '').toLowerCase();
        const mode: 'conservative' | 'balanced' | 'aggressive' = m === 'conservative' ? 'conservative' : m === 'aggressive' ? 'aggressive' : 'balanced';
        const base =
            mode === 'conservative' ? { bufferCents: 3, maxSpreadCents: 2, minDepthPct: 100 }
            : mode === 'aggressive' ? { bufferCents: 1, maxSpreadCents: 5, minDepthPct: 50 }
            : { bufferCents: 1.5, maxSpreadCents: 3, minDepthPct: 70 };
        const bufferCents = overrides?.bufferCents != null && Number.isFinite(Number(overrides.bufferCents)) ? Number(overrides.bufferCents) : base.bufferCents;
        const maxSpreadCents = overrides?.maxSpreadCents != null && Number.isFinite(Number(overrides.maxSpreadCents)) ? Number(overrides.maxSpreadCents) : base.maxSpreadCents;
        const minDepthPct = overrides?.minDepthPct != null && Number.isFinite(Number(overrides.minDepthPct)) ? Number(overrides.minDepthPct) : base.minDepthPct;
        return { mode, bufferCents, maxSpreadCents, minDepthPct };
    }

    private loadCrypto15mHedgeConfigFromFile() {
        if (!this.crypto15mHedgeConfigPath) return;
        try {
            if (!fs.existsSync(this.crypto15mHedgeConfigPath)) return;
            const raw = fs.readFileSync(this.crypto15mHedgeConfigPath, 'utf8');
            const parsed = JSON.parse(String(raw || '{}'));
            const modeInfo = this.applyCrypto15mHedgeMode(parsed?.mode ?? this.crypto15mHedgeAutoConfig.mode, {
                bufferCents: parsed?.bufferCents,
                maxSpreadCents: parsed?.maxSpreadCents,
                minDepthPct: parsed?.minDepthPct,
            });
            const next = {
                pollMs: parsed?.pollMs != null ? Number(parsed.pollMs) : this.crypto15mHedgeAutoConfig.pollMs,
                expiresWithinSec: parsed?.expiresWithinSec != null ? Number(parsed.expiresWithinSec) : this.crypto15mHedgeAutoConfig.expiresWithinSec,
                minProb: parsed?.minProb != null ? Number(parsed.minProb) : this.crypto15mHedgeAutoConfig.minProb,
                amountUsd: parsed?.amountUsd != null ? Number(parsed.amountUsd) : this.crypto15mHedgeAutoConfig.amountUsd,
                entryRemainingMinSec: parsed?.entryRemainingMinSec != null ? Number(parsed.entryRemainingMinSec) : this.crypto15mHedgeAutoConfig.entryRemainingMinSec,
                entryRemainingMaxSec: parsed?.entryRemainingMaxSec != null ? Number(parsed.entryRemainingMaxSec) : this.crypto15mHedgeAutoConfig.entryRemainingMaxSec,
                entryCheapMinCents: parsed?.entryCheapMinCents != null ? Number(parsed.entryCheapMinCents) : this.crypto15mHedgeAutoConfig.entryCheapMinCents,
                entryCheapMaxCents: parsed?.entryCheapMaxCents != null ? Number(parsed.entryCheapMaxCents) : this.crypto15mHedgeAutoConfig.entryCheapMaxCents,
                targetProfitCents: parsed?.targetProfitCents != null ? Number(parsed.targetProfitCents) : this.crypto15mHedgeAutoConfig.targetProfitCents,
                profitDecayEnabled: parsed?.profitDecayEnabled != null ? !!parsed.profitDecayEnabled : this.crypto15mHedgeAutoConfig.profitDecayEnabled,
                profitDecayMode: parsed?.profitDecayMode != null ? String(parsed.profitDecayMode) : this.crypto15mHedgeAutoConfig.profitDecayMode,
                profitDecayPerMinCents: parsed?.profitDecayPerMinCents != null ? Number(parsed.profitDecayPerMinCents) : this.crypto15mHedgeAutoConfig.profitDecayPerMinCents,
                profitStartCents: parsed?.profitStartCents != null ? Number(parsed.profitStartCents) : this.crypto15mHedgeAutoConfig.profitStartCents,
                profitEndCents: parsed?.profitEndCents != null ? Number(parsed.profitEndCents) : this.crypto15mHedgeAutoConfig.profitEndCents,
                profitDecayStartSec: parsed?.profitDecayStartSec != null ? Number(parsed.profitDecayStartSec) : this.crypto15mHedgeAutoConfig.profitDecayStartSec,
                profitDecayEndSec: parsed?.profitDecayEndSec != null ? Number(parsed.profitDecayEndSec) : this.crypto15mHedgeAutoConfig.profitDecayEndSec,
                profitStepCents: parsed?.profitStepCents != null ? Number(parsed.profitStepCents) : this.crypto15mHedgeAutoConfig.profitStepCents,
                mode: modeInfo.mode,
                bufferCents: modeInfo.bufferCents,
                maxSpreadCents: modeInfo.maxSpreadCents,
                minDepthPct: modeInfo.minDepthPct,
                minSecToHedge: parsed?.minSecToHedge != null ? Number(parsed.minSecToHedge) : this.crypto15mHedgeAutoConfig.minSecToHedge,
                hedgeIgnoreSpread: parsed?.hedgeIgnoreSpread != null ? !!parsed.hedgeIgnoreSpread : this.crypto15mHedgeAutoConfig.hedgeIgnoreSpread,
                panicHedgeEnabled: parsed?.panicHedgeEnabled != null ? !!parsed.panicHedgeEnabled : this.crypto15mHedgeAutoConfig.panicHedgeEnabled,
                panicHedgeStartSec: parsed?.panicHedgeStartSec != null ? Number(parsed.panicHedgeStartSec) : this.crypto15mHedgeAutoConfig.panicHedgeStartSec,
                panicMaxLossCents: parsed?.panicMaxLossCents != null ? Number(parsed.panicMaxLossCents) : this.crypto15mHedgeAutoConfig.panicMaxLossCents,
            };
            const entryRemainingMinSec = Math.max(60, Math.min(900, Math.floor(Number.isFinite(next.entryRemainingMinSec) ? next.entryRemainingMinSec : 480)));
            const entryRemainingMaxSec = Math.max(entryRemainingMinSec, Math.min(900, Math.floor(Number.isFinite(next.entryRemainingMaxSec) ? next.entryRemainingMaxSec : 900)));
            const profitStartCents = Math.max(0, Math.min(30, Number.isFinite(next.profitStartCents) ? Number(next.profitStartCents) : Number(next.targetProfitCents)));
            const profitEndCents = Math.max(0, Math.min(30, Number.isFinite(next.profitEndCents) ? Number(next.profitEndCents) : Math.max(0, profitStartCents - 1)));
            const profitDecayStartSec = Math.max(0, Math.min(900, Math.floor(Number.isFinite(next.profitDecayStartSec) ? Number(next.profitDecayStartSec) : 300)));
            const profitDecayEndSec = Math.max(0, Math.min(900, Math.floor(Number.isFinite(next.profitDecayEndSec) ? Number(next.profitDecayEndSec) : 60)));
            const profitStepCents = Math.max(0.05, Math.min(5, Number.isFinite(next.profitStepCents) ? Number(next.profitStepCents) : 0.1));
            const profitDecayMode: 'linear' | 'per_minute' = String(next.profitDecayMode || '').toLowerCase() === 'per_minute' ? 'per_minute' : 'linear';
            const profitDecayPerMinCents = Math.max(0.05, Math.min(30, Number.isFinite(next.profitDecayPerMinCents) ? Number(next.profitDecayPerMinCents) : 1));
            const panicHedgeEnabled = next.panicHedgeEnabled === true;
            const panicHedgeStartSec = Math.max(0, Math.min(900, Math.floor(Number.isFinite(next.panicHedgeStartSec) ? next.panicHedgeStartSec : 120)));
            const panicMaxLossCents = Math.max(0, Math.min(200, Number.isFinite(next.panicMaxLossCents) ? next.panicMaxLossCents : 20));
            this.crypto15mHedgeAutoConfig = {
                pollMs: Math.max(500, Math.floor(Number.isFinite(next.pollMs) ? next.pollMs : 2_000)),
                expiresWithinSec: 900,
                minProb: Math.max(0, Math.min(1, Number.isFinite(next.minProb) ? next.minProb : 0)),
                amountUsd: Math.max(1, Number.isFinite(next.amountUsd) ? next.amountUsd : 1),
                entryRemainingMinSec,
                entryRemainingMaxSec,
                entryCheapMinCents: Math.max(1, Math.min(49, Number.isFinite(next.entryCheapMinCents) ? next.entryCheapMinCents : 8)),
                entryCheapMaxCents: Math.max(1, Math.min(49, Number.isFinite(next.entryCheapMaxCents) ? next.entryCheapMaxCents : 15)),
                targetProfitCents: Math.max(1, Math.min(30, Number.isFinite(next.targetProfitCents) ? next.targetProfitCents : 10)),
                profitDecayEnabled: next.profitDecayEnabled === true,
                profitDecayMode,
                profitDecayPerMinCents,
                profitStartCents,
                profitEndCents,
                profitDecayStartSec,
                profitDecayEndSec,
                profitStepCents,
                mode: next.mode,
                bufferCents: Math.max(0, Math.min(10, Number.isFinite(next.bufferCents) ? next.bufferCents : 1.5)),
                maxSpreadCents: Math.max(0, Math.min(50, Math.floor(Number.isFinite(next.maxSpreadCents) ? next.maxSpreadCents : 3))),
                minDepthPct: Math.max(0, Math.min(100, Math.floor(Number.isFinite(next.minDepthPct) ? next.minDepthPct : 70))),
                minSecToHedge: Math.max(0, Math.min(900, Math.floor(Number.isFinite(next.minSecToHedge) ? next.minSecToHedge : 90))),
                hedgeIgnoreSpread: next.hedgeIgnoreSpread === true,
                panicHedgeEnabled,
                panicHedgeStartSec,
                panicMaxLossCents,
            };
            this.crypto15mHedgeConfigLoadedAt = new Date().toISOString();
            this.crypto15mHedgeConfigPersistLastError = null;
        } catch {
        }
    }

    private persistCrypto15mHedgeConfigToFile() {
        if (!this.crypto15mHedgeConfigPath) return;
        const writeAtomic = (targetPath: string, payload: string) => {
            const dir = path.dirname(targetPath);
            fs.mkdirSync(dir, { recursive: true });
            const bakPath = `${targetPath}.bak`;
            const tmpPath = `${targetPath}.tmp`;
            try {
                if (fs.existsSync(targetPath)) {
                    fs.copyFileSync(targetPath, bakPath);
                    try { fs.chmodSync(bakPath, 0o600); } catch {}
                }
            } catch {
            }
            fs.writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
            try { fs.chmodSync(tmpPath, 0o600); } catch {}
            fs.renameSync(tmpPath, targetPath);
            try { fs.chmodSync(targetPath, 0o600); } catch {}
        };
        try {
            writeAtomic(this.crypto15mHedgeConfigPath, JSON.stringify({ ...this.crypto15mHedgeAutoConfig }));
            this.crypto15mHedgeConfigPersistedAt = new Date().toISOString();
            this.crypto15mHedgeConfigPersistLastError = null;
        } catch (e: any) {
            this.crypto15mHedgeConfigPersistLastError = e?.message ? String(e.message) : 'Failed to write crypto15m-hedge config file';
        }
    }

    private loadCryptoAll2AutoConfigFromFile() {
        if (!this.cryptoAll2AutoConfigPath) return;
        try {
            if (!fs.existsSync(this.cryptoAll2AutoConfigPath)) {
                const legacyPath = path.join(os.tmpdir(), 'polymarket-tools', 'cryptoall2-config.json');
                if (fs.existsSync(legacyPath)) {
                    this.cryptoAll2AutoConfigPath = legacyPath;
                } else {
                    return;
                }
            }
            const raw = fs.readFileSync(this.cryptoAll2AutoConfigPath, 'utf8');
            const parsed = JSON.parse(String(raw || '{}'));
            const symInput: any[] = Array.isArray(parsed?.symbols) ? (parsed.symbols as any[]) : [];
            const symbols: string[] = symInput.length
                ? Array.from(new Set(symInput.map((s: any) => String(s || '').toUpperCase()).filter((x: any): x is string => !!x)))
                : this.cryptoAll2AutoConfig.symbols;
            const next = {
                pollMs: parsed?.pollMs != null ? Number(parsed.pollMs) : this.cryptoAll2AutoConfig.pollMs,
                expiresWithinSec: parsed?.expiresWithinSec != null ? Number(parsed.expiresWithinSec) : this.cryptoAll2AutoConfig.expiresWithinSec,
                minProb: parsed?.minProb != null ? Number(parsed.minProb) : this.cryptoAll2AutoConfig.minProb,
                amountUsd: parsed?.amountUsd != null ? Number(parsed.amountUsd) : this.cryptoAll2AutoConfig.amountUsd,
                symbols,
                dojiGuardEnabled: parsed?.dojiGuardEnabled != null ? !!parsed.dojiGuardEnabled : this.cryptoAll2AutoConfig.dojiGuardEnabled,
                riskSkipScore: parsed?.riskSkipScore != null ? Number(parsed.riskSkipScore) : this.cryptoAll2AutoConfig.riskSkipScore,
                splitBuyEnabled: parsed?.splitBuyEnabled != null ? !!parsed.splitBuyEnabled : this.cryptoAll2AutoConfig.splitBuyEnabled,
                splitBuyPct3m: parsed?.splitBuyPct3m != null ? Number(parsed.splitBuyPct3m) : this.cryptoAll2AutoConfig.splitBuyPct3m,
                splitBuyPct2m: parsed?.splitBuyPct2m != null ? Number(parsed.splitBuyPct2m) : this.cryptoAll2AutoConfig.splitBuyPct2m,
                splitBuyPct1m: parsed?.splitBuyPct1m != null ? Number(parsed.splitBuyPct1m) : this.cryptoAll2AutoConfig.splitBuyPct1m,
                splitBuyTrendEnabled: parsed?.splitBuyTrendEnabled != null ? !!parsed.splitBuyTrendEnabled : this.cryptoAll2AutoConfig.splitBuyTrendEnabled,
                splitBuyTrendMinutes3m: parsed?.splitBuyTrendMinutes3m != null ? Number(parsed.splitBuyTrendMinutes3m) : this.cryptoAll2AutoConfig.splitBuyTrendMinutes3m,
                splitBuyTrendMinutes2m: parsed?.splitBuyTrendMinutes2m != null ? Number(parsed.splitBuyTrendMinutes2m) : this.cryptoAll2AutoConfig.splitBuyTrendMinutes2m,
                splitBuyTrendMinutes1m: parsed?.splitBuyTrendMinutes1m != null ? Number(parsed.splitBuyTrendMinutes1m) : this.cryptoAll2AutoConfig.splitBuyTrendMinutes1m,
                stoplossEnabled: parsed?.stoplossEnabled != null ? !!parsed.stoplossEnabled : this.cryptoAll2AutoConfig.stoplossEnabled,
                stoplossCut1DropCents: parsed?.stoplossCut1DropCents != null ? Number(parsed.stoplossCut1DropCents) : this.cryptoAll2AutoConfig.stoplossCut1DropCents,
                stoplossCut1SellPct: parsed?.stoplossCut1SellPct != null ? Number(parsed.stoplossCut1SellPct) : this.cryptoAll2AutoConfig.stoplossCut1SellPct,
                stoplossCut2DropCents: parsed?.stoplossCut2DropCents != null ? Number(parsed.stoplossCut2DropCents) : this.cryptoAll2AutoConfig.stoplossCut2DropCents,
                stoplossCut2SellPct: parsed?.stoplossCut2SellPct != null ? Number(parsed.stoplossCut2SellPct) : this.cryptoAll2AutoConfig.stoplossCut2SellPct,
                stoplossMinSecToExit: parsed?.stoplossMinSecToExit != null ? Number(parsed.stoplossMinSecToExit) : this.cryptoAll2AutoConfig.stoplossMinSecToExit,
                adaptiveDeltaEnabled: parsed?.adaptiveDeltaEnabled != null ? !!parsed.adaptiveDeltaEnabled : this.cryptoAll2AutoConfig.adaptiveDeltaEnabled,
                adaptiveDeltaBigMoveMultiplier: parsed?.adaptiveDeltaBigMoveMultiplier != null ? Number(parsed.adaptiveDeltaBigMoveMultiplier) : this.cryptoAll2AutoConfig.adaptiveDeltaBigMoveMultiplier,
                adaptiveDeltaRevertNoBuyCount: parsed?.adaptiveDeltaRevertNoBuyCount != null ? Number(parsed.adaptiveDeltaRevertNoBuyCount) : this.cryptoAll2AutoConfig.adaptiveDeltaRevertNoBuyCount,
            };
            this.cryptoAll2AutoConfig = {
                pollMs: Math.max(500, Math.floor(Number.isFinite(next.pollMs) ? next.pollMs : 2_000)),
                expiresWithinSec: Math.max(5, Math.floor(Number.isFinite(next.expiresWithinSec) ? next.expiresWithinSec : 180)),
                minProb: Math.max(0, Math.min(1, Number.isFinite(next.minProb) ? next.minProb : 0.9)),
                amountUsd: Math.max(1, Number.isFinite(next.amountUsd) ? next.amountUsd : 1),
                symbols,
                dojiGuardEnabled: next.dojiGuardEnabled,
                riskSkipScore: Math.max(0, Math.min(100, Math.floor(Number.isFinite(next.riskSkipScore) ? next.riskSkipScore : 70))),
                splitBuyEnabled: next.splitBuyEnabled,
                splitBuyPct3m: Math.max(0, Math.min(1000, Math.floor(Number.isFinite(next.splitBuyPct3m) ? next.splitBuyPct3m : 34))),
                splitBuyPct2m: Math.max(0, Math.min(1000, Math.floor(Number.isFinite(next.splitBuyPct2m) ? next.splitBuyPct2m : 33))),
                splitBuyPct1m: Math.max(0, Math.min(1000, Math.floor(Number.isFinite(next.splitBuyPct1m) ? next.splitBuyPct1m : 33))),
                splitBuyTrendEnabled: next.splitBuyTrendEnabled,
                splitBuyTrendMinutes3m: Math.max(1, Math.min(10, Math.floor(Number.isFinite(next.splitBuyTrendMinutes3m) ? next.splitBuyTrendMinutes3m : 3))),
                splitBuyTrendMinutes2m: Math.max(1, Math.min(10, Math.floor(Number.isFinite(next.splitBuyTrendMinutes2m) ? next.splitBuyTrendMinutes2m : 2))),
                splitBuyTrendMinutes1m: Math.max(1, Math.min(10, Math.floor(Number.isFinite(next.splitBuyTrendMinutes1m) ? next.splitBuyTrendMinutes1m : 1))),
                stoplossEnabled: next.stoplossEnabled,
                stoplossCut1DropCents: Math.max(0, Math.min(50, Math.floor(Number.isFinite(next.stoplossCut1DropCents) ? next.stoplossCut1DropCents : 1))),
                stoplossCut1SellPct: Math.max(0, Math.min(100, Math.floor(Number.isFinite(next.stoplossCut1SellPct) ? next.stoplossCut1SellPct : 50))),
                stoplossCut2DropCents: Math.max(0, Math.min(50, Math.floor(Number.isFinite(next.stoplossCut2DropCents) ? next.stoplossCut2DropCents : 2))),
                stoplossCut2SellPct: Math.max(0, Math.min(100, Math.floor(Number.isFinite(next.stoplossCut2SellPct) ? next.stoplossCut2SellPct : 100))),
                stoplossMinSecToExit: Math.max(0, Math.min(600, Math.floor(Number.isFinite(next.stoplossMinSecToExit) ? next.stoplossMinSecToExit : 25))),
                adaptiveDeltaEnabled: next.adaptiveDeltaEnabled,
                adaptiveDeltaBigMoveMultiplier: Math.max(1, Math.min(10, Number.isFinite(next.adaptiveDeltaBigMoveMultiplier) ? next.adaptiveDeltaBigMoveMultiplier : 2)),
                adaptiveDeltaRevertNoBuyCount: Math.max(1, Math.min(50, Math.floor(Number.isFinite(next.adaptiveDeltaRevertNoBuyCount) ? next.adaptiveDeltaRevertNoBuyCount : 4))),
            };
            this.cryptoAll2AutoConfigLoadedAt = new Date().toISOString();
            this.cryptoAll2AutoConfigPersistLastError = null;
        } catch {
        }
    }

    private loadCryptoAllAutoConfigFromFile() {
        if (!this.cryptoAllAutoConfigPath) return;
        try {
            if (!fs.existsSync(this.cryptoAllAutoConfigPath)) {
                const legacyPath = path.join(os.tmpdir(), 'polymarket-tools', 'cryptoall-config.json');
                if (fs.existsSync(legacyPath)) {
                    this.cryptoAllAutoConfigPath = legacyPath;
                } else {
                    return;
                }
            }
            const raw = fs.readFileSync(this.cryptoAllAutoConfigPath, 'utf8');
            const parsed = JSON.parse(String(raw || '{}'));
            const symInput: any[] = Array.isArray(parsed?.symbols) ? (parsed.symbols as any[]) : [];
            const symbols: string[] = symInput.length
                ? Array.from(new Set(symInput.map((s: any) => String(s || '').toUpperCase()).filter((x: any): x is string => !!x)))
                : this.cryptoAllAutoConfig.symbols;
            const tfInput: any[] = Array.isArray(parsed?.timeframes) ? (parsed.timeframes as any[]) : [];
            const timeframesRaw = tfInput.length
                ? tfInput.map((x: any) => String(x || '').toLowerCase()).filter(Boolean)
                : Array.isArray(this.cryptoAllAutoConfig.timeframes) && this.cryptoAllAutoConfig.timeframes.length ? this.cryptoAllAutoConfig.timeframes : ['15m'];
            const timeframes = Array.from(new Set(timeframesRaw)).filter((t) => ['5m', '15m', '1h', '4h', '1d'].includes(String(t))) as Array<'5m' | '15m' | '1h' | '4h' | '1d'>;
            const dojiGuardEnabledRaw =
                parsed?.dojiGuardEnabled != null ? !!parsed.dojiGuardEnabled
                : parsed?.dojiGuard?.enabled != null ? !!parsed.dojiGuard.enabled
                : this.cryptoAllAutoConfig.dojiGuardEnabled;
            const riskSkipScoreRaw =
                parsed?.riskSkipScore != null ? Number(parsed.riskSkipScore)
                : parsed?.dojiGuard?.riskSkipScore != null ? Number(parsed.dojiGuard.riskSkipScore)
                : this.cryptoAllAutoConfig.riskSkipScore;
            const riskAddOnBlockScoreRaw =
                parsed?.riskAddOnBlockScore != null ? Number(parsed.riskAddOnBlockScore)
                : parsed?.dojiGuard?.riskAddOnBlockScore != null ? Number(parsed.dojiGuard.riskAddOnBlockScore)
                : this.cryptoAllAutoConfig.dojiGuard.riskAddOnBlockScore;
            const addOnEnabledRaw =
                parsed?.addOnEnabled != null ? !!parsed.addOnEnabled
                : parsed?.addOn?.enabled != null ? !!parsed.addOn.enabled
                : this.cryptoAllAutoConfig.addOn.enabled;
            const stoplossEnabledRaw =
                parsed?.stoplossEnabled != null ? !!parsed.stoplossEnabled
                : parsed?.stoploss?.enabled != null ? !!parsed.stoploss.enabled
                : this.cryptoAllAutoConfig.stoploss.enabled;
            const expiresWithinSecByTimeframeRaw = (parsed?.expiresWithinSecByTimeframe && typeof parsed.expiresWithinSecByTimeframe === 'object') ? parsed.expiresWithinSecByTimeframe : null;
            const next = {
                pollMs: parsed?.pollMs != null ? Number(parsed.pollMs) : this.cryptoAllAutoConfig.pollMs,
                expiresWithinSec: parsed?.expiresWithinSec != null ? Number(parsed.expiresWithinSec) : this.cryptoAllAutoConfig.expiresWithinSec,
                expiresWithinSecByTimeframe: (['5m', '15m', '1h', '4h', '1d'] as const).reduce((acc: any, tf) => {
                    const v = expiresWithinSecByTimeframeRaw && (expiresWithinSecByTimeframeRaw as any)[tf] != null ? Number((expiresWithinSecByTimeframeRaw as any)[tf]) : (parsed?.expiresWithinSec != null ? Number(parsed.expiresWithinSec) : this.cryptoAllAutoConfig.expiresWithinSec);
                    acc[tf] = Math.max(5, Math.floor(Number.isFinite(v) ? v : this.cryptoAllAutoConfig.expiresWithinSec));
                    return acc;
                }, {}),
                minProb: parsed?.minProb != null ? Number(parsed.minProb) : this.cryptoAllAutoConfig.minProb,
                amountUsd: parsed?.amountUsd != null ? Number(parsed.amountUsd) : this.cryptoAllAutoConfig.amountUsd,
                symbols,
                timeframes,
                dojiGuardEnabled: dojiGuardEnabledRaw,
                riskSkipScore: riskSkipScoreRaw,
                riskAddOnBlockScore: riskAddOnBlockScoreRaw,
                addOnEnabled: addOnEnabledRaw,
                splitBuyEnabled: parsed?.splitBuyEnabled != null ? !!parsed.splitBuyEnabled : this.cryptoAllAutoConfig.splitBuyEnabled,
                splitBuyPct3m: parsed?.splitBuyPct3m != null ? Number(parsed.splitBuyPct3m) : this.cryptoAllAutoConfig.splitBuyPct3m,
                splitBuyPct2m: parsed?.splitBuyPct2m != null ? Number(parsed.splitBuyPct2m) : this.cryptoAllAutoConfig.splitBuyPct2m,
                splitBuyPct1m: parsed?.splitBuyPct1m != null ? Number(parsed.splitBuyPct1m) : this.cryptoAllAutoConfig.splitBuyPct1m,
                splitBuyTrendEnabled: parsed?.splitBuyTrendEnabled != null ? !!parsed.splitBuyTrendEnabled : this.cryptoAllAutoConfig.splitBuyTrendEnabled,
                splitBuyTrendMinutes3m: parsed?.splitBuyTrendMinutes3m != null ? Number(parsed.splitBuyTrendMinutes3m) : this.cryptoAllAutoConfig.splitBuyTrendMinutes3m,
                splitBuyTrendMinutes2m: parsed?.splitBuyTrendMinutes2m != null ? Number(parsed.splitBuyTrendMinutes2m) : this.cryptoAllAutoConfig.splitBuyTrendMinutes2m,
                splitBuyTrendMinutes1m: parsed?.splitBuyTrendMinutes1m != null ? Number(parsed.splitBuyTrendMinutes1m) : this.cryptoAllAutoConfig.splitBuyTrendMinutes1m,
                stoplossEnabled: stoplossEnabledRaw,
                stoplossCut1DropCents: parsed?.stoplossCut1DropCents != null ? Number(parsed.stoplossCut1DropCents) : (parsed?.stoploss?.cut1DropCents != null ? Number(parsed.stoploss.cut1DropCents) : this.cryptoAllAutoConfig.stoplossCut1DropCents),
                stoplossCut1SellPct: parsed?.stoplossCut1SellPct != null ? Number(parsed.stoplossCut1SellPct) : (parsed?.stoploss?.cut1SellPct != null ? Number(parsed.stoploss.cut1SellPct) : this.cryptoAllAutoConfig.stoplossCut1SellPct),
                stoplossCut2DropCents: parsed?.stoplossCut2DropCents != null ? Number(parsed.stoplossCut2DropCents) : (parsed?.stoploss?.cut2DropCents != null ? Number(parsed.stoploss.cut2DropCents) : this.cryptoAllAutoConfig.stoplossCut2DropCents),
                stoplossCut2SellPct: parsed?.stoplossCut2SellPct != null ? Number(parsed.stoplossCut2SellPct) : (parsed?.stoploss?.cut2SellPct != null ? Number(parsed.stoploss.cut2SellPct) : this.cryptoAllAutoConfig.stoplossCut2SellPct),
                stoplossSpreadGuardCents: parsed?.stoplossSpreadGuardCents != null ? Number(parsed.stoplossSpreadGuardCents) : (parsed?.stoploss?.spreadGuardCents != null ? Number(parsed.stoploss.spreadGuardCents) : this.cryptoAllAutoConfig.stoploss.spreadGuardCents),
                stoplossMinSecToExit: parsed?.stoplossMinSecToExit != null ? Number(parsed.stoplossMinSecToExit) : (parsed?.stoploss?.minSecToExit != null ? Number(parsed.stoploss.minSecToExit) : this.cryptoAllAutoConfig.stoplossMinSecToExit),
                adaptiveDeltaEnabled: parsed?.adaptiveDeltaEnabled != null ? !!parsed.adaptiveDeltaEnabled : this.cryptoAllAutoConfig.adaptiveDeltaEnabled,
                adaptiveDeltaBigMoveMultiplier: parsed?.adaptiveDeltaBigMoveMultiplier != null ? Number(parsed.adaptiveDeltaBigMoveMultiplier) : this.cryptoAllAutoConfig.adaptiveDeltaBigMoveMultiplier,
                adaptiveDeltaRevertNoBuyCount: parsed?.adaptiveDeltaRevertNoBuyCount != null ? Number(parsed.adaptiveDeltaRevertNoBuyCount) : this.cryptoAllAutoConfig.adaptiveDeltaRevertNoBuyCount,
            };
            this.cryptoAllAutoConfig = {
                pollMs: Math.max(500, Math.floor(Number.isFinite(next.pollMs) ? next.pollMs : 2_000)),
                expiresWithinSec: Math.max(5, Math.floor(Number.isFinite(next.expiresWithinSec) ? next.expiresWithinSec : 180)),
                expiresWithinSecByTimeframe: (next as any).expiresWithinSecByTimeframe,
                minProb: Math.max(0, Math.min(1, Number.isFinite(next.minProb) ? next.minProb : 0.9)),
                amountUsd: Math.max(1, Number.isFinite(next.amountUsd) ? next.amountUsd : 1),
                symbols,
                timeframes: timeframes.length ? timeframes : ['15m'],
                dojiGuard: {
                    enabled: next.dojiGuardEnabled,
                    riskSkipScore: Math.max(0, Math.min(100, Math.floor(Number.isFinite(next.riskSkipScore) ? next.riskSkipScore : 70))),
                    riskAddOnBlockScore: Math.max(0, Math.min(100, Math.floor(Number.isFinite(next.riskAddOnBlockScore) ? next.riskAddOnBlockScore : 50))),
                },
                addOn: {
                    ...this.cryptoAllAutoConfig.addOn,
                    enabled: next.addOnEnabled,
                },
                stoploss: {
                    enabled: next.stoplossEnabled,
                    cut1DropCents: Math.max(0, Math.min(50, Math.floor(Number.isFinite(next.stoplossCut1DropCents) ? next.stoplossCut1DropCents : 1))),
                    cut1SellPct: Math.max(0, Math.min(100, Math.floor(Number.isFinite(next.stoplossCut1SellPct) ? next.stoplossCut1SellPct : 50))),
                    cut2DropCents: Math.max(0, Math.min(50, Math.floor(Number.isFinite(next.stoplossCut2DropCents) ? next.stoplossCut2DropCents : 2))),
                    cut2SellPct: Math.max(0, Math.min(100, Math.floor(Number.isFinite(next.stoplossCut2SellPct) ? next.stoplossCut2SellPct : 100))),
                    spreadGuardCents: Math.max(0, Math.min(50, Math.floor(Number.isFinite(next.stoplossSpreadGuardCents) ? next.stoplossSpreadGuardCents : 2))),
                    minSecToExit: Math.max(0, Math.min(600, Math.floor(Number.isFinite(next.stoplossMinSecToExit) ? next.stoplossMinSecToExit : 25))),
                },
                dojiGuardEnabled: next.dojiGuardEnabled,
                riskSkipScore: Math.max(0, Math.min(100, Math.floor(Number.isFinite(next.riskSkipScore) ? next.riskSkipScore : 70))),
                splitBuyEnabled: next.splitBuyEnabled,
                splitBuyPct3m: Math.max(0, Math.min(1000, Math.floor(Number.isFinite(next.splitBuyPct3m) ? next.splitBuyPct3m : 34))),
                splitBuyPct2m: Math.max(0, Math.min(1000, Math.floor(Number.isFinite(next.splitBuyPct2m) ? next.splitBuyPct2m : 33))),
                splitBuyPct1m: Math.max(0, Math.min(1000, Math.floor(Number.isFinite(next.splitBuyPct1m) ? next.splitBuyPct1m : 33))),
                splitBuyTrendEnabled: next.splitBuyTrendEnabled,
                splitBuyTrendMinutes3m: Math.max(1, Math.min(10, Math.floor(Number.isFinite(next.splitBuyTrendMinutes3m) ? next.splitBuyTrendMinutes3m : 3))),
                splitBuyTrendMinutes2m: Math.max(1, Math.min(10, Math.floor(Number.isFinite(next.splitBuyTrendMinutes2m) ? next.splitBuyTrendMinutes2m : 2))),
                splitBuyTrendMinutes1m: Math.max(1, Math.min(10, Math.floor(Number.isFinite(next.splitBuyTrendMinutes1m) ? next.splitBuyTrendMinutes1m : 1))),
                stoplossEnabled: next.stoplossEnabled,
                stoplossCut1DropCents: Math.max(0, Math.min(50, Math.floor(Number.isFinite(next.stoplossCut1DropCents) ? next.stoplossCut1DropCents : 1))),
                stoplossCut1SellPct: Math.max(0, Math.min(100, Math.floor(Number.isFinite(next.stoplossCut1SellPct) ? next.stoplossCut1SellPct : 50))),
                stoplossCut2DropCents: Math.max(0, Math.min(50, Math.floor(Number.isFinite(next.stoplossCut2DropCents) ? next.stoplossCut2DropCents : 2))),
                stoplossCut2SellPct: Math.max(0, Math.min(100, Math.floor(Number.isFinite(next.stoplossCut2SellPct) ? next.stoplossCut2SellPct : 100))),
                stoplossMinSecToExit: Math.max(0, Math.min(600, Math.floor(Number.isFinite(next.stoplossMinSecToExit) ? next.stoplossMinSecToExit : 25))),
                adaptiveDeltaEnabled: next.adaptiveDeltaEnabled,
                adaptiveDeltaBigMoveMultiplier: Math.max(1, Math.min(10, Number.isFinite(next.adaptiveDeltaBigMoveMultiplier) ? next.adaptiveDeltaBigMoveMultiplier : 2)),
                adaptiveDeltaRevertNoBuyCount: Math.max(1, Math.min(50, Math.floor(Number.isFinite(next.adaptiveDeltaRevertNoBuyCount) ? next.adaptiveDeltaRevertNoBuyCount : 4))),
            };
            this.cryptoAllAutoConfigLoadedAt = new Date().toISOString();
            this.cryptoAllAutoConfigPersistLastError = null;
        } catch {
        }
    }

    private persistCryptoAll2AutoConfigToFile() {
        if (!this.cryptoAll2AutoConfigPath) return;
        const writeAtomic = (targetPath: string, payload: string) => {
            const dir = path.dirname(targetPath);
            fs.mkdirSync(dir, { recursive: true });
            const bakPath = `${targetPath}.bak`;
            const tmpPath = `${targetPath}.tmp`;
            try {
                if (fs.existsSync(targetPath)) {
                    fs.copyFileSync(targetPath, bakPath);
                    try { fs.chmodSync(bakPath, 0o600); } catch {}
                }
            } catch {
            }
            fs.writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
            try { fs.chmodSync(tmpPath, 0o600); } catch {}
            fs.renameSync(tmpPath, targetPath);
            try { fs.chmodSync(targetPath, 0o600); } catch {}
        };
        try {
            writeAtomic(this.cryptoAll2AutoConfigPath, JSON.stringify({ ...this.cryptoAll2AutoConfig }));
            this.cryptoAll2AutoConfigPersistedAt = new Date().toISOString();
            this.cryptoAll2AutoConfigPersistLastError = null;
        } catch (e: any) {
            this.cryptoAll2AutoConfigPersistLastError = e?.message ? String(e.message) : 'Failed to write cryptoall2 config file';
        }
    }

    private persistCryptoAllAutoConfigToFile() {
        if (!this.cryptoAllAutoConfigPath) return;
        const writeAtomic = (targetPath: string, payload: string) => {
            const dir = path.dirname(targetPath);
            fs.mkdirSync(dir, { recursive: true });
            const bakPath = `${targetPath}.bak`;
            const tmpPath = `${targetPath}.tmp`;
            try {
                if (fs.existsSync(targetPath)) {
                    fs.copyFileSync(targetPath, bakPath);
                    try { fs.chmodSync(bakPath, 0o600); } catch {}
                }
            } catch {
            }
            fs.writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
            try { fs.chmodSync(tmpPath, 0o600); } catch {}
            fs.renameSync(tmpPath, targetPath);
            try { fs.chmodSync(targetPath, 0o600); } catch {}
        };
        try {
            writeAtomic(this.cryptoAllAutoConfigPath, JSON.stringify({ ...this.cryptoAllAutoConfig }));
            this.cryptoAllAutoConfigPersistedAt = new Date().toISOString();
            this.cryptoAllAutoConfigPersistLastError = null;
        } catch (e: any) {
            this.cryptoAllAutoConfigPersistLastError = e?.message ? String(e.message) : 'Failed to write cryptoall config file';
        }
    }

    async getMonitoredPositionsSummary(): Promise<any[]> {
        const summaries: any[] = [];

        const lastMetaForMarket = (marketId: string) => {
            for (const e of this.orderHistory) {
                if (String(e?.marketId || '') === marketId) {
                    return { slug: e?.slug, question: e?.marketQuestion };
                }
            }
            return { slug: undefined, question: undefined };
        };

        for (const [marketId, pos] of this.monitoredPositions) {
            const yesFilled = Number(pos.legs?.yes?.filledSize ?? 0) > 0;
            const noFilled = Number(pos.legs?.no?.filledSize ?? 0) > 0;
            const filledLeg = yesFilled ? pos.legs.yes : (noFilled ? pos.legs.no : null);

            const meta = lastMetaForMarket(marketId);
            const base: any = {
                marketId,
                mode: pos.mode,
                status: pos.status,
                createdAt: new Date(pos.createdAt).toISOString(),
                ageMinutes: Math.max(0, (Date.now() - pos.createdAt) / 60000),
                slug: meta.slug,
                question: meta.question,
                filledLeg: filledLeg?.outcome || null,
            };

            if (!filledLeg) {
                summaries.push(base);
                continue;
            }

            try {
                const ob = await this.sdk.clobApi.getOrderbook(filledLeg.tokenId);
                const bestBid = Number(ob?.bids?.[0]?.price) || 0;
                const bestAsk = Number(ob?.asks?.[0]?.price) || 0;
                const mid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : (bestBid || bestAsk);
                const spreadCents = bestBid > 0 && bestAsk > 0 ? (bestAsk - bestBid) * 100 : 0;

                const entryPrice = Number(filledLeg.entryPrice || mid || 0);
                const peakMid = Number(filledLeg.peakMid || mid || 0);

                const cutLossTrigger = entryPrice > 0 ? entryPrice * (1 - pos.settings.cutLossPercent / 100) : null;
                const trailingTrigger = peakMid > 0 ? peakMid * (1 - pos.settings.trailingStopPercent / 100) : null;
                const forceTrigger = peakMid > 0 ? peakMid * (1 - pos.settings.forceMarketExitFromPeakPercent / 100) : null;

                summaries.push({
                    ...base,
                    entryPrice,
                    peakMid,
                    mid: mid || null,
                    spreadCents: Number.isFinite(spreadCents) ? spreadCents : null,
                    cutLossTrigger,
                    trailingTrigger,
                    forceTrigger,
                    remark: pos.status === 'one_leg_filled' ? 'one_leg_risk' : null,
                });
            } catch {
                summaries.push(base);
            }
        }

        return summaries;
    }

    private async fetchDataApiPositions(user: string): Promise<any[]> {
        const u = String(user || '').trim();
        if (!u) return [];
        const key = u.toLowerCase();
        const now = Date.now();
        const ttlMs = 15_000;
        const cached = this.dataApiPositionsCache.get(key) || null;
        if (cached && (now - cached.atMs) < ttlMs) return cached.data;
        const inflight = this.dataApiPositionsInFlight.get(key) || null;
        if (inflight) return await inflight;
        const url = `https://data-api.polymarket.com/positions?user=${encodeURIComponent(u)}`;
        const headers: any = {
            'accept': 'application/json, text/plain, */*',
            'user-agent': 'Mozilla/5.0 (compatible; polymarket-tools/1.0)',
        };
        const tryOnce = async () => {
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), 2_000);
            const res = await fetch(url, { headers, signal: controller.signal }).finally(() => clearTimeout(t));
            if (!res.ok) throw new Error(`Data API positions failed (${res.status})`);
            const data = await this.withTimeout(res.json().catch(() => [] as any), 2_000, 'Data API positions json');
            return Array.isArray(data) ? data : [];
        };
        const run = (async () => {
            try {
                const data = await this.withTimeout(tryOnce(), 2_500, 'Data API positions');
                this.dataApiPositionsCache.set(key, { atMs: Date.now(), data });
                while (this.dataApiPositionsCache.size > 100) {
                    const k = this.dataApiPositionsCache.keys().next().value;
                    if (!k) break;
                    this.dataApiPositionsCache.delete(k);
                }
                return data;
            } catch {
                await new Promise(r => setTimeout(r, 300));
                try {
                    const data = await this.withTimeout(tryOnce(), 2_500, 'Data API positions retry');
                    this.dataApiPositionsCache.set(key, { atMs: Date.now(), data });
                    while (this.dataApiPositionsCache.size > 100) {
                        const k = this.dataApiPositionsCache.keys().next().value;
                        if (!k) break;
                        this.dataApiPositionsCache.delete(k);
                    }
                    return data;
                } catch {
                    return cached ? cached.data : [];
                }
            }
        })().finally(() => {
            this.dataApiPositionsInFlight.delete(key);
        });
        this.dataApiPositionsInFlight.set(key, run);
        return await run;
    }

    private async fetchDataApiPositionsValue(user: string): Promise<number> {
        const u = String(user || '').trim();
        if (!u) return 0;
        const key = u.toLowerCase();
        const now = Date.now();
        const ttlMs = 15_000;
        const cached = this.dataApiValueCache.get(key) || null;
        if (cached && (now - cached.atMs) < ttlMs) return cached.value;
        const inflight = this.dataApiValueInFlight.get(key) || null;
        if (inflight) return await inflight;
        const url = `https://data-api.polymarket.com/value?user=${encodeURIComponent(u)}`;
        const headers: any = {
            'accept': 'application/json, text/plain, */*',
            'user-agent': 'Mozilla/5.0 (compatible; polymarket-tools/1.0)',
        };
        const tryOnce = async () => {
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), 2_000);
            const res = await fetch(url, { headers, signal: controller.signal }).finally(() => clearTimeout(t));
            if (!res.ok) throw new Error(`Data API value failed (${res.status})`);
            const data = await this.withTimeout(res.json().catch(() => [] as any), 2_000, 'Data API value json');
            const first = Array.isArray(data) ? data[0] : null;
            const v = Number(first?.value ?? 0);
            return Number.isFinite(v) ? v : 0;
        };
        try {
            const run = (async () => {
                try {
                    const v = await this.withTimeout(tryOnce(), 2_500, 'Data API value');
                    this.dataApiValueCache.set(key, { atMs: Date.now(), value: v });
                    while (this.dataApiValueCache.size > 100) {
                        const k = this.dataApiValueCache.keys().next().value;
                        if (!k) break;
                        this.dataApiValueCache.delete(k);
                    }
                    return v;
                } catch {
                    await new Promise(r => setTimeout(r, 300));
                    try {
                        const v = await this.withTimeout(tryOnce(), 2_500, 'Data API value retry');
                        this.dataApiValueCache.set(key, { atMs: Date.now(), value: v });
                        while (this.dataApiValueCache.size > 100) {
                            const k = this.dataApiValueCache.keys().next().value;
                            if (!k) break;
                            this.dataApiValueCache.delete(k);
                        }
                        return v;
                    } catch {
                        return cached ? cached.value : 0;
                    }
                }
            })().finally(() => {
                this.dataApiValueInFlight.delete(key);
            });
            this.dataApiValueInFlight.set(key, run);
            return await run;
        } catch {
            return cached ? cached.value : 0;
        }
    }

    private shouldRotateRpc(e: any): boolean {
        const msg = String(e?.message || e || '');
        return msg.includes('Too many requests')
            || msg.includes('rate limit')
            || msg.includes('-32090')
            || msg.includes('429')
            || msg.includes('noNetwork')
            || msg.includes('NETWORK_ERROR')
            || msg.includes('ENOTFOUND')
            || msg.includes('getaddrinfo')
            || msg.includes('missing response');
    }

    private createRpcProvider(rpcUrl: string): ethers.providers.JsonRpcProvider {
        return new ethers.providers.StaticJsonRpcProvider(rpcUrl, { chainId: 137, name: 'matic' } as any);
    }

    private rotateRpcUrl(): string {
        if (!this.rpcUrls.length) return process.env.POLY_CTF_RPC_URL || process.env.POLY_RPC_URL || 'https://polygon-rpc.com';
        this.rpcIndex = (this.rpcIndex + 1) % this.rpcUrls.length;
        const rpcUrl = this.rpcUrls[this.rpcIndex];
        try {
            this.redeemProvider = this.createRpcProvider(rpcUrl);
            if (this.redeemWallet) this.redeemWallet = this.redeemWallet.connect(this.redeemProvider);
            if (this.hasValidKey) {
                this.ctf = new CTFClient({ privateKey: this.rpcPrivateKey, rpcUrl, chainId: 137 } as any);
                const account = privateKeyToAccount(this.rpcPrivateKey as Hex);
                this.relayerWalletClient = createWalletClient({
                    account,
                    chain: polygon,
                    transport: http(rpcUrl),
                });
            }
        } catch {
        }
        return rpcUrl;
    }

    private async withRpcRetry<T>(fn: () => Promise<T>): Promise<T> {
        try {
            return await fn();
        } catch (e: any) {
            if (!this.shouldRotateRpc(e)) throw e;
            this.rotateRpcUrl();
            return await fn();
        }
    }

    private async fetchErc20Balance(tokenAddress: string, address: string): Promise<number> {
        const a = String(address || '').trim();
        const t = String(tokenAddress || '').trim();
        if (!a || !t) return 0;
        const erc20Abi = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'];
        const [bal, dec] = await this.withRpcRetry(async () => {
            const provider = this.redeemProvider || this.createRpcProvider(process.env.POLY_CTF_RPC_URL || process.env.POLY_RPC_URL || 'https://polygon-rpc.com');
            const c = new ethers.Contract(t, erc20Abi, provider);
            return await Promise.all([c.balanceOf(a), c.decimals()]);
        });
        const decimals = Number(dec);
        const value = Number(ethers.utils.formatUnits(bal, Number.isFinite(decimals) ? decimals : 6));
        return Number.isFinite(value) ? value : 0;
    }

    private async fetchUsdcBalance(address: string): Promise<number> {
        const USDCe_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
        return this.fetchErc20Balance(USDCe_ADDRESS, address);
    }

    private async fetchStableBalances(address: string): Promise<{ usdc: number; usdcE: number; total: number }> {
        const USDCe_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
        const USDC_ADDRESS = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
        const [usdcE, usdc] = await Promise.all([
            this.fetchErc20Balance(USDCe_ADDRESS, address).catch(() => 0),
            this.fetchErc20Balance(USDC_ADDRESS, address).catch(() => 0),
        ]);
        const total = Number(usdcE) + Number(usdc);
        return { usdc: Number(usdc) || 0, usdcE: Number(usdcE) || 0, total: Number.isFinite(total) ? total : 0 };
    }

    private async computeUsdcTransfersFromTxHash(txHash: string, options?: { recipients?: string[] }): Promise<{ totalUsdc: number; transfers: Array<{ token: string; from: string; to: string; amount: number }>; recipients: string[]; receivedUsdc: number; sentUsdc: number; netUsdc: number; txStatus: number | null }> {
        const hash = String(txHash || '').trim();
        if (!hash) return { totalUsdc: 0, transfers: [], recipients: [], receivedUsdc: 0, sentUsdc: 0, netUsdc: 0, txStatus: null };
        const USDCe_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
        const USDC_ADDRESS = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
        const receipt: any = await this.withRpcRetry(() => {
            const provider = this.redeemProvider || this.createRpcProvider(process.env.POLY_CTF_RPC_URL || process.env.POLY_RPC_URL || 'https://polygon-rpc.com');
            return provider.getTransactionReceipt(hash);
        });
        const txStatusRaw = receipt?.status;
        const txStatus = txStatusRaw === '0x1' ? 1 : txStatusRaw === '0x0' ? 0 : Number.isFinite(Number(txStatusRaw)) ? Number(txStatusRaw) : null;
        const logs: any[] = Array.isArray(receipt?.logs) ? receipt.logs : [];
        const iface = new ethers.utils.Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
        const topic0 = iface.getEventTopic('Transfer');
        const transfers: Array<{ token: string; from: string; to: string; amount: number }> = [];
        let totalUsdc = 0;
        const isAddress = (v: string) => /^0x[a-fA-F0-9]{40}$/.test(String(v || '').trim());
        const recipients = Array.from(new Set(((options?.recipients && options.recipients.length) ? options.recipients : [this.getFunderAddress()])
            .map((a) => String(a || '').trim())
            .filter((a) => !!a && isAddress(a))
            .map((a) => a.toLowerCase())));
        const recipientsSet = new Set(recipients);
        let receivedUsdc = 0;
        let sentUsdc = 0;
        for (const log of logs) {
            const addr = String(log?.address || '').toLowerCase();
            const token =
                addr === USDCe_ADDRESS.toLowerCase() ? 'USDCe' :
                addr === USDC_ADDRESS.toLowerCase() ? 'USDC' :
                null;
            if (!token) continue;
            const topics: any[] = Array.isArray(log?.topics) ? log.topics : [];
            if (!topics.length || String(topics[0]).toLowerCase() !== String(topic0).toLowerCase()) continue;
            try {
                const parsed = iface.parseLog(log);
                const from = String(parsed?.args?.from || '');
                const to = String(parsed?.args?.to || '');
                const value = parsed?.args?.value;
                const amount = Number(ethers.utils.formatUnits(value, 6));
                if (!Number.isFinite(amount) || amount <= 0) continue;
                transfers.push({ token, from, to, amount });
                totalUsdc += amount;
                if (recipientsSet.size) {
                    const fromLc = String(from || '').toLowerCase();
                    const toLc = String(to || '').toLowerCase();
                    if (recipientsSet.has(toLc)) receivedUsdc += amount;
                    if (recipientsSet.has(fromLc)) sentUsdc += amount;
                }
            } catch {
            }
        }
        const netUsdc = recipientsSet.size ? (receivedUsdc - sentUsdc) : totalUsdc;
        return { totalUsdc, transfers, recipients, receivedUsdc, sentUsdc, netUsdc, txStatus };
    }

    private async getRedeemParentCollectionId(conditionId: string): Promise<string> {
        return ethers.constants.HashZero;
    }

    private async resolveMarketMeta(conditionId: string): Promise<{ title?: string; slug?: string; eventSlug?: string }> {
        const id = String(conditionId || '').trim();
        if (!id) return {};
        const cached = this.marketMetaCache.get(id);
        if (cached) return cached;
        const url = `https://data-api.polymarket.com/trades?market=${encodeURIComponent(id)}&limit=1`;
        const res = await fetch(url);
        if (!res.ok) return {};
        const data = await res.json().catch(() => []);
        const first = Array.isArray(data) ? data[0] : null;
        const meta = {
            title: first?.title ? String(first.title) : undefined,
            slug: first?.slug ? String(first.slug) : undefined,
            eventSlug: first?.eventSlug ? String(first.eventSlug) : undefined,
        };
        this.marketMetaCache.set(id, meta);
        return meta;
    }

    async getPortfolioSummary(options?: { positionsLimit?: number }) {
        const funder = this.getFunderAddress();
        const positionsLimit = Math.max(1, Math.floor(Number(options?.positionsLimit ?? 50)));
        const [positions, positionsValue] = await Promise.all([
            this.fetchDataApiPositions(funder),
            this.fetchDataApiPositionsValue(funder),
        ]);
        const list = Array.isArray(positions) ? positions : [];
        const isAddress = (v: string) => /^0x[a-fA-F0-9]{40}$/.test(String(v || '').trim());
        const proxyWallets = Array.from(new Set(list
            .map((p: any) => String(p?.proxyWallet || '').trim())
            .filter((a) => !!a && isAddress(a))))
            .filter((a) => a.toLowerCase() !== funder.toLowerCase())
            .slice(0, 5);
        const cashWallets = [funder, ...proxyWallets];
        const balances = await Promise.all(cashWallets.map(async (address) => {
            const b = await this.fetchStableBalances(address).catch(() => ({ usdc: 0, usdcE: 0, total: 0 }));
            return { address, usdc: Number(b.usdc) || 0, usdcE: Number(b.usdcE) || 0, total: Number(b.total) || 0 };
        }));
        const cash = balances.reduce((s, b) => s + (Number(b.total) || 0), 0);
        const cashUsdc = balances.reduce((s, b) => s + (Number(b.usdc) || 0), 0);
        const cashUsdcE = balances.reduce((s, b) => s + (Number(b.usdcE) || 0), 0);
        const claimable = list.filter((p: any) => !!p?.redeemable && p?.conditionId && !this.isRedeemConfirmed(String(p.conditionId)));
        const topPositions = list.slice(0, positionsLimit);
        const portfolioValue = Number(positionsValue) + Number(cash);
        return {
            funder,
            portfolioValue,
            cash,
            cashUsdc,
            cashUsdcE,
            cashWallets: balances,
            positionsValue,
            claimableCount: claimable.length,
            positions: topPositions,
        };
    }

    private async isLikelyGnosisSafe(address: string): Promise<boolean> {
        const a = String(address || '').trim();
        if (!a || !/^0x[a-fA-F0-9]{40}$/.test(a)) return false;
        const provider = this.redeemProvider || this.createRpcProvider(process.env.POLY_CTF_RPC_URL || process.env.POLY_RPC_URL || 'https://polygon-rpc.com');
        const code = await this.withRpcRetry(() => provider.getCode(a)).catch(() => '');
        if (!code || code === '0x') return false;
        const safeAbi = ['function nonce() view returns (uint256)'];
        const safe = new ethers.Contract(a, safeAbi, provider);
        try {
            await this.withRpcRetry(() => safe.nonce());
            return true;
        } catch {
            return false;
        }
    }

    private async getMaticBalance(address: string): Promise<number> {
        const a = String(address || '').trim();
        if (!a || !/^0x[a-fA-F0-9]{40}$/.test(a)) return 0;
        const provider = this.redeemProvider || this.createRpcProvider(process.env.POLY_CTF_RPC_URL || process.env.POLY_RPC_URL || 'https://polygon-rpc.com');
        const wei = await this.withRpcRetry(() => provider.getBalance(a)).catch(() => ethers.BigNumber.from(0));
        return Number(ethers.utils.formatEther(wei));
    }

    private async ensureOwnerHasGas(minMatic: number): Promise<void> {
        const owner = this.redeemWallet?.address;
        if (!owner) throw new Error('Redeem wallet not configured');
        const bal = await this.getMaticBalance(owner);
        if (bal >= minMatic) return;
        throw new Error(`Owner wallet needs MATIC for onchain proxy tx. owner=${owner} balance=${bal} minRequired=${minMatic}`);
    }

    private async redeemViaSafe(proxyWallet: string, conditionId: string): Promise<string> {
        if (!this.redeemWallet) throw new Error('Redeem wallet not configured');
        const safeAddress = String(proxyWallet || '').trim();
        if (!safeAddress) throw new Error('Missing proxy wallet');
        await this.ensureOwnerHasGas(0.02);

        const CTF_ADDRESS = '0x4d97dcd97ec945f40cf65f87097ace5ea0476045';
        const USDCe_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
        const parentCollectionId = await this.getRedeemParentCollectionId(conditionId);
        const redeemInterface = new ethers.utils.Interface([
            'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)'
        ]);
        const redeemData = redeemInterface.encodeFunctionData('redeemPositions', [
            USDCe_ADDRESS,
            parentCollectionId,
            conditionId,
            [1, 2],
        ]);

        const safeAbi = [
            'function nonce() view returns (uint256)',
            'function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 _nonce) view returns (bytes32)',
            'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool success)',
        ];
        return await this.withRpcRetry(async () => {
            if (!this.redeemWallet) throw new Error('Redeem wallet not configured');
            const safe = new ethers.Contract(safeAddress, safeAbi, this.redeemWallet);
            const nonce = await safe.nonce();
            const safeTxHash = await safe.getTransactionHash(
                CTF_ADDRESS,
                0,
                redeemData,
                0,
                0,
                0,
                0,
                ethers.constants.AddressZero,
                ethers.constants.AddressZero,
                nonce
            );
            const sig = this.redeemWallet._signingKey().signDigest(safeTxHash);
            const signatures = ethers.utils.joinSignature(sig);
            const tx = await safe.execTransaction(
                CTF_ADDRESS,
                0,
                redeemData,
                0,
                0,
                0,
                0,
                ethers.constants.AddressZero,
                ethers.constants.AddressZero,
                signatures
            );
            const receipt = await tx.wait();
            return receipt.transactionHash;
        });
    }

    private async redeemViaPolymarketProxy(proxyWallet: string, conditionId: string): Promise<string> {
        if (!this.redeemWallet) throw new Error('Redeem wallet not configured');
        const proxyAddress = String(proxyWallet || '').trim();
        if (!proxyAddress) throw new Error('Missing proxy wallet');
        await this.ensureOwnerHasGas(0.02);

        const CTF_ADDRESS = '0x4d97dcd97ec945f40cf65f87097ace5ea0476045';
        const USDCe_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
        const parentCollectionId = await this.getRedeemParentCollectionId(conditionId);
        const redeemInterface = new ethers.utils.Interface([
            'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)'
        ]);
        const redeemData = redeemInterface.encodeFunctionData('redeemPositions', [
            USDCe_ADDRESS,
            parentCollectionId,
            conditionId,
            [1, 2],
        ]);

        const proxyAbi = [
            'function proxy(tuple(address to, bytes data, uint256 value)[] calls) payable returns (bytes[] returnValues)'
        ];
        return await this.withRpcRetry(async () => {
            if (!this.redeemWallet) throw new Error('Redeem wallet not configured');
            const proxy = new ethers.Contract(proxyAddress, proxyAbi, this.redeemWallet);
            const tx = await proxy.proxy([{ to: CTF_ADDRESS, data: redeemData, value: 0 }]);
            const receipt = await tx.wait();
            return receipt.transactionHash;
        });
    }

    getAutoRedeemStatus() {
        return {
            config: this.autoRedeemConfig,
            last: this.autoRedeemLast,
            nextAt: this.autoRedeemNextAt,
            lastError: this.autoRedeemLastError,
            drainRunning: this.redeemDrainRunning,
            drainLast: this.redeemDrainLast,
            inFlight: { count: this.redeemInFlight.size },
            funder: this.getFunderAddress(),
            owner: this.redeemWallet?.address,
            relayerConfigured: this.relayerConfigured,
            configPath: this.autoRedeemConfigPath || null,
            configFilePresent: this.autoRedeemConfigPath ? fs.existsSync(this.autoRedeemConfigPath) : false,
            configLoadedAt: this.autoRedeemConfigLoadedAt,
            configPersistedAt: this.autoRedeemConfigPersistedAt,
            configPersistLastError: this.autoRedeemConfigPersistLastError,
            historyPath: this.orderHistoryPath || null,
            historyFilePresent: this.orderHistoryPath ? fs.existsSync(this.orderHistoryPath) : false,
            historyLoadedAt: this.orderHistoryLoadedAt,
            historyPersistedAt: this.orderHistoryPersistedAt,
            historyPersistLastError: this.orderHistoryPersistLastError,
        };
    }

    private loadAutoRedeemConfigFromFile() {
        if (!this.autoRedeemConfigPath) return;
        try {
            if (!fs.existsSync(this.autoRedeemConfigPath)) return;
            const raw = fs.readFileSync(this.autoRedeemConfigPath, 'utf8');
            const parsed = JSON.parse(String(raw || '{}'));
            const enabled = parsed?.enabled != null ? !!parsed.enabled : false;
            const maxPerCycle = parsed?.maxPerCycle != null ? Number(parsed.maxPerCycle) : 20;
            this.autoRedeemConfigLoadedAt = new Date().toISOString();
            this.setAutoRedeemConfig({ enabled, maxPerCycle, persist: false });
        } catch {
        }
    }

    private persistAutoRedeemConfigToFile() {
        if (!this.autoRedeemConfigPath) return;
        const dir = path.dirname(this.autoRedeemConfigPath);
        try {
            fs.mkdirSync(dir, { recursive: true });
        } catch (e: any) {
            this.autoRedeemConfigPersistLastError = e?.message ? String(e.message) : 'Failed to create auto redeem config dir';
            return;
        }
        try {
            fs.writeFileSync(
                this.autoRedeemConfigPath,
                JSON.stringify({ enabled: this.autoRedeemConfig.enabled, maxPerCycle: this.autoRedeemConfig.maxPerCycle, pollMs: this.autoRedeemConfig.intervalMs }),
                { encoding: 'utf8', mode: 0o600 }
            );
            try { fs.chmodSync(this.autoRedeemConfigPath, 0o600); } catch {}
            this.autoRedeemConfigPersistedAt = new Date().toISOString();
            this.autoRedeemConfigPersistLastError = null;
        } catch (e: any) {
            this.autoRedeemConfigPersistLastError = e?.message ? String(e.message) : 'Failed to write auto redeem config file';
        }
    }

    getCrypto15mDeltaThresholds() {
        return {
            btcMinDelta: this.crypto15mDeltaThresholds.btcMinDelta,
            ethMinDelta: this.crypto15mDeltaThresholds.ethMinDelta,
            solMinDelta: this.crypto15mDeltaThresholds.solMinDelta,
            xrpMinDelta: this.crypto15mDeltaThresholds.xrpMinDelta,
            updatedAt: this.crypto15mDeltaThresholds.updatedAt,
            loadedAt: this.crypto15mDeltaThresholds.loadedAt,
            persistLastError: this.crypto15mDeltaThresholds.persistLastError,
            configPath: this.crypto15mDeltaThresholdsPath,
            configFilePresent: this.crypto15mDeltaThresholdsPath ? fs.existsSync(this.crypto15mDeltaThresholdsPath) : false,
        };
    }

    setCrypto15mDeltaThresholds(input: { btcMinDelta?: number; ethMinDelta?: number; solMinDelta?: number; xrpMinDelta?: number; persist?: boolean }) {
        const btc = input.btcMinDelta != null ? Number(input.btcMinDelta) : this.crypto15mDeltaThresholds.btcMinDelta;
        const eth = input.ethMinDelta != null ? Number(input.ethMinDelta) : this.crypto15mDeltaThresholds.ethMinDelta;
        const sol = input.solMinDelta != null ? Number(input.solMinDelta) : this.crypto15mDeltaThresholds.solMinDelta;
        const xrp = input.xrpMinDelta != null ? Number(input.xrpMinDelta) : this.crypto15mDeltaThresholds.xrpMinDelta;
        this.crypto15mDeltaThresholds = {
            ...this.crypto15mDeltaThresholds,
            btcMinDelta: Math.max(0, btc),
            ethMinDelta: Math.max(0, eth),
            solMinDelta: Math.max(0, sol),
            xrpMinDelta: Math.max(0, xrp),
            updatedAt: new Date().toISOString(),
            persistLastError: null,
        };
        if (input.persist !== false) {
            this.persistCrypto15mDeltaThresholdsToFile();
            this.recordConfigUpdateEvent('crypto15m', { kind: 'delta_thresholds', thresholds: { btcMinDelta: this.crypto15mDeltaThresholds.btcMinDelta, ethMinDelta: this.crypto15mDeltaThresholds.ethMinDelta, solMinDelta: this.crypto15mDeltaThresholds.solMinDelta, xrpMinDelta: this.crypto15mDeltaThresholds.xrpMinDelta } });
        }
        return this.getCrypto15mDeltaThresholds();
    }

    private loadCrypto15mDeltaThresholdsFromFile() {
        if (!this.crypto15mDeltaThresholdsPath) return;
        try {
            if (!fs.existsSync(this.crypto15mDeltaThresholdsPath)) return;
            const raw = fs.readFileSync(this.crypto15mDeltaThresholdsPath, 'utf8');
            const parsed = JSON.parse(String(raw || '{}'));
            const btcMinDelta = parsed?.btcMinDelta != null ? Number(parsed.btcMinDelta) : this.crypto15mDeltaThresholds.btcMinDelta;
            const ethMinDelta = parsed?.ethMinDelta != null ? Number(parsed.ethMinDelta) : this.crypto15mDeltaThresholds.ethMinDelta;
            const solMinDelta = parsed?.solMinDelta != null ? Number(parsed.solMinDelta) : this.crypto15mDeltaThresholds.solMinDelta;
            const xrpMinDelta = parsed?.xrpMinDelta != null ? Number(parsed.xrpMinDelta) : this.crypto15mDeltaThresholds.xrpMinDelta;
            this.crypto15mDeltaThresholds = {
                ...this.crypto15mDeltaThresholds,
                btcMinDelta: Number.isFinite(btcMinDelta) ? Math.max(0, btcMinDelta) : this.crypto15mDeltaThresholds.btcMinDelta,
                ethMinDelta: Number.isFinite(ethMinDelta) ? Math.max(0, ethMinDelta) : this.crypto15mDeltaThresholds.ethMinDelta,
                solMinDelta: Number.isFinite(solMinDelta) ? Math.max(0, solMinDelta) : this.crypto15mDeltaThresholds.solMinDelta,
                xrpMinDelta: Number.isFinite(xrpMinDelta) ? Math.max(0, xrpMinDelta) : this.crypto15mDeltaThresholds.xrpMinDelta,
                loadedAt: new Date().toISOString(),
                persistLastError: null,
            };
        } catch {
        }
    }

    private persistCrypto15mDeltaThresholdsToFile() {
        if (!this.crypto15mDeltaThresholdsPath) return;
        const dir = path.dirname(this.crypto15mDeltaThresholdsPath);
        try {
            fs.mkdirSync(dir, { recursive: true });
        } catch (e: any) {
            this.crypto15mDeltaThresholds.persistLastError = e?.message ? String(e.message) : 'Failed to create crypto15m delta thresholds dir';
            return;
        }
        try {
            fs.writeFileSync(
                this.crypto15mDeltaThresholdsPath,
                JSON.stringify({ btcMinDelta: this.crypto15mDeltaThresholds.btcMinDelta, ethMinDelta: this.crypto15mDeltaThresholds.ethMinDelta, solMinDelta: this.crypto15mDeltaThresholds.solMinDelta, xrpMinDelta: this.crypto15mDeltaThresholds.xrpMinDelta }),
                { encoding: 'utf8', mode: 0o600 }
            );
            try { fs.chmodSync(this.crypto15mDeltaThresholdsPath, 0o600); } catch {}
            this.crypto15mDeltaThresholds.persistLastError = null;
        } catch (e: any) {
            this.crypto15mDeltaThresholds.persistLastError = e?.message ? String(e.message) : 'Failed to write crypto15m delta thresholds file';
        }
    }

    getCryptoAll2DeltaThresholds() {
        return {
            btcMinDelta: this.cryptoAll2DeltaThresholds.btcMinDelta,
            ethMinDelta: this.cryptoAll2DeltaThresholds.ethMinDelta,
            solMinDelta: this.cryptoAll2DeltaThresholds.solMinDelta,
            xrpMinDelta: this.cryptoAll2DeltaThresholds.xrpMinDelta,
            updatedAt: this.cryptoAll2DeltaThresholds.updatedAt,
            loadedAt: this.cryptoAll2DeltaThresholds.loadedAt,
            persistLastError: this.cryptoAll2DeltaThresholds.persistLastError,
            configPath: this.cryptoAll2DeltaThresholdsPath,
            configFilePresent: this.cryptoAll2DeltaThresholdsPath ? fs.existsSync(this.cryptoAll2DeltaThresholdsPath) : false,
        };
    }

    setCryptoAll2DeltaThresholds(input: { btcMinDelta?: number; ethMinDelta?: number; solMinDelta?: number; xrpMinDelta?: number; persist?: boolean }) {
        const btc = input.btcMinDelta != null ? Number(input.btcMinDelta) : this.cryptoAll2DeltaThresholds.btcMinDelta;
        const eth = input.ethMinDelta != null ? Number(input.ethMinDelta) : this.cryptoAll2DeltaThresholds.ethMinDelta;
        const sol = input.solMinDelta != null ? Number(input.solMinDelta) : this.cryptoAll2DeltaThresholds.solMinDelta;
        const xrp = input.xrpMinDelta != null ? Number(input.xrpMinDelta) : this.cryptoAll2DeltaThresholds.xrpMinDelta;
        this.cryptoAll2DeltaThresholds = {
            ...this.cryptoAll2DeltaThresholds,
            btcMinDelta: Math.max(0, btc),
            ethMinDelta: Math.max(0, eth),
            solMinDelta: Math.max(0, sol),
            xrpMinDelta: Math.max(0, xrp),
            updatedAt: new Date().toISOString(),
            persistLastError: null,
        };
        if (input.persist !== false) {
            this.persistCryptoAll2DeltaThresholdsToFile();
            this.recordConfigUpdateEvent('cryptoall2', { kind: 'delta_thresholds', thresholds: { btcMinDelta: this.cryptoAll2DeltaThresholds.btcMinDelta, ethMinDelta: this.cryptoAll2DeltaThresholds.ethMinDelta, solMinDelta: this.cryptoAll2DeltaThresholds.solMinDelta, xrpMinDelta: this.cryptoAll2DeltaThresholds.xrpMinDelta } });
        }
        return this.getCryptoAll2DeltaThresholds();
    }

    private loadCryptoAll2DeltaThresholdsFromFile() {
        if (!this.cryptoAll2DeltaThresholdsPath) return;
        try {
            if (!fs.existsSync(this.cryptoAll2DeltaThresholdsPath)) return;
            const raw = fs.readFileSync(this.cryptoAll2DeltaThresholdsPath, 'utf8');
            const parsed = JSON.parse(String(raw || '{}'));
            const btcMinDelta = parsed?.btcMinDelta != null ? Number(parsed.btcMinDelta) : this.cryptoAll2DeltaThresholds.btcMinDelta;
            const ethMinDelta = parsed?.ethMinDelta != null ? Number(parsed.ethMinDelta) : this.cryptoAll2DeltaThresholds.ethMinDelta;
            const solMinDelta = parsed?.solMinDelta != null ? Number(parsed.solMinDelta) : this.cryptoAll2DeltaThresholds.solMinDelta;
            const xrpMinDelta = parsed?.xrpMinDelta != null ? Number(parsed.xrpMinDelta) : this.cryptoAll2DeltaThresholds.xrpMinDelta;
            this.cryptoAll2DeltaThresholds = {
                ...this.cryptoAll2DeltaThresholds,
                btcMinDelta: Number.isFinite(btcMinDelta) ? Math.max(0, btcMinDelta) : this.cryptoAll2DeltaThresholds.btcMinDelta,
                ethMinDelta: Number.isFinite(ethMinDelta) ? Math.max(0, ethMinDelta) : this.cryptoAll2DeltaThresholds.ethMinDelta,
                solMinDelta: Number.isFinite(solMinDelta) ? Math.max(0, solMinDelta) : this.cryptoAll2DeltaThresholds.solMinDelta,
                xrpMinDelta: Number.isFinite(xrpMinDelta) ? Math.max(0, xrpMinDelta) : this.cryptoAll2DeltaThresholds.xrpMinDelta,
                loadedAt: new Date().toISOString(),
                persistLastError: null,
            };
        } catch {
        }
    }

    private persistCryptoAll2DeltaThresholdsToFile() {
        if (!this.cryptoAll2DeltaThresholdsPath) return;
        const dir = path.dirname(this.cryptoAll2DeltaThresholdsPath);
        try {
            fs.mkdirSync(dir, { recursive: true });
        } catch (e: any) {
            this.cryptoAll2DeltaThresholds.persistLastError = e?.message ? String(e.message) : 'Failed to create cryptoall2 delta thresholds dir';
            return;
        }
        try {
            fs.writeFileSync(
                this.cryptoAll2DeltaThresholdsPath,
                JSON.stringify({ btcMinDelta: this.cryptoAll2DeltaThresholds.btcMinDelta, ethMinDelta: this.cryptoAll2DeltaThresholds.ethMinDelta, solMinDelta: this.cryptoAll2DeltaThresholds.solMinDelta, xrpMinDelta: this.cryptoAll2DeltaThresholds.xrpMinDelta }),
                { encoding: 'utf8', mode: 0o600 }
            );
            try { fs.chmodSync(this.cryptoAll2DeltaThresholdsPath, 0o600); } catch {}
            this.cryptoAll2DeltaThresholds.persistLastError = null;
        } catch (e: any) {
            this.cryptoAll2DeltaThresholds.persistLastError = e?.message ? String(e.message) : 'Failed to write cryptoall2 delta thresholds file';
        }
    }

    getCryptoAllDeltaThresholds() {
        const legacy = this.cryptoAllDeltaThresholds.legacy || { btcMinDelta: 0, ethMinDelta: 0, solMinDelta: 0, xrpMinDelta: 0 };
        return {
            btcMinDelta: legacy.btcMinDelta,
            ethMinDelta: legacy.ethMinDelta,
            solMinDelta: legacy.solMinDelta,
            xrpMinDelta: legacy.xrpMinDelta,
            legacy,
            byTimeframe: this.cryptoAllDeltaThresholds.byTimeframe,
            updatedAt: this.cryptoAllDeltaThresholds.updatedAt,
            loadedAt: this.cryptoAllDeltaThresholds.loadedAt,
            persistLastError: this.cryptoAllDeltaThresholds.persistLastError,
            configPath: this.cryptoAllDeltaThresholdsPath,
            configFilePresent: this.cryptoAllDeltaThresholdsPath ? fs.existsSync(this.cryptoAllDeltaThresholdsPath) : false,
        };
    }

    private getCryptoAllMinDeltaRequired(symbol: string, timeframe: '5m' | '15m' | '1h' | '4h' | '1d'): number {
        const sym = String(symbol || '').toUpperCase();
        const tf = String(timeframe || '').toLowerCase() as any;
        const legacy = this.cryptoAllDeltaThresholds.legacy || { btcMinDelta: 0, ethMinDelta: 0, solMinDelta: 0, xrpMinDelta: 0 };
        const byTf = (this.cryptoAllDeltaThresholds.byTimeframe && (this.cryptoAllDeltaThresholds.byTimeframe as any)[tf]) ? (this.cryptoAllDeltaThresholds.byTimeframe as any)[tf] : null;
        const src = byTf && typeof byTf === 'object' ? byTf : legacy;
        if (sym === 'BTC') return Number(src.btcMinDelta) || 0;
        if (sym === 'ETH') return Number(src.ethMinDelta) || 0;
        if (sym === 'SOL') return Number(src.solMinDelta) || 0;
        if (sym === 'XRP') return Number(src.xrpMinDelta) || 0;
        return 0;
    }

    setCryptoAllDeltaThresholds(input: { btcMinDelta?: number; ethMinDelta?: number; solMinDelta?: number; xrpMinDelta?: number; byTimeframe?: any; persist?: boolean }) {
        const legacyPrev = this.cryptoAllDeltaThresholds.legacy || { btcMinDelta: 0, ethMinDelta: 0, solMinDelta: 0, xrpMinDelta: 0 };
        const legacyNext = {
            btcMinDelta: input.btcMinDelta != null ? Math.max(0, Number(input.btcMinDelta)) : legacyPrev.btcMinDelta,
            ethMinDelta: input.ethMinDelta != null ? Math.max(0, Number(input.ethMinDelta)) : legacyPrev.ethMinDelta,
            solMinDelta: input.solMinDelta != null ? Math.max(0, Number(input.solMinDelta)) : legacyPrev.solMinDelta,
            xrpMinDelta: input.xrpMinDelta != null ? Math.max(0, Number(input.xrpMinDelta)) : legacyPrev.xrpMinDelta,
        };
        const prevByTf = this.cryptoAllDeltaThresholds.byTimeframe || ({} as any);
        const nextByTf: any = {
            '5m': { ...(prevByTf['5m'] || legacyPrev) },
            '15m': { ...(prevByTf['15m'] || legacyPrev) },
            '1h': { ...(prevByTf['1h'] || legacyPrev) },
            '4h': { ...(prevByTf['4h'] || legacyPrev) },
            '1d': { ...(prevByTf['1d'] || legacyPrev) },
        };
        const bt = input.byTimeframe && typeof input.byTimeframe === 'object' ? input.byTimeframe : null;
        if (bt) {
            for (const tf of ['5m', '15m', '1h', '4h', '1d'] as const) {
                const row = (bt as any)[tf];
                if (!row || typeof row !== 'object') continue;
                const r2 = nextByTf[tf] || { ...legacyNext };
                const btc = row.btcMinDelta != null ? Number(row.btcMinDelta) : r2.btcMinDelta;
                const eth = row.ethMinDelta != null ? Number(row.ethMinDelta) : r2.ethMinDelta;
                const sol = row.solMinDelta != null ? Number(row.solMinDelta) : r2.solMinDelta;
                const xrp = row.xrpMinDelta != null ? Number(row.xrpMinDelta) : r2.xrpMinDelta;
                nextByTf[tf] = {
                    btcMinDelta: Number.isFinite(btc) ? Math.max(0, btc) : r2.btcMinDelta,
                    ethMinDelta: Number.isFinite(eth) ? Math.max(0, eth) : r2.ethMinDelta,
                    solMinDelta: Number.isFinite(sol) ? Math.max(0, sol) : r2.solMinDelta,
                    xrpMinDelta: Number.isFinite(xrp) ? Math.max(0, xrp) : r2.xrpMinDelta,
                };
            }
        } else if (input.btcMinDelta != null || input.ethMinDelta != null || input.solMinDelta != null || input.xrpMinDelta != null) {
            for (const tf of ['5m', '15m', '1h', '4h', '1d'] as const) nextByTf[tf] = { ...legacyNext };
        }
        this.cryptoAllDeltaThresholds = {
            ...this.cryptoAllDeltaThresholds,
            legacy: legacyNext,
            byTimeframe: nextByTf,
            updatedAt: new Date().toISOString(),
            persistLastError: null,
        };
        if (input.persist !== false) {
            this.persistCryptoAllDeltaThresholdsToFile();
        }
        return this.getCryptoAllDeltaThresholds();
    }

    private loadCryptoAllDeltaThresholdsFromFile() {
        if (!this.cryptoAllDeltaThresholdsPath) return;
        try {
            if (!fs.existsSync(this.cryptoAllDeltaThresholdsPath)) return;
            const raw = fs.readFileSync(this.cryptoAllDeltaThresholdsPath, 'utf8');
            const parsed = JSON.parse(String(raw || '{}'));
            const legacyRaw = (parsed?.legacy && typeof parsed.legacy === 'object') ? parsed.legacy : parsed;
            const legacyPrev = this.cryptoAllDeltaThresholds.legacy || { btcMinDelta: 0, ethMinDelta: 0, solMinDelta: 0, xrpMinDelta: 0 };
            const btcMinDelta = legacyRaw?.btcMinDelta != null ? Number(legacyRaw.btcMinDelta) : legacyPrev.btcMinDelta;
            const ethMinDelta = legacyRaw?.ethMinDelta != null ? Number(legacyRaw.ethMinDelta) : legacyPrev.ethMinDelta;
            const solMinDelta = legacyRaw?.solMinDelta != null ? Number(legacyRaw.solMinDelta) : legacyPrev.solMinDelta;
            const xrpMinDelta = legacyRaw?.xrpMinDelta != null ? Number(legacyRaw.xrpMinDelta) : legacyPrev.xrpMinDelta;
            const legacy = {
                btcMinDelta: Number.isFinite(btcMinDelta) ? Math.max(0, btcMinDelta) : legacyPrev.btcMinDelta,
                ethMinDelta: Number.isFinite(ethMinDelta) ? Math.max(0, ethMinDelta) : legacyPrev.ethMinDelta,
                solMinDelta: Number.isFinite(solMinDelta) ? Math.max(0, solMinDelta) : legacyPrev.solMinDelta,
                xrpMinDelta: Number.isFinite(xrpMinDelta) ? Math.max(0, xrpMinDelta) : legacyPrev.xrpMinDelta,
            };
            const byTfParsed = parsed?.byTimeframe && typeof parsed.byTimeframe === 'object' ? parsed.byTimeframe : null;
            const nextByTf: any = {};
            for (const tf of ['5m', '15m', '1h', '4h', '1d'] as const) {
                const row = byTfParsed ? (byTfParsed as any)[tf] : null;
                const btc = row?.btcMinDelta != null ? Number(row.btcMinDelta) : legacy.btcMinDelta;
                const eth = row?.ethMinDelta != null ? Number(row.ethMinDelta) : legacy.ethMinDelta;
                const sol = row?.solMinDelta != null ? Number(row.solMinDelta) : legacy.solMinDelta;
                const xrp = row?.xrpMinDelta != null ? Number(row.xrpMinDelta) : legacy.xrpMinDelta;
                nextByTf[tf] = {
                    btcMinDelta: Number.isFinite(btc) ? Math.max(0, btc) : legacy.btcMinDelta,
                    ethMinDelta: Number.isFinite(eth) ? Math.max(0, eth) : legacy.ethMinDelta,
                    solMinDelta: Number.isFinite(sol) ? Math.max(0, sol) : legacy.solMinDelta,
                    xrpMinDelta: Number.isFinite(xrp) ? Math.max(0, xrp) : legacy.xrpMinDelta,
                };
            }
            this.cryptoAllDeltaThresholds = {
                ...this.cryptoAllDeltaThresholds,
                legacy,
                byTimeframe: nextByTf,
                loadedAt: new Date().toISOString(),
                persistLastError: null,
            };
        } catch {
        }
    }

    private persistCryptoAllDeltaThresholdsToFile() {
        if (!this.cryptoAllDeltaThresholdsPath) return;
        const dir = path.dirname(this.cryptoAllDeltaThresholdsPath);
        try {
            fs.mkdirSync(dir, { recursive: true });
        } catch (e: any) {
            this.cryptoAllDeltaThresholds.persistLastError = e?.message ? String(e.message) : 'Failed to create cryptoall delta thresholds dir';
            return;
        }
        try {
            fs.writeFileSync(
                this.cryptoAllDeltaThresholdsPath,
                JSON.stringify({ legacy: this.cryptoAllDeltaThresholds.legacy, byTimeframe: this.cryptoAllDeltaThresholds.byTimeframe }),
                { encoding: 'utf8', mode: 0o600 }
            );
            try { fs.chmodSync(this.cryptoAllDeltaThresholdsPath, 0o600); } catch {}
            this.cryptoAllDeltaThresholds.persistLastError = null;
        } catch (e: any) {
            this.cryptoAllDeltaThresholds.persistLastError = e?.message ? String(e.message) : 'Failed to write cryptoall delta thresholds file';
        }
    }

    private cleanupRedeemInFlight() {
        const now = Date.now();
        for (const [conditionId, r] of this.redeemInFlight.entries()) {
            const ageMs = now - new Date(r.submittedAt).getTime();
            if (!Number.isFinite(ageMs)) continue;
            if (r.status === 'confirmed' && ageMs > 10 * 60_000) this.redeemInFlight.delete(conditionId);
            if (r.status === 'failed' && ageMs > 30 * 60_000) this.redeemInFlight.delete(conditionId);
            if (r.status === 'submitted' && ageMs > 30 * 60_000) this.redeemInFlight.delete(conditionId);
        }
    }

    private summarizeErrorMessage(err: any): string | null {
        const msg = String(err?.message || err || '').trim();
        if (!msg) return null;
        if (msg.toLowerCase().includes('quota exceeded')) return 'Relayer quota exceeded';
        if (msg.includes('Too many requests') || msg.includes('rate limit') || msg.includes('-32090') || msg.includes('429')) return 'RPC rate-limited';
        if (msg.includes('noNetwork') || msg.includes('NETWORK_ERROR')) return 'RPC unreachable';
        if (msg.toLowerCase().includes('insufficient funds')) return 'Insufficient gas (MATIC)';
        if (msg.toLowerCase().includes('invalid authorization') || msg.toLowerCase().includes('unauthorized')) return 'Relayer auth failed';
        return msg.length > 140 ? msg.slice(0, 140) + '…' : msg;
    }

    private buildPolymarketMarketUrlFromSlug(slug?: string | null): string | null {
        const s = String(slug || '').trim();
        if (!s) return null;
        const m = s.match(/^(.*-on-[a-z]+-\d{1,2})-/i);
        const groupSlug = m ? m[1] : s;
        return `https://polymarket.com/event/${groupSlug}/${s}`;
    }

    getRedeemInFlight(options?: { limit?: number }) {
        this.cleanupRedeemInFlight();
        const limit = Math.max(1, Math.floor(Number(options?.limit ?? 50)));
        const items = Array.from(this.redeemInFlight.values())
            .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime())
            .slice(0, limit);
        return { count: this.redeemInFlight.size, items };
    }

    private refreshRedeemHistoryFromInFlight(options?: { maxEntries?: number }) {
        this.cleanupRedeemInFlight();
        const maxEntries = Number(options?.maxEntries ?? 50);
        const slice = this.orderHistory.slice(0, maxEntries);
        for (const entry of slice) {
            if (!entry || !Array.isArray(entry.results)) continue;
            for (const r of entry.results) {
                const conditionId = r?.conditionId ? String(r.conditionId) : '';
                if (!conditionId) continue;
                const inflight = this.redeemInFlight.get(conditionId);
                if (!inflight) continue;
                if (inflight.status === 'failed' && inflight.txHash && inflight.txStatus !== 0 && inflight.payoutNetUsdc != null && Number(inflight.payoutNetUsdc) <= 0) {
                    inflight.status = 'confirmed';
                    inflight.paid = false;
                    inflight.error = undefined;
                }
                r.redeemStatus = inflight.status;
                r.transactionId = inflight.transactionId ?? r.transactionId;
                r.txHash = inflight.txHash ?? r.txHash;
                r.payoutUsdc = inflight.payoutUsdc ?? r.payoutUsdc;
                r.payoutReceivedUsdc = inflight.payoutReceivedUsdc ?? r.payoutReceivedUsdc;
                r.payoutSentUsdc = inflight.payoutSentUsdc ?? r.payoutSentUsdc;
                r.payoutNetUsdc = inflight.payoutNetUsdc ?? r.payoutNetUsdc;
                r.payoutRecipients = inflight.payoutRecipients ?? r.payoutRecipients;
                r.txStatus = inflight.txStatus ?? r.txStatus;
                r.paid = inflight.paid ?? r.paid;
                r.usdcTransfers = inflight.usdcTransfers ?? r.usdcTransfers;
                if (inflight.status === 'failed') {
                    r.success = false;
                    r.error = inflight.error ?? r.error;
                    r.errorSummary = this.summarizeErrorMessage(r.error);
                }
                if (inflight.status === 'confirmed') {
                    r.confirmed = true;
                }
            }
        }
    }

    private upsertRedeemInfoToOrderHistory(conditionId: string) {
        const cid = String(conditionId || '').trim();
        if (!cid) return;
        const inflight = this.redeemInFlight.get(cid);
        if (!inflight) return;
        const maxEntries = 50;
        const slice = this.orderHistory.slice(0, maxEntries);
        let changed = false;
        for (const entry of slice) {
            if (!entry) continue;
            const action = String(entry?.action || '');
            if (action === 'crypto15m_order') {
                if (String(entry?.marketId || '').trim().toLowerCase() !== cid.toLowerCase()) continue;
                if (!Array.isArray(entry.results) || !entry.results.length) entry.results = [{}];
                const r = entry.results[0] || {};
                r.conditionId = r.conditionId || cid;
                r.redeemStatus = inflight.status;
                r.transactionId = inflight.transactionId ?? r.transactionId;
                r.txHash = inflight.txHash ?? r.txHash;
                r.txStatus = inflight.txStatus ?? r.txStatus;
                r.paid = inflight.paid ?? r.paid;
                r.payoutUsdc = inflight.payoutUsdc ?? r.payoutUsdc;
                r.payoutReceivedUsdc = inflight.payoutReceivedUsdc ?? r.payoutReceivedUsdc;
                r.payoutSentUsdc = inflight.payoutSentUsdc ?? r.payoutSentUsdc;
                r.payoutNetUsdc = inflight.payoutNetUsdc ?? r.payoutNetUsdc;
                r.payoutRecipients = inflight.payoutRecipients ?? r.payoutRecipients;
                r.usdcTransfers = inflight.usdcTransfers ?? r.usdcTransfers;
                if (inflight.status === 'failed') {
                    r.success = false;
                    r.error = inflight.error ?? r.error;
                    r.errorSummary = this.summarizeErrorMessage(r.error);
                }
                if (inflight.status === 'confirmed') {
                    r.confirmed = true;
                }
                entry.results[0] = r;
                changed = true;
                continue;
            }
            if (action === 'redeem') {
                if (!Array.isArray(entry.results)) continue;
                for (const r of entry.results) {
                    if (String(r?.conditionId || '').trim().toLowerCase() !== cid.toLowerCase()) continue;
                    r.redeemStatus = inflight.status;
                    r.transactionId = inflight.transactionId ?? r.transactionId;
                    r.txHash = inflight.txHash ?? r.txHash;
                    r.txStatus = inflight.txStatus ?? r.txStatus;
                    r.paid = inflight.paid ?? r.paid;
                    r.payoutUsdc = inflight.payoutUsdc ?? r.payoutUsdc;
                    r.payoutReceivedUsdc = inflight.payoutReceivedUsdc ?? r.payoutReceivedUsdc;
                    r.payoutSentUsdc = inflight.payoutSentUsdc ?? r.payoutSentUsdc;
                    r.payoutNetUsdc = inflight.payoutNetUsdc ?? r.payoutNetUsdc;
                    r.payoutRecipients = inflight.payoutRecipients ?? r.payoutRecipients;
                    r.usdcTransfers = inflight.usdcTransfers ?? r.usdcTransfers;
                    if (inflight.status === 'confirmed') r.confirmed = true;
                    if (inflight.status === 'failed') {
                        r.success = false;
                        r.error = inflight.error ?? r.error;
                        r.errorSummary = this.summarizeErrorMessage(r.error);
                    }
                    changed = true;
                }
            }
        }
        if (changed) this.schedulePersistOrderHistory();
    }

    private isRedeemConfirmed(conditionId: string): boolean {
        const id = String(conditionId || '').trim();
        if (!id) return false;
        const r = this.redeemInFlight.get(id);
        return !!r && r.status === 'confirmed' && r.paid === true;
    }

    private async redeemViaRelayerSubmit(conditionId: string, options?: { proxyWallet?: string | null; recipients?: string[] | null }): Promise<{ txType: 'PROXY' | 'SAFE'; transactionId?: string; txHash?: string }> {
        if (!this.relayerConfigured || (!this.relayerSafe && !this.relayerProxy)) {
            throw new Error('Relayer not configured');
        }

        const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
        const USDCe_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
        const parentCollectionId = await this.getRedeemParentCollectionId(conditionId);
        const ctfAbi = parseAbi([
            'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)'
        ]);
        const calldata = encodeFunctionData({
            abi: ctfAbi,
            functionName: 'redeemPositions',
            args: [USDCe_ADDRESS, parentCollectionId as any, conditionId as any, [1n, 2n]],
        });

        const tx = { to: CTF_ADDRESS, data: calldata, value: '0' };
        const shouldTryProxy = this.tradingClient.getFunderAddress().toLowerCase() !== this.tradingClient.getSignerAddress().toLowerCase();

        const submit = async (client: RelayClient, txType: 'PROXY' | 'SAFE') => {
            if (txType === 'SAFE') await this.ensureRelayerSafeDeployed();
            const resp: any = await this.withTimeout((client as any).execute([tx], `redeem ${conditionId}`), 15_000, `Relayer execute (${txType})`);
            const transactionId = resp?.transactionID || resp?.transactionId || resp?.id;
            const submittedAt = new Date().toISOString();
            const isAddress = (v: string) => /^0x[a-fA-F0-9]{40}$/.test(String(v || '').trim());
            const rawRecipients = Array.isArray(options?.recipients) ? options!.recipients! : [options?.proxyWallet, this.getFunderAddress()];
            const payoutRecipients = Array.from(new Set(rawRecipients
                .map((a) => String(a || '').trim())
                .filter((a) => !!a && isAddress(a))
                .map((a) => a.toLowerCase())));
            this.redeemInFlight.set(conditionId, { conditionId, submittedAt, method: `relayer_${txType.toLowerCase()}`, transactionId: transactionId ? String(transactionId) : undefined, status: 'submitted', payoutRecipients });
            this.crypto15mSyncFromRedeemInFlight(conditionId);

            const waitPromise = (async () => {
                try {
                    const result: any = await this.withTimeout(resp.wait(), 10 * 60_000, `Relayer wait (${txType})`);
                    const txHash = result?.transactionHash || result?.transaction_hash;
                    const cur = this.redeemInFlight.get(conditionId);
                    if (cur) {
                        cur.status = 'confirmed';
                        if (txHash) {
                            cur.txHash = String(txHash);
                            try {
                                const payout = await this.computeUsdcTransfersFromTxHash(cur.txHash, { recipients: cur.payoutRecipients });
                                cur.txStatus = payout.txStatus;
                                cur.payoutUsdc = payout.netUsdc;
                                cur.payoutReceivedUsdc = payout.receivedUsdc;
                                cur.payoutSentUsdc = payout.sentUsdc;
                                cur.payoutNetUsdc = payout.netUsdc;
                                cur.payoutRecipients = payout.recipients;
                                cur.usdcTransfers = payout.transfers;
                                cur.paid = payout.txStatus === 0 ? false : Number(payout.netUsdc) > 0;
                                cur.error = undefined;
                                cur.payoutComputedAt = new Date().toISOString();
                            } catch {
                            }
                        }
                        this.crypto15mSyncFromRedeemInFlight(conditionId);
                        this.upsertRedeemInfoToOrderHistory(conditionId);
                    }
                } catch (e: any) {
                    const cur = this.redeemInFlight.get(conditionId);
                    if (cur) {
                        cur.status = 'failed';
                        cur.error = e?.message || String(e);
                    }
                    this.crypto15mSyncFromRedeemInFlight(conditionId);
                    this.upsertRedeemInfoToOrderHistory(conditionId);
                }
            })();
            waitPromise.catch(() => null);

            return { txType, transactionId: transactionId ? String(transactionId) : undefined };
        };

        if (shouldTryProxy && this.relayerProxy) {
            try {
                return await submit(this.relayerProxy, 'PROXY');
            } catch (e: any) {
                if (this.isRelayerQuotaExceeded(e)) {
                    const rotated = this.rotateRelayerKeyOnQuotaExceeded(e);
                    if (rotated) return await this.redeemViaRelayerSubmit(conditionId, options);
                    throw e;
                }
                if (this.isRelayerAuthError(e)) throw new Error(`Relayer proxy auth failed: ${e?.message || String(e)}`);
            }
        }
        if (this.relayerSafe) {
            try {
                return await submit(this.relayerSafe, 'SAFE');
            } catch (e: any) {
                if (this.isRelayerQuotaExceeded(e)) {
                    const rotated = this.rotateRelayerKeyOnQuotaExceeded(e);
                    if (rotated) return await this.redeemViaRelayerSubmit(conditionId, options);
                    throw e;
                }
                if (this.isRelayerAuthError(e)) throw new Error(`Relayer safe auth failed: ${e?.message || String(e)}`);
                throw e;
            }
        }
        if (this.relayerProxy) return await submit(this.relayerProxy, 'PROXY');
        throw new Error('No relayer client available');
    }

    startRedeemDrain(options?: { maxTotal?: number; source?: 'manual' | 'auto' }) {
        if (this.redeemDrainRunning) {
            const startedAt = this.redeemDrainLast?.startedAt ? new Date(this.redeemDrainLast.startedAt).getTime() : NaN;
            const ageMs = Number.isFinite(startedAt) ? (Date.now() - startedAt) : 0;
            if (ageMs > 2 * 60_000) {
                this.redeemDrainRunning = false;
                if (this.redeemDrainLast && !this.redeemDrainLast.finishedAt) {
                    this.redeemDrainLast.finishedAt = new Date().toISOString();
                    this.redeemDrainLast.stalledResetAt = this.redeemDrainLast.finishedAt;
                }
            } else {
            return { started: false, status: this.redeemDrainLast, inFlightCount: this.redeemInFlight.size };
            }
        }
        const maxTotal = Math.max(1, Math.floor(Number(options?.maxTotal ?? this.autoRedeemConfig.maxPerCycle)));
        const source = options?.source || 'manual';

        this.redeemDrainRunning = true;
        const startedAt = new Date().toISOString();
        this.redeemDrainLast = { startedAt, finishedAt: null, source, submitted: 0, skippedInFlight: 0, skippedNonBuilder: 0, remaining: null, errors: 0 };

        const run = async () => {
            try {
                const funder = this.getFunderAddress();
                const before = await this.getPortfolioSummary({ positionsLimit: 1 }).catch(() => null);
                const cashBefore = before?.cash != null ? Number(before.cash) : null;
                const claimableCountBefore = before?.claimableCount != null ? Number(before.claimableCount) : null;
                let submitted = 0;
                let skippedInFlight = 0;
                let skippedNonBuilder = 0;
                let errors = 0;
                const submittedResults: any[] = [];
                const conditionIds: string[] = [];
                const toolConditionIds = source === 'auto'
                    ? new Set(this.orderHistory
                        .filter((e: any) => String(e?.action || '') === 'crypto15m_order' && e?.marketId)
                        .map((e: any) => String(e.marketId).trim().toLowerCase())
                        .filter((x: any) => !!x))
                    : null;
                while (submitted < maxTotal) {
                    this.cleanupRedeemInFlight();
                    const positions = await this.fetchDataApiPositions(funder);
                    const redeemablesAll = (positions || []).filter((p: any) => !!p?.redeemable && p?.conditionId);
                    const toolRedeemablesAll = source === 'auto' && toolConditionIds
                        ? redeemablesAll.filter((p: any) => toolConditionIds.has(String(p?.conditionId || '').trim().toLowerCase()))
                        : redeemablesAll;
                    const redeemables = source === 'auto'
                        ? toolRedeemablesAll.filter((p: any) => {
                            const proxyWallet = String(p?.proxyWallet || '').trim();
                            return proxyWallet.startsWith('0x');
                        })
                        : redeemablesAll;
                    if (source === 'auto') {
                        skippedNonBuilder += toolRedeemablesAll.length - redeemables.length;
                        this.redeemDrainLast.skippedNonBuilder = skippedNonBuilder;
                    }
                    const next = redeemables.find((p: any) => !this.redeemInFlight.has(String(p.conditionId)));
                    if (!next) {
                        skippedInFlight += redeemables.length;
                        this.redeemDrainLast.remaining = redeemables.length;
                        break;
                    }
                    const conditionId = String(next.conditionId);
                    try {
                        if (!this.ensureRelayerReadyForRedeem()) {
                            this.autoRedeemLastError = this.relayerLastInitError || 'Relayer not configured';
                            break;
                        }
                        const r = await this.redeemViaRelayerSubmit(conditionId, { proxyWallet: next.proxyWallet });
                        submitted += 1;
                        conditionIds.push(conditionId);
                        this.redeemDrainLast.submitted = submitted;
                        this.redeemDrainLast.remaining = redeemables.length - submitted;
                        this.autoRedeemLast = { at: new Date().toISOString(), source, count: submitted, ok: submitted, fail: 0 };
                        this.autoRedeemLastError = null;
                        submittedResults.push({
                            success: true,
                            confirmed: false,
                            redeemStatus: 'submitted',
                            conditionId,
                            title: next.title,
                            outcome: next.outcome,
                            slug: next.slug,
                            eventSlug: next.eventSlug,
                            polymarketUrl: this.buildPolymarketMarketUrlFromSlug(next.slug),
                            transactionId: r?.transactionId,
                            method: `relayer_${String(r?.txType || '').toLowerCase()}`,
                        });
                    } catch (e: any) {
                        const quotaExceeded = this.isRelayerQuotaExceeded(e);
                        if (quotaExceeded) {
                            const rotated = this.rotateRelayerKeyOnQuotaExceeded(e);
                            if (rotated) continue;
                        }
                        errors += 1;
                        this.redeemDrainLast.errors = errors;
                        this.autoRedeemLastError = this.summarizeErrorMessage(e) || (e?.message || String(e));
                        const error = e?.message || String(e);
                        const submittedAt = new Date().toISOString();
                        this.redeemInFlight.set(conditionId, { conditionId, submittedAt, method: 'redeem_failed', status: 'failed', error });
                        this.crypto15mSyncFromRedeemInFlight(conditionId);
                        submittedResults.push({
                            success: false,
                            confirmed: false,
                            redeemStatus: 'failed',
                            conditionId,
                            title: next.title,
                            outcome: next.outcome,
                            slug: next.slug,
                            eventSlug: next.eventSlug,
                            polymarketUrl: this.buildPolymarketMarketUrlFromSlug(next.slug),
                            error,
                            errorSummary: this.summarizeErrorMessage(error),
                        });
                        if (source === 'auto' && quotaExceeded) {
                            const anyAvailable = this.relayerKeys.some((k) => !this.isRelayerKeyExhausted(k));
                            if (!anyAvailable) this.setAutoRedeemConfig({ enabled: false, persist: true });
                        }
                        if (errors >= 3) break;
                    }
                    await new Promise(r => setTimeout(r, 200));
                }
                this.redeemDrainLast.skippedInFlight = skippedInFlight;
                this.redeemDrainLast.skippedNonBuilder = skippedNonBuilder;
                this.redeemDrainLast.errors = errors;

                if (source === 'manual' && conditionIds.length) {
                    const start = Date.now();
                    const timeoutMs = 3 * 60_000;
                    while (Date.now() - start < timeoutMs) {
                        const pending = conditionIds.filter((id) => {
                            const st = this.redeemInFlight.get(id)?.status;
                            return st === 'submitted' || !st;
                        });
                        if (!pending.length) break;
                        await new Promise(r => setTimeout(r, 750));
                    }
                }

                for (const r of submittedResults) {
                    const cid = r?.conditionId ? String(r.conditionId) : '';
                    if (!cid) continue;
                    const inflight = this.redeemInFlight.get(cid);
                    if (!inflight) continue;
                    r.redeemStatus = inflight.status;
                    r.txHash = inflight.txHash ?? r.txHash;
                    r.payoutUsdc = inflight.payoutUsdc ?? r.payoutUsdc;
                    r.payoutReceivedUsdc = inflight.payoutReceivedUsdc ?? r.payoutReceivedUsdc;
                    r.payoutSentUsdc = inflight.payoutSentUsdc ?? r.payoutSentUsdc;
                    r.payoutNetUsdc = inflight.payoutNetUsdc ?? r.payoutNetUsdc;
                    r.payoutRecipients = inflight.payoutRecipients ?? r.payoutRecipients;
                    r.txStatus = inflight.txStatus ?? r.txStatus;
                    r.paid = inflight.paid ?? r.paid;
                    r.usdcTransfers = inflight.usdcTransfers ?? r.usdcTransfers;
                    if (inflight.status === 'confirmed') r.confirmed = true;
                    if (inflight.status === 'failed') {
                        r.success = false;
                        r.error = inflight.error ?? r.error;
                        r.errorSummary = this.summarizeErrorMessage(r.error);
                    }
                }

                const after = await this.getPortfolioSummary({ positionsLimit: 1 }).catch(() => null);
                const cashAfter = after?.cash != null ? Number(after.cash) : null;
                const claimableCountAfter = after?.claimableCount != null ? Number(after.claimableCount) : null;
                const cashDelta = cashBefore != null && cashAfter != null ? (cashAfter - cashBefore) : null;
                this.redeemDrainLast.cashBefore = cashBefore;
                this.redeemDrainLast.cashAfter = cashAfter;
                this.redeemDrainLast.cashDelta = cashDelta;
                this.redeemDrainLast.claimableCountBefore = claimableCountBefore;
                this.redeemDrainLast.claimableCountAfter = claimableCountAfter;
                if (submittedResults.length) {
                    this.orderHistory.unshift({
                        id: Date.now(),
                        timestamp: new Date().toISOString(),
                        marketQuestion: `Redeem batch (${submittedResults.length})`,
                        mode: source,
                        action: 'redeem',
                        cashBefore,
                        cashAfter,
                        cashDelta,
                        claimableCountBefore,
                        claimableCountAfter,
                        results: submittedResults,
                    });
                    if (this.orderHistory.length > 100) this.orderHistory.pop();
                    this.schedulePersistOrderHistory();
                }
            } finally {
                this.redeemDrainRunning = false;
                this.redeemDrainLast.finishedAt = new Date().toISOString();
            }
        };
        run().catch((e: any) => {
            this.autoRedeemLastError = e?.message || String(e);
        });

        return { started: true, status: this.redeemDrainLast, inFlightCount: this.redeemInFlight.size };
    }

    async getRedeemDiagnostics(options?: { limit?: number }) {
        const funder = this.getFunderAddress();
        const owner = this.redeemWallet?.address;
        const limit = Math.max(1, Math.floor(Number(options?.limit ?? 50)));
        const positions = await this.fetchDataApiPositions(funder);
        const redeemables = positions
            .filter((p: any) => !!p?.redeemable && p?.conditionId && !this.isRedeemConfirmed(String(p.conditionId)))
            .slice(0, limit)
            .map((p: any) => ({
                conditionId: String(p.conditionId),
                title: p.title,
                slug: p.slug,
                eventSlug: p.eventSlug,
                outcome: p.outcome,
                proxyWallet: p.proxyWallet,
                redeemable: !!p.redeemable,
                size: p.size,
                cashPnl: p.cashPnl,
                realizedPnl: p.realizedPnl,
            }));

        return {
            funder,
            owner,
            relayerConfigured: this.relayerConfigured,
            redeemableCount: redeemables.length,
            redeemables,
        };
    }

    setAutoRedeemConfig(config: { enabled?: boolean; intervalMinutes?: number; maxPerCycle?: number; persist?: boolean }) {
        const enabled = config.enabled != null ? !!config.enabled : this.autoRedeemConfig.enabled;
        const maxPerCycle = config.maxPerCycle != null ? Number(config.maxPerCycle) : this.autoRedeemConfig.maxPerCycle;

        this.autoRedeemConfig = {
            enabled,
            intervalMs: 5_000,
            maxPerCycle: Math.max(1, Math.floor(maxPerCycle)),
        };

        if (this.autoRedeemTimer) {
            clearInterval(this.autoRedeemTimer);
            this.autoRedeemTimer = null;
        }

        if (this.autoRedeemConfig.enabled) {
            const pollMs = 5_000;
            const tick = () => {
                this.autoRedeemNextAt = new Date(Date.now() + pollMs).toISOString();
                try {
                    this.startRedeemDrain({ maxTotal: this.autoRedeemConfig.maxPerCycle, source: 'auto' });
                } catch (e: any) {
                    this.autoRedeemLastError = e?.message || String(e);
                }
            };
            tick();
            this.autoRedeemTimer = setInterval(tick, pollMs);
        } else {
            this.autoRedeemNextAt = null;
        }

        if (config.persist !== false) {
            this.persistAutoRedeemConfigToFile();
        }
        return this.autoRedeemConfig;
    }

    private async fetchGammaJson(url: string): Promise<any> {
        const headers: any = {
            'accept': 'application/json, text/plain, */*',
            'user-agent': 'Mozilla/5.0 (compatible; polymarket-tools/1.0)',
        };
        const attempts = 2;
        for (let i = 0; i < attempts; i++) {
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), 3_000);
            const res = await this.withTimeout(
                fetch(url, { headers, signal: controller.signal }).finally(() => clearTimeout(t)),
                3_500,
                `Gamma fetch ${url}`
            );
            if (!res.ok) {
                const retryAfter = res.headers?.get ? res.headers.get('retry-after') : null;
                if (res.status === 429 && i + 1 < attempts) {
                    const sec = retryAfter != null && retryAfter !== '' ? Number(retryAfter) : NaN;
                    const retryAfterMs = Number.isFinite(sec) ? Math.max(1, sec) * 1000 : 60_000;
                    await new Promise((r) => setTimeout(r, Math.min(60_000, retryAfterMs)));
                    continue;
                }
                const err: any = new Error(`Gamma API failed (${res.status})`);
                if (res.status === 429) {
                    const sec = retryAfter != null && retryAfter !== '' ? Number(retryAfter) : NaN;
                    err.retryAfterMs = Number.isFinite(sec) ? Math.max(1, sec) * 1000 : 60_000;
                }
                throw err;
            }
            return await this.withTimeout(res.json(), 5_000, `Gamma json ${url}`);
        }
        throw new Error('Gamma API failed (retry exhausted)');
    }

    private tryParseJsonArray(raw: any): any[] {
        if (Array.isArray(raw)) return raw;
        const s = String(raw ?? '').trim();
        if (!s) return [];
        if (s.startsWith('[') && s.endsWith(']') && !s.includes('"') && /\d/.test(s)) {
            const nums = s.match(/\d+/g);
            return Array.isArray(nums) ? nums : [];
        }
        try {
            const parsed = JSON.parse(s);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    private async resolveCryptoTagId(): Promise<string | null> {
        if (this.crypto15mCryptoTagId) return this.crypto15mCryptoTagId;
        try {
            const pageSize = 200;
            const maxPages = 20;
            for (let page = 0; page < maxPages; page++) {
                const offset = page * pageSize;
                const tags = await this.fetchGammaJson(`https://gamma-api.polymarket.com/tags?limit=${pageSize}&offset=${offset}`);
                const list = Array.isArray(tags) ? tags : [];
                const t = list.find((x: any) => String(x?.slug || '').toLowerCase() === 'crypto' || String(x?.label || '').toLowerCase() === 'crypto');
                const id = t?.id != null ? String(t.id) : null;
                if (id) {
                    this.crypto15mCryptoTagId = id;
                    return id;
                }
                if (list.length < pageSize) break;
            }
            return null;
        } catch {
            return null;
        }
    }

    private matchesCryptoAllTimeframe(tf: '5m' | '15m' | '1h' | '4h' | '1d', slug: string, title: string): boolean {
        const s = String(slug || '').toLowerCase();
        const t = String(title || '').toLowerCase();
        if (tf === '5m') return /\b5\s*(m|min|mins|minute|minutes)\b/.test(t) || /(^|-)5m(-|$)/.test(s) || /(^|-)5-min(ute)?s?(-|$)/.test(s) || /(^|-)5mins(-|$)/.test(s) || /(^|-)5min(ute)?s?(-|$)/.test(s);
        if (tf === '15m') return /\b15\s*(m|min|mins|minute|minutes)\b/.test(t) || s.includes('15m') || s.includes('15-min') || s.includes('15-minute') || s.includes('15minutes') || s.includes('-15m-');
        if (tf === '1h') return /\b(1\s*(h|hr|hour|hours)|60\s*(m|min|mins|minute|minutes)|hourly)\b/.test(t) || s.includes('1h') || s.includes('1-hr') || s.includes('1-hour') || s.includes('hourly') || s.includes('60m') || s.includes('60min');
        if (tf === '4h') return /\b(4\s*(h|hr|hour|hours)|240\s*(m|min|mins|minute|minutes))\b/.test(t) || s.includes('4h') || s.includes('4-hr') || s.includes('4-hour') || s.includes('4hours') || s.includes('4-hours') || s.includes('240m') || s.includes('240min');
        return /\b(1\s*(d|day|days)|24\s*(h|hr|hour|hours)|daily)\b/.test(t) || s.includes('1d') || s.includes('1-day') || s.includes('1day') || s.includes('daily') || s.includes('24h');
    }

    private async fetchGammaCryptoEvents(tagId: string, limit: number, offset: number): Promise<any[]> {
        const id = String(tagId || '').trim();
        if (!id) return [];
        const l = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
        const o = Math.max(0, Math.floor(Number(offset) || 0));
        const url = `https://gamma-api.polymarket.com/events?tag_id=${encodeURIComponent(id)}&active=true&closed=false&order=id&ascending=false&limit=${l}&offset=${o}`;
        const data = await this.fetchGammaJson(url);
        return Array.isArray(data) ? data : [];
    }

    private async fetchCrypto15mSlugsFromSite(limit: number): Promise<string[]> {
        const cached = (this as any).crypto15mSlugsCache as { atMs: number; slugs: string[] } | undefined;
        if (cached && Date.now() - cached.atMs < 30_000) return cached.slugs.slice(0, limit);
        try {
            const headers: any = {
                'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'accept-language': 'en-US,en;q=0.9',
                'cache-control': 'no-cache',
                'pragma': 'no-cache',
            };
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), 2_000);
            const res = await this.withTimeout(
                fetch('https://polymarket.com/crypto/15M', { headers, signal: controller.signal }).finally(() => clearTimeout(t)),
                2_500,
                'Site crypto/15M'
            );
            if (!res.ok) return [];
            const html = await this.withTimeout(res.text(), 2_000, 'Site crypto/15M html');
            const slugs: string[] = [];
            const re = /\/event\/([a-z0-9-]{6,})/gi;
            let m: RegExpExecArray | null;
            while ((m = re.exec(html)) && slugs.length < limit * 3) {
                slugs.push(String(m[1]).toLowerCase());
            }
            const uniq = Array.from(new Set(slugs));
            (this as any).crypto15mSlugsCache = { atMs: Date.now(), slugs: uniq };
            return uniq.slice(0, limit);
        } catch {
            return [];
        }
    }

    private async fetchCryptoSlugsFromSitePath(sitePath: string, limit: number): Promise<string[]> {
        const key = String(sitePath || '').trim() || '/';
        const cache = (this as any).cryptoAllSlugsCache as Map<string, { atMs: number; slugs: string[] }> | undefined;
        const cached = cache?.get(key);
        if (cached && Date.now() - cached.atMs < 30_000) return cached.slugs.slice(0, limit);
        try {
            if (!(this as any).cryptoAllSlugsDiag) (this as any).cryptoAllSlugsDiag = new Map();
            const headers: any = {
                'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'accept-language': 'en-US,en;q=0.9',
                'cache-control': 'no-cache',
                'pragma': 'no-cache',
            };
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), 2_500);
            const res = await this.withTimeout(
                fetch(`https://polymarket.com${key}`, { headers, signal: controller.signal }).finally(() => clearTimeout(t)),
                3_000,
                `Site ${key}`
            );
            if (!res.ok) {
                (this as any).cryptoAllSlugsDiag.set(key, { atMs: Date.now(), ok: false, status: res.status, slugsCount: 0, error: `HTTP ${res.status}` });
                return [];
            }
            const html = await this.withTimeout(res.text(), 2_500, `Site ${key} html`);
            const slugs: string[] = [];
            const re = /\/event\/([a-z0-9-]{6,})/gi;
            let m: RegExpExecArray | null;
            while ((m = re.exec(html)) && slugs.length < limit * 5) {
                slugs.push(String(m[1]).toLowerCase());
            }
            const uniq = Array.from(new Set(slugs));
            if (!(this as any).cryptoAllSlugsCache) (this as any).cryptoAllSlugsCache = new Map();
            (this as any).cryptoAllSlugsCache.set(key, { atMs: Date.now(), slugs: uniq });
            (this as any).cryptoAllSlugsDiag.set(key, { atMs: Date.now(), ok: true, status: 200, slugsCount: uniq.length, error: null });
            return uniq.slice(0, limit);
        } catch (e: any) {
            if (!(this as any).cryptoAllSlugsDiag) (this as any).cryptoAllSlugsDiag = new Map();
            (this as any).cryptoAllSlugsDiag.set(key, { atMs: Date.now(), ok: false, status: null, slugsCount: 0, error: e?.message || String(e) });
            return [];
        }
    }

    getCryptoAllDiag() {
        const diag = (this as any).cryptoAllSlugsDiag as Map<string, any> | undefined;
        const entries = diag ? Array.from(diag.entries()) : [];
        const cache = (this as any).cryptoAllSlugsCache as Map<string, { atMs: number; slugs: string[] }> | undefined;
        const sources = entries
            .map(([path, v]) => {
                const c = cache?.get(path);
                const sampleSlugs = c?.slugs ? c.slugs.slice(0, 8) : [];
                return { path, ...(v || {}), sampleSlugs };
            })
            .sort((a: any, b: any) => String(a.path).localeCompare(String(b.path)));
        const riskDiag = (this as any).cryptoAllRiskDiag as Map<string, any> | undefined;
        const risk = riskDiag ? Array.from(riskDiag.entries()).slice(-80).map(([k, v]) => ({ key: k, ...(v || {}) })) : [];
        const marketsAll = Array.isArray(this.cryptoAllMarketSnapshot.markets) ? this.cryptoAllMarketSnapshot.markets : [];
        const markets = marketsAll.slice(0, 12).map((m: any) => ({
            timeframe: m?.timeframe,
            symbol: m?.symbol,
            slug: m?.slug,
            conditionId: m?.conditionId,
            endMs: m?.endMs,
            upTokenId: m?.upTokenId,
            downTokenId: m?.downTokenId,
        }));
        const books = {
            atMs: this.cryptoAllBooksSnapshot.atMs,
            tokenCount: Object.keys(this.cryptoAllBooksSnapshot.byTokenId || {}).length,
            lastError: this.cryptoAllBooksSnapshot.lastError,
            lastAttemptAtMs: this.cryptoAllBooksSnapshot.lastAttemptAtMs,
            lastAttemptError: this.cryptoAllBooksSnapshot.lastAttemptError,
        };
        const marketSnapshot = {
            atMs: this.cryptoAllMarketSnapshot.atMs,
            marketCount: marketsAll.length,
            lastError: this.cryptoAllMarketSnapshot.lastError,
            lastAttemptAtMs: this.cryptoAllMarketSnapshot.lastAttemptAtMs,
            lastAttemptError: this.cryptoAllMarketSnapshot.lastAttemptError,
            diag: (this.cryptoAllMarketSnapshot as any)?.diag ?? null,
        };
        return { success: true, sources, config: this.cryptoAllAutoConfig, marketSnapshot, markets, books, risk };
    }

    private inferCryptoTimeframeFromSlug(slug: string, title: string): '5m' | '15m' | '1h' | '4h' | '1d' | null {
        const s = String(slug || '').toLowerCase();
        const t = String(title || '').toLowerCase();
        const hay = `${s} ${t}`;
        if (/(^|-)5m(-|$)/.test(hay) || /(^|-)5-min(ute)?s?(-|$)/.test(hay) || /(^|-)5mins(-|$)/.test(hay) || /(^|-)5min(ute)?s?(-|$)/.test(hay)) return '5m';
        if (hay.includes('15m') || hay.includes('15-min') || hay.includes('15min') || hay.includes('15-minute') || hay.includes('15minutes')) return '15m';
        if (hay.includes('1h') || hay.includes('1-hr') || hay.includes('1hr') || hay.includes('hourly') || hay.includes('1-hour') || hay.includes('1hour') || hay.includes('60m') || hay.includes('60min')) return '1h';
        if (hay.includes('4h') || hay.includes('4-hr') || hay.includes('4hr') || hay.includes('4-hour') || hay.includes('4hour') || hay.includes('4hours') || hay.includes('4-hours') || hay.includes('240m') || hay.includes('240min')) return '4h';
        if (hay.includes('1d') || hay.includes('1-day') || hay.includes('1day') || hay.includes('daily') || hay.includes('24h') || hay.includes('24hr') || hay.includes('24-hour') || hay.includes('24hours')) return '1d';
        const m = String(title || '').match(/(\d{1,2}):(\d{2})\s*(AM|PM)\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i);
        if (m) {
            const toMin = (hh: number, mm: number, ap: string) => {
                const p = String(ap || '').toLowerCase();
                let h = Math.max(0, Math.min(12, Math.floor(hh)));
                const mi = Math.max(0, Math.min(59, Math.floor(mm)));
                if (p === 'am') {
                    if (h === 12) h = 0;
                } else if (p === 'pm') {
                    if (h !== 12) h += 12;
                }
                return h * 60 + mi;
            };
            const sMin = toMin(Number(m[1]), Number(m[2]), String(m[3]));
            const eMin = toMin(Number(m[4]), Number(m[5]), String(m[6]));
            let diff = eMin - sMin;
            if (diff < 0) diff += 24 * 60;
            if (diff >= 3 && diff <= 7) return '5m';
            if (diff >= 10 && diff <= 20) return '15m';
            if (diff >= 50 && diff <= 70) return '1h';
            if (diff >= 220 && diff <= 260) return '4h';
            if (diff >= 1300 && diff <= 1500) return '1d';
        }
        return null;
    }

    private findObjectDeep(root: any, predicate: (x: any) => boolean): any | null {
        const seen = new Set<any>();
        const stack: any[] = [root];
        while (stack.length) {
            const cur = stack.pop();
            if (!cur || typeof cur !== 'object') continue;
            if (seen.has(cur)) continue;
            seen.add(cur);
            try {
                if (predicate(cur)) return cur;
            } catch {
            }
            if (Array.isArray(cur)) {
                for (const v of cur) stack.push(v);
            } else {
                for (const v of Object.values(cur)) stack.push(v);
            }
        }
        return null;
    }

    private async fetchEventMarketFromSite(eventSlug: string): Promise<any | null> {
        const cache = (this as any).crypto15mEventCache as Map<string, { atMs: number; market: any | null }> | undefined;
        const c = cache?.get(eventSlug);
        if (c && Date.now() - c.atMs < 60_000) return c.market;
        try {
            const url = `https://polymarket.com/event/${encodeURIComponent(eventSlug)}`;
            const headers: any = {
                'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'accept-language': 'en-US,en;q=0.9',
                'cache-control': 'no-cache',
                'pragma': 'no-cache',
            };
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), 6_000);
            const res = await this.withTimeout(
                fetch(url, { headers, signal: controller.signal }).finally(() => clearTimeout(t)),
                6_500,
                `Site event ${eventSlug}`
            );
            if (!res.ok) {
                if (!(this as any).crypto15mEventCache) (this as any).crypto15mEventCache = new Map();
                (this as any).crypto15mEventCache.set(eventSlug, { atMs: Date.now(), market: null });
                return null;
            }
            const html = await this.withTimeout(res.text(), 4_000, `Site event html ${eventSlug}`);
            const m = html.match(/id=\"__NEXT_DATA__\"[^>]*>([\s\S]*?)<\/script>/i);
            if (!m || !m[1]) return null;
            const data = JSON.parse(m[1]);
            const found = this.findObjectDeep(data, (x: any) => x?.slug === eventSlug && x?.conditionId && x?.outcomes && x?.outcomePrices && x?.clobTokenIds);
            if (!(this as any).crypto15mEventCache) (this as any).crypto15mEventCache = new Map();
            (this as any).crypto15mEventCache.set(eventSlug, { atMs: Date.now(), market: found });
            return found;
        } catch {
            return null;
        }
    }

    private async fetchCrypto15mBeatAndCurrentFromSite(eventSlug: string): Promise<{ priceToBeat: number | null; currentPrice: number | null; deltaAbs: number | null; error: string | null }> {
        const slug = String(eventSlug || '').trim().toLowerCase();
        if (!slug) return { priceToBeat: null, currentPrice: null, deltaAbs: null, error: 'Missing event slug' };
        const cached = this.crypto15mBeatCache.get(slug);
        if (cached && Date.now() - cached.atMs < 2_000) {
            return { priceToBeat: cached.priceToBeat, currentPrice: cached.currentPrice, deltaAbs: cached.deltaAbs, error: cached.error };
        }
        const parts = slug.split('-');
        const last = parts[parts.length - 1];
        const startSec = Number(last);
        if (!Number.isFinite(startSec) || startSec < 1_500_000_000) {
            const out = { atMs: Date.now(), priceToBeat: null, currentPrice: null, deltaAbs: null, error: 'Invalid market slug timestamp' };
            this.crypto15mBeatCache.set(slug, out);
            return { priceToBeat: null, currentPrice: null, deltaAbs: null, error: out.error };
        }
        const startMs = Math.floor(startSec) * 1000;
        const symbol =
            slug.startsWith('btc-') ? 'BTC'
            : slug.startsWith('eth-') ? 'ETH'
            : slug.startsWith('sol-') ? 'SOL'
            : slug.startsWith('xrp-') ? 'XRP'
            : null;
        if (!symbol) {
            const out = { atMs: Date.now(), priceToBeat: null, currentPrice: null, deltaAbs: null, error: 'Unsupported symbol for delta thresholds' };
            this.crypto15mBeatCache.set(slug, out);
            return { priceToBeat: null, currentPrice: null, deltaAbs: null, error: out.error };
        }
        const binSymbol = symbol === 'BTC' ? 'BTCUSDT' : symbol === 'ETH' ? 'ETHUSDT' : symbol === 'SOL' ? 'SOLUSDT' : 'XRPUSDT';
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 6_000);
        try {
            const spotRes = await this.withTimeout(
                fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${binSymbol}`, { signal: controller.signal }).finally(() => clearTimeout(t)),
                6_500,
                `Binance spot ${binSymbol}`
            );
            if (!spotRes.ok) throw new Error(`Binance spot HTTP ${spotRes.status}`);
            const spotJson: any = await this.withTimeout(spotRes.json(), 3_000, `Binance spot json ${binSymbol}`);
            const currentPrice = spotJson?.price != null ? Number(spotJson.price) : null;
            if (currentPrice == null || !Number.isFinite(currentPrice)) throw new Error('Binance spot missing price');

            const kRes = await this.withTimeout(
                fetch(`https://api.binance.com/api/v3/klines?symbol=${binSymbol}&interval=1m&startTime=${startMs}&limit=1`, { signal: controller.signal }),
                6_500,
                `Binance kline ${binSymbol}`
            );
            if (!kRes.ok) throw new Error(`Binance kline HTTP ${kRes.status}`);
            const kJson: any = await this.withTimeout(kRes.json(), 3_000, `Binance kline json ${binSymbol}`);
            const open = Array.isArray(kJson) && kJson[0] && kJson[0][1] != null ? Number(kJson[0][1]) : null;
            const priceToBeat = open != null && Number.isFinite(open) ? open : null;
            const deltaAbs = priceToBeat != null ? Math.abs(currentPrice - priceToBeat) : null;
            const out = { atMs: Date.now(), priceToBeat, currentPrice, deltaAbs, error: null };
            this.crypto15mBeatCache.set(slug, out);
            return { priceToBeat, currentPrice, deltaAbs, error: null };
        } catch (e: any) {
            const msg = e?.message || String(e);
            const out = { atMs: Date.now(), priceToBeat: null, currentPrice: null, deltaAbs: null, error: msg };
            this.crypto15mBeatCache.set(slug, out);
            return { priceToBeat: null, currentPrice: null, deltaAbs: null, error: msg };
        }
    }

    private getCryptoAllTimeframeSec(tf: '5m' | '15m' | '1h' | '4h' | '1d'): number {
        if (tf === '5m') return 5 * 60;
        if (tf === '1h') return 60 * 60;
        if (tf === '4h') return 4 * 60 * 60;
        if (tf === '1d') return 24 * 60 * 60;
        return 15 * 60;
    }

    private getCryptoAllListPaths(tf: '5m' | '15m' | '1h' | '4h' | '1d'): string[] {
        if (tf === '5m') return ['/crypto/5M', '/crypto/5m'];
        if (tf === '15m') return ['/crypto/15M'];
        if (tf === '1h') return ['/crypto/hourly', '/crypto/1H', '/crypto/1-hour', '/crypto/1hour', '/crypto/hour'];
        if (tf === '4h') return ['/crypto/4H', '/crypto/4-hour', '/crypto/4hour', '/crypto/4-hours', '/crypto/4hours'];
        return ['/crypto/daily', '/crypto/1D', '/crypto/1d', '/crypto/1-day', '/crypto/1day', '/crypto/24h'];
    }

    private predictCryptoAllSlugs(tf: '5m' | '15m' | '1h' | '4h' | '1d', nowSec: number, symbols: string[]): string[] {
        const tfSec = this.getCryptoAllTimeframeSec(tf);
        const baseStart = Math.floor(nowSec / tfSec) * tfSec;
        const starts = [baseStart - tfSec, baseStart, baseStart + tfSec, baseStart + 2 * tfSec];
        const symList = symbols.length ? symbols : ['BTC', 'ETH', 'SOL', 'XRP'];
        const tfTokens =
            tf === '5m' ? ['5m', '5M', '5min', '5mins', '5-min', '5-minute', '5minutes']
            : tf === '15m' ? ['15m', '15M', '15min', '15mins', '15-min', '15-minute', '15minutes']
            : tf === '1h' ? ['1h', '1H', '1hr', 'hourly', '1-hour', '1hour', '60m', '60min']
            : tf === '4h' ? ['4h', '4H', '4hr', '4hour', '4-hour', '4hours', '4-hours', '240m', '240min']
            : ['1d', '1D', 'daily', '1day', '1-day', '24h', '24hr', '24-hour', '24hours', '24-hours'];
        const slugs: string[] = [];
        for (const sym of symList) {
            const s = String(sym || '').toLowerCase();
            for (const token of tfTokens) {
                const t = String(token || '').toLowerCase();
                const prefixes = [`${s}-updown-${t}`, `${s}-up-or-down-${t}`];
                for (const st of starts) {
                    for (const prefix of prefixes) {
                        slugs.push(`${prefix}-${Math.floor(st)}`);
                    }
                }
            }
        }
        return Array.from(new Set(slugs));
    }

    private inferCryptoSymbolFromText(slug: string, title: string): 'BTC' | 'ETH' | 'SOL' | 'XRP' | null {
        const s = String(slug || '').toLowerCase();
        const t = String(title || '').toLowerCase();
        if (s.startsWith('btc-') || s.includes('bitcoin') || t.includes('bitcoin')) return 'BTC';
        if (s.startsWith('eth-') || s.includes('ethereum') || t.includes('ethereum')) return 'ETH';
        if (s.startsWith('sol-') || s.includes('solana') || t.includes('solana')) return 'SOL';
        if (s.startsWith('xrp-') || s.includes('xrp') || t.includes('xrp')) return 'XRP';
        return null;
    }

    private getBinanceSymbol(symbol: string): string | null {
        const s = String(symbol || '').toUpperCase();
        if (s === 'BTC') return 'BTCUSDT';
        if (s === 'ETH') return 'ETHUSDT';
        if (s === 'SOL') return 'SOLUSDT';
        if (s === 'XRP') return 'XRPUSDT';
        return null;
    }

    private getLastClosedMinuteOpenMs(nowMs: number): number {
        const now = Math.floor(Number(nowMs) || 0);
        const floor = Math.floor(now / 60_000) * 60_000;
        return floor - 60_000;
    }

    private async fetchBinanceSpotPrice(options: { binSymbol: string; nowMs?: number }): Promise<{ price: number | null; error: string | null }> {
        const binSymbol = String(options.binSymbol || '').toUpperCase();
        if (!binSymbol) return { price: null, error: 'Missing binSymbol' };
        const now = options.nowMs != null ? Math.floor(Number(options.nowMs) || 0) : Date.now();
        const cacheKey = `${binSymbol}:spot`;
        const cached = this.cryptoAllBinanceSpotCache.get(cacheKey);
        if (cached && now - cached.atMs < 500) return { price: cached.price, error: cached.error };
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 1_500);
        try {
            const res = await this.withTimeout(
                fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(binSymbol)}`, { signal: controller.signal }).finally(() => clearTimeout(t)),
                2_000,
                `Binance spot ${binSymbol}`
            );
            if (!res.ok) throw new Error(`Binance spot HTTP ${res.status}`);
            const json: any = await this.withTimeout(res.json(), 1_000, `Binance spot json ${binSymbol}`);
            const price = Number(json?.price);
            const out = { atMs: now, price: Number.isFinite(price) && price > 0 ? price : null, error: Number.isFinite(price) && price > 0 ? null : 'Invalid price' };
            this.cryptoAllBinanceSpotCache.set(cacheKey, out);
            return { price: out.price, error: out.error };
        } catch (e: any) {
            const msg = e?.message || String(e);
            this.cryptoAllBinanceSpotCache.set(cacheKey, { atMs: now, price: null, error: msg });
            return { price: null, error: msg };
        }
    }

    private async isBinanceTrendOkWithSpot(options: { symbol: string; minutes: number; direction?: 'Up' | 'Down'; nowMs?: number; spotPriceOverride?: number; allowEqual?: boolean }): Promise<{ ok: boolean; closes: number[]; lastClose: number | null; spot: number | null; error: string | null }> {
        const sym = String(options.symbol || '').toUpperCase();
        const binSymbol = this.getBinanceSymbol(sym);
        const m = Math.max(1, Math.min(10, Math.floor(Number(options.minutes) || 0)));
        if (!binSymbol) return { ok: false, closes: [], lastClose: null, spot: null, error: 'Unsupported symbol' };
        const dir: 'Up' | 'Down' = options.direction === 'Down' ? 'Down' : 'Up';
        const allowEqual = options.allowEqual === true;
        const now = options.nowMs != null ? Math.floor(Number(options.nowMs) || 0) : Date.now();
        const lastClosedOpenMs = this.getLastClosedMinuteOpenMs(now);
        if (!(lastClosedOpenMs > 0)) return { ok: false, closes: [], lastClose: null, spot: null, error: 'Invalid time' };
        const startMs = lastClosedOpenMs - m * 60_000;
        const candle = await this.fetchBinance1mCandleWindow({ binSymbol, startMs, minutes: m + 1 });
        const closes = Array.isArray(candle.closes1m) ? candle.closes1m.filter((x) => Number.isFinite(Number(x))) : [];
        if (closes.length < m + 1) return { ok: false, closes, lastClose: closes.length ? closes[closes.length - 1] : null, spot: null, error: candle.error || 'Insufficient klines' };

        let candleOk = true;
        for (let i = closes.length - m; i < closes.length; i++) {
            const prev = closes[i - 1];
            const cur = closes[i];
            if (dir === 'Up') {
                if (!(allowEqual ? (Number(cur) >= Number(prev)) : (Number(cur) > Number(prev)))) { candleOk = false; break; }
            } else {
                if (!(allowEqual ? (Number(cur) <= Number(prev)) : (Number(cur) < Number(prev)))) { candleOk = false; break; }
            }
        }
        const lastClose = Number(closes[closes.length - 1]);

        const spotRaw = Number.isFinite(Number(options.spotPriceOverride)) ? Number(options.spotPriceOverride) : (await this.fetchBinanceSpotPrice({ binSymbol, nowMs: now })).price;
        const spot = Number(spotRaw);
        if (!(Number.isFinite(spot) && spot > 0)) return { ok: false, closes, lastClose: Number.isFinite(lastClose) ? lastClose : null, spot: null, error: 'spot_unavailable' };

        const spotOk = dir === 'Up' ? (allowEqual ? spot >= lastClose : spot > lastClose) : (allowEqual ? spot <= lastClose : spot < lastClose);
        return { ok: candleOk && spotOk, closes, lastClose, spot, error: null };
    }

    private async isBinanceUpPerMinute(symbol: string, minutes: number, direction?: 'Up' | 'Down'): Promise<{ ok: boolean; closes: number[]; error: string | null }> {
        const sym = String(symbol || '').toUpperCase();
        const binSymbol = this.getBinanceSymbol(sym);
        const m = Math.max(1, Math.min(10, Math.floor(Number(minutes) || 0)));
        if (!binSymbol) return { ok: false, closes: [], error: 'Unsupported symbol' };
        const dir: 'Up' | 'Down' = direction === 'Down' ? 'Down' : 'Up';
        const endMs = Date.now();
        const startMsRaw = endMs - (m + 1) * 60_000;
        const startMs = Math.floor(startMsRaw / 60_000) * 60_000;
        const candle = await this.fetchBinance1mCandleWindow({ binSymbol, startMs, minutes: m + 1 });
        const closes = Array.isArray(candle.closes1m) ? candle.closes1m.filter((x) => Number.isFinite(Number(x))) : [];
        if (closes.length < m + 1) return { ok: false, closes, error: candle.error || 'Insufficient klines' };
        for (let i = closes.length - m; i < closes.length; i++) {
            const prev = closes[i - 1];
            const cur = closes[i];
            if (dir === 'Up') {
                if (!(Number(cur) > Number(prev))) return { ok: false, closes, error: null };
            } else {
                if (!(Number(cur) < Number(prev))) return { ok: false, closes, error: null };
            }
        }
        return { ok: true, closes, error: null };
    }

    private async fetchBinance1mCandleWindow(options: { binSymbol: string; startMs: number; minutes: number }): Promise<{ startMs: number; open: number | null; high: number | null; low: number | null; close: number | null; closes1m: number[]; error: string | null }> {
        const binSymbol = String(options.binSymbol || '').toUpperCase();
        const startMs = Math.floor(Number(options.startMs) || 0);
        const minutes = Math.max(1, Math.min(60, Math.floor(Number(options.minutes) || 0)));
        if (!binSymbol) return { startMs, open: null, high: null, low: null, close: null, closes1m: [], error: 'Missing binSymbol' };
        if (!Number.isFinite(startMs) || startMs <= 0) return { startMs, open: null, high: null, low: null, close: null, closes1m: [], error: 'Invalid startMs' };
        const cacheKey = `${binSymbol}:1m:${startMs}:${minutes}`;
        const cached = this.cryptoAllBinanceCandleCache.get(cacheKey);
        if (cached && Date.now() - cached.atMs < 900) {
            return { startMs: cached.startMs, open: cached.open, high: cached.high, low: cached.low, close: cached.close, closes1m: cached.closes1m, error: cached.error };
        }
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 6_000);
        try {
            const res = await this.withTimeout(
                fetch(`https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(binSymbol)}&interval=1m&startTime=${startMs}&limit=${minutes}`, { signal: controller.signal }).finally(() => clearTimeout(t)),
                6_500,
                `Binance klines window ${binSymbol}`
            );
            if (!res.ok) throw new Error(`Binance klines HTTP ${res.status}`);
            const json: any = await this.withTimeout(res.json(), 3_000, `Binance klines window json ${binSymbol}`);
            const list = Array.isArray(json) ? json : [];
            let open: number | null = null;
            let high: number | null = null;
            let low: number | null = null;
            let close: number | null = null;
            const closes1m: number[] = [];
            for (let i = 0; i < list.length; i++) {
                const row = list[i];
                if (!Array.isArray(row) || row.length < 5) continue;
                const o = Number(row[1]);
                const h = Number(row[2]);
                const l = Number(row[3]);
                const c = Number(row[4]);
                if (i === 0 && Number.isFinite(o)) open = o;
                if (Number.isFinite(h)) high = high == null ? h : Math.max(high, h);
                if (Number.isFinite(l)) low = low == null ? l : Math.min(low, l);
                if (Number.isFinite(c)) {
                    close = c;
                    closes1m.push(c);
                }
            }
            const out = { atMs: Date.now(), startMs, open, high, low, close, closes1m, error: null as string | null };
            this.cryptoAllBinanceCandleCache.set(cacheKey, out);
            return { startMs, open, high, low, close, closes1m, error: null };
        } catch (e: any) {
            const msg = e?.message || String(e);
            const out = { atMs: Date.now(), startMs, open: null, high: null, low: null, close: null, closes1m: [], error: msg };
            this.cryptoAllBinanceCandleCache.set(cacheKey, out);
            return { startMs, open: null, high: null, low: null, close: null, closes1m: [], error: msg };
        }
    }

    private async fetchCryptoAllBeatAndCurrentFromBinance(options: { symbol: string; endMs: number; timeframeSec: number }): Promise<{ priceToBeat: number | null; currentPrice: number | null; deltaAbs: number | null; error: string | null }> {
        const symbol = String(options.symbol || '').toUpperCase();
        const binSymbol = this.getBinanceSymbol(symbol);
        if (!binSymbol) return { priceToBeat: null, currentPrice: null, deltaAbs: null, error: 'Unsupported symbol for delta thresholds' };
        const endMs = Number(options.endMs);
        const timeframeSec = Number(options.timeframeSec);
        if (!Number.isFinite(endMs) || !Number.isFinite(timeframeSec) || timeframeSec <= 0) return { priceToBeat: null, currentPrice: null, deltaAbs: null, error: 'Invalid endMs/timeframeSec' };

        const startMsRaw = endMs - Math.floor(timeframeSec) * 1000;
        const startMs = Math.floor(startMsRaw / 60_000) * 60_000;
        const cacheKey = `${binSymbol}:${startMs}`;
        const cached = this.cryptoAllBeatCache.get(cacheKey);
        if (cached && Date.now() - cached.atMs < 2_000) {
            return { priceToBeat: cached.priceToBeat, currentPrice: cached.currentPrice, deltaAbs: cached.deltaAbs, error: cached.error };
        }

        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 6_000);
        try {
            const spotRes = await this.withTimeout(
                fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${binSymbol}`, { signal: controller.signal }).finally(() => clearTimeout(t)),
                6_500,
                `Binance spot ${binSymbol}`
            );
            if (!spotRes.ok) throw new Error(`Binance spot HTTP ${spotRes.status}`);
            const spotJson: any = await this.withTimeout(spotRes.json(), 3_000, `Binance spot json ${binSymbol}`);
            const currentPrice = spotJson?.price != null ? Number(spotJson.price) : null;
            if (currentPrice == null || !Number.isFinite(currentPrice)) throw new Error('Binance spot missing price');

            const kRes = await this.withTimeout(
                fetch(`https://api.binance.com/api/v3/klines?symbol=${binSymbol}&interval=1m&startTime=${startMs}&limit=1`, { signal: controller.signal }),
                6_500,
                `Binance kline ${binSymbol}`
            );
            if (!kRes.ok) throw new Error(`Binance kline HTTP ${kRes.status}`);
            const kJson: any = await this.withTimeout(kRes.json(), 3_000, `Binance kline json ${binSymbol}`);
            const open = Array.isArray(kJson) && kJson[0] && kJson[0][1] != null ? Number(kJson[0][1]) : null;
            const priceToBeat = open != null && Number.isFinite(open) ? open : null;
            const deltaAbs = priceToBeat != null ? Math.abs(currentPrice - priceToBeat) : null;
            const out = { atMs: Date.now(), priceToBeat, currentPrice, deltaAbs, error: null };
            this.cryptoAllBeatCache.set(cacheKey, out);
            return { priceToBeat, currentPrice, deltaAbs, error: null };
        } catch (e: any) {
            const msg = e?.message || String(e);
            const out = { atMs: Date.now(), priceToBeat: null, currentPrice: null, deltaAbs: null, error: msg };
            this.cryptoAllBeatCache.set(cacheKey, out);
            return { priceToBeat: null, currentPrice: null, deltaAbs: null, error: msg };
        }
    }

    private async fetchBinanceKlinesByInterval(options: { symbol: string; interval: '5m' | '15m' | '1h' | '4h' | '1d'; limit: number }): Promise<any[]> {
        const symbol = String(options.symbol || '').toUpperCase();
        const binSymbol = this.getBinanceSymbol(symbol);
        if (!binSymbol) return [];
        const interval = options.interval;
        const limit = Math.max(1, Math.min(1000, Math.floor(Number(options.limit) || 0)));
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 6_000);
        try {
            const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(binSymbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
            const res = await this.withTimeout(
                fetch(url, { signal: controller.signal }).finally(() => clearTimeout(t)),
                6_500,
                `Binance klines ${binSymbol} ${interval}`
            );
            if (!res.ok) return [];
            const json: any = await this.withTimeout(res.json(), 3_000, `Binance klines json ${binSymbol} ${interval}`);
            return Array.isArray(json) ? json : [];
        } catch {
            return [];
        } finally {
            clearTimeout(t);
        }
    }

    private async fetchClobBooks(tokenIds: string[]): Promise<any[]> {
        const ids = Array.from(new Set((tokenIds || []).map((t) => String(t || '').trim()).filter((t) => t)));
        if (!ids.length) return [];
        const sortedKey = ids.slice().sort().join(',');
        const cache = (this as any).clobBooksCache as Map<string, { atMs: number; data: any[] }> | undefined;
        const cached = cache?.get(sortedKey);
        if (cached && Date.now() - cached.atMs < 1200) return cached.data;
        const globalMinIntervalMs = 2000;
        const globalState = ((this as any).clobBooksGlobalState ??= { nextAllowedAtMs: 0, blockedUntilMs: 0, blockedBackoffMs: 0, lastStatus: null as any, lastError: null as any });
        const nowMs = Date.now();
        if (globalState.blockedUntilMs && nowMs < globalState.blockedUntilMs) {
            if (cached) return cached.data;
            globalState.lastError = `blocked_until_${globalState.blockedUntilMs}`;
            throw new Error('CLOB /books blocked (backoff)');
        }
        if (globalState.nextAllowedAtMs && nowMs < globalState.nextAllowedAtMs) {
            if (cached) return cached.data;
            globalState.lastError = `throttled_until_${globalState.nextAllowedAtMs}`;
            throw new Error('CLOB /books throttled');
        }
        try {
            const attempt = async (chunkIds: string[], timeoutMs: number) => {
                const controller = new AbortController();
                const t = setTimeout(() => controller.abort(), timeoutMs);
                try {
                    const res = await this.withTimeout(
                        fetch('https://clob.polymarket.com/books', {
                            method: 'POST',
                            headers: {
                                'content-type': 'application/json',
                                'accept': 'application/json',
                                'user-agent': 'Mozilla/5.0',
                                'accept-language': 'en-US,en;q=0.9',
                            },
                            body: JSON.stringify(chunkIds.map((token_id) => ({ token_id }))),
                            signal: controller.signal,
                        }).finally(() => clearTimeout(t)),
                        timeoutMs + 500,
                        'CLOB /books'
                    );
                    globalState.lastStatus = res.status;
                    if (!res.ok) {
                        let detail: any = null;
                        let text: string | null = null;
                        try { detail = await res.json(); } catch {
                            try { text = await res.text(); } catch {}
                        }
                        const msg = detail?.error || detail?.message || (text ? String(text).slice(0, 180) : 'unknown');
                        if (res.status === 403) {
                            const next = globalState.blockedBackoffMs ? Math.min(180 * 60_000, globalState.blockedBackoffMs * 2) : 30 * 60_000;
                            globalState.blockedBackoffMs = next;
                            globalState.blockedUntilMs = Date.now() + next;
                            globalState.lastError = `blocked_403 backoffMs=${next}`;
                        } else {
                            globalState.lastError = `http_${res.status}`;
                        }
                        throw new Error(`CLOB /books failed (${res.status}): ${msg}`);
                    }
                    const ct = String(res.headers.get('content-type') || '');
                    if (!ct.toLowerCase().includes('application/json')) {
                        const text = await res.text().catch(() => '');
                        throw new Error(`CLOB /books non-json (${res.status}) ct=${ct} body=${String(text || '').slice(0, 180)}`);
                    }
                    const data = await res.json().catch(() => null);
                    return Array.isArray(data) ? data : [];
                } finally {
                    clearTimeout(t);
                }
            };
            const fetchOnce = async (chunkIds: string[]) => {
                let out: any[] = [];
                try {
                    out = await attempt(chunkIds, 2_000);
                } catch {
                    await new Promise(r => setTimeout(r, 250));
                    try {
                        out = await attempt(chunkIds, 3_500);
                    } catch {
                        await new Promise(r => setTimeout(r, 500));
                        out = await attempt(chunkIds, 5_000);
                    }
                }
                return out;
            };

            let out: any[] = [];
            const maxChunk = 200;
            if (ids.length <= 500) {
                out = await fetchOnce(ids);
            } else {
                for (let i = 0; i < ids.length; i += maxChunk) {
                    const chunk = ids.slice(i, i + maxChunk);
                    const r = await fetchOnce(chunk);
                    if (Array.isArray(r) && r.length) out = out.concat(r);
                }
            }
            if (!(this as any).clobBooksCache) (this as any).clobBooksCache = new Map();
            const cacheMap = (this as any).clobBooksCache as Map<string, { atMs: number; data: any[] }>;
            const atMs = Date.now();
            cacheMap.set(sortedKey, { atMs, data: out });
            for (const b of out) {
                const tid = String((b as any)?.token_id ?? (b as any)?.tokenId ?? (b as any)?.tokenID ?? (b as any)?.asset_id ?? '').trim();
                if (!tid) continue;
                cacheMap.set(tid, { atMs, data: [b] });
            }
            globalState.nextAllowedAtMs = Date.now() + globalMinIntervalMs;
            globalState.lastError = null;
            globalState.blockedUntilMs = 0;
            globalState.blockedBackoffMs = 0;
            return out;
        } finally {
        }
    }

    private async fetchClobBookSingle(tokenId: string, options?: { minIntervalMs?: number; timeoutMs?: number }): Promise<any> {
        const tid = String(tokenId || '').trim();
        if (!tid) throw new Error('Missing tokenId');
        const minIntervalMs = Math.max(50, Math.floor(Number(options?.minIntervalMs) || 400));
        const cache = ((this as any).clobBookSingleCache ??= new Map()) as Map<string, { atMs: number; data: any }>;
        const inFlight = ((this as any).clobBookSingleInFlight ??= new Map()) as Map<string, Promise<any>>;
        const cached = cache.get(tid);
        const now = Date.now();
        if (cached && now - cached.atMs < minIntervalMs) return cached.data;
        const cur = inFlight.get(tid);
        if (cur) return cur;
        const p = (async () => {
            try {
                const books = await this.fetchClobBooks([tid]).catch(() => []);
                const data = Array.isArray(books) && books.length ? books[0] : null;
                cache.set(tid, { atMs: Date.now(), data });
                return data;
            } finally {
                inFlight.delete(tid);
            }
        })();
        inFlight.set(tid, p);
        return await p;
    }

    private pushCrypto15mBook60sSample(sample: { tokenId: string; sec: number; bestAsk: number | null; bestBid: number | null; topAskSize: number | null; topAskUsd: number | null; depthUsd980: number | null; depthUsd999: number | null; asksCount: number; bidsCount: number }) {
        const tokenId = String(sample.tokenId || '').trim();
        if (!tokenId) return;
        const sec = Math.max(0, Math.floor(Number(sample.sec) || 0));
        if (!sec) return;
        const map = ((this as any).crypto15mBook60sByTokenId ??= new Map()) as Map<string, any[]>;
        const prev = map.get(tokenId) || [];
        const last = prev.length ? prev[prev.length - 1] : null;
        const item = {
            sec,
            bestAsk: sample.bestAsk != null && Number.isFinite(Number(sample.bestAsk)) ? Number(sample.bestAsk) : null,
            bestBid: sample.bestBid != null && Number.isFinite(Number(sample.bestBid)) ? Number(sample.bestBid) : null,
            topAskSize: sample.topAskSize != null && Number.isFinite(Number(sample.topAskSize)) ? Number(sample.topAskSize) : null,
            topAskUsd: sample.topAskUsd != null && Number.isFinite(Number(sample.topAskUsd)) ? Number(sample.topAskUsd) : null,
            depthUsd980: sample.depthUsd980 != null && Number.isFinite(Number(sample.depthUsd980)) ? Number(sample.depthUsd980) : null,
            depthUsd999: sample.depthUsd999 != null && Number.isFinite(Number(sample.depthUsd999)) ? Number(sample.depthUsd999) : null,
            asksCount: Math.max(0, Math.floor(Number(sample.asksCount) || 0)),
            bidsCount: Math.max(0, Math.floor(Number(sample.bidsCount) || 0)),
        };
        if (last && Number(last.sec) === sec) {
            prev[prev.length - 1] = item;
        } else {
            prev.push(item);
        }
        while (prev.length > 70) prev.shift();
        map.set(tokenId, prev);
    }

    private getCrypto15mBook60sSnapshot(tokenId: string, endMs?: number): { endSec: number; points: any[] } {
        const tid = String(tokenId || '').trim();
        const endSec = Math.max(0, Math.floor(Number.isFinite(Number(endMs)) ? Number(endMs) / 1000 : Date.now() / 1000));
        if (!tid) return { endSec, points: [] };
        const map = ((this as any).crypto15mBook60sByTokenId ??= new Map()) as Map<string, any[]>;
        const list = map.get(tid) || [];
        const startSec = Math.max(0, endSec - 59);
        const points = list.filter((p: any) => Number(p?.sec) >= startSec && Number(p?.sec) <= endSec);
        return { endSec, points };
    }


    private async refreshCrypto15mMarketSnapshot(): Promise<void> {
        if (this.crypto15mMarketInFlight) return this.crypto15mMarketInFlight;
        if (this.crypto15mMarketNextAllowedAtMs && Date.now() < this.crypto15mMarketNextAllowedAtMs) return;
        this.crypto15mMarketInFlight = (async () => {
            let diag: any = null;
            try {
                const now = Date.now();
                const nowSec = Math.floor(now / 1000);
                const is15m = (m: any) => {
                    const title = String(m?.question || m?.title || '').toLowerCase();
                    const slug = String(m?.slug || '').toLowerCase();
                    return this.matchesCryptoAllTimeframe('15m', slug, title);
                };
                const parseStartSecFromSlug = (slug: string): number | null => {
                    const parts = String(slug || '').split('-');
                    const last = parts[parts.length - 1];
                    const n = Number(last);
                    if (!Number.isFinite(n)) return null;
                    if (n < 1_500_000_000) return null;
                    return Math.floor(n);
                };
                const maxSlugs = 80;
                const resolveMarkets = async (slugs: string[]): Promise<any[]> => {
                    const settled = await Promise.allSettled(slugs.map(async (slug) => {
                        const url = `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}&limit=1`;
                        const data = await this.withTimeout(this.fetchGammaJson(url), 5_000, `Gamma slug ${slug}`);
                        const list = Array.isArray(data) ? data : [];
                        return list[0] || null;
                    }));
                    const out: any[] = [];
                    for (const r of settled) {
                        if (r.status !== 'fulfilled') continue;
                        if (r.value) out.push(r.value);
                    }
                    return out;
                };

                const predicted = this.predictCryptoAllSlugs('15m', nowSec, ['BTC', 'ETH', 'SOL', 'XRP']);
                const tfSec = this.getCryptoAllTimeframeSec('15m');
                const baseStart = Math.floor(nowSec / tfSec) * tfSec;
                diag = {
                    atMs: Date.now(),
                    nowSec,
                    baseStart,
                    predictedCount: predicted.length,
                    siteSlugsCount: 0,
                    wantedSlugs: [] as string[],
                    marketsFetched: 0,
                    baseMarkets: 0,
                };

                const pickOnePerSymbol = (slugsRaw: any[]): string[] => {
                    const bucket = new Map<string, Array<{ slug: string; endMs: number | null }>>();
                    for (const raw of slugsRaw || []) {
                        const slug = String(raw || '').trim().toLowerCase();
                        if (!slug) continue;
                        if (!this.matchesCryptoAllTimeframe('15m', slug, slug)) continue;
                        const sym = this.inferCryptoSymbolFromText(slug, '');
                        if (!sym) continue;
                        const startSec = parseStartSecFromSlug(slug);
                        const endMs = startSec != null ? (startSec + 15 * 60) * 1000 : null;
                        if (!bucket.has(sym)) bucket.set(sym, []);
                        bucket.get(sym)!.push({ slug, endMs });
                    }
                    const out: string[] = [];
                    const maxAheadMs = 2 * 60 * 60_000;
                    for (const sym of ['BTC', 'ETH', 'SOL', 'XRP']) {
                        const arr = (bucket.get(sym) || []).filter((x) => x.endMs != null && x.endMs > now && (x.endMs - now) <= maxAheadMs);
                        arr.sort((a, b) => {
                            const ae = a.endMs == null ? Number.POSITIVE_INFINITY : a.endMs;
                            const be = b.endMs == null ? Number.POSITIVE_INFINITY : b.endMs;
                            return ae - be;
                        });
                        if (arr[0]?.slug) out.push(arr[0].slug);
                    }
                    return out;
                };

                const siteSlugs = await this.fetchCryptoSlugsFromSitePath('/crypto/15M', 200).catch(() => []);
                diag.siteSlugsCount = Array.isArray(siteSlugs) ? siteSlugs.length : 0;
                const wantedFromSite = pickOnePerSymbol(siteSlugs as any[]);

                const wantedFromPred: string[] = [];
                if (wantedFromSite.length < 4) {
                    const bySym = new Map<string, string[]>();
                    for (const raw of predicted) {
                        const slug = String(raw || '').trim().toLowerCase();
                        if (!slug) continue;
                        if (!this.matchesCryptoAllTimeframe('15m', slug, slug)) continue;
                        const sym = this.inferCryptoSymbolFromText(slug, '');
                        if (!sym) continue;
                        if (!bySym.has(sym)) bySym.set(sym, []);
                        bySym.get(sym)!.push(slug);
                    }
                    for (const sym of ['BTC', 'ETH', 'SOL', 'XRP']) {
                        if (wantedFromSite.some((s) => s.startsWith(sym.toLowerCase() + '-'))) continue;
                        const arr = bySym.get(sym) || [];
                        let best: { slug: string; endMs: number } | null = null;
                        for (const slug of arr) {
                            const startSec = parseStartSecFromSlug(slug);
                            if (startSec == null) continue;
                            const endMs = (startSec + 15 * 60) * 1000;
                            if (!(endMs > now)) continue;
                            if (!best || endMs < best.endMs) best = { slug, endMs };
                        }
                        const picked = best?.slug || arr[0];
                        if (picked) wantedFromPred.push(picked);
                    }
                }
                diag.wantedFromSite = wantedFromSite.slice();
                diag.wantedFromPred = wantedFromPred.slice();
                const slugsToResolve = Array.from(new Set([...wantedFromSite, ...wantedFromPred])).slice(0, 8);
                diag.wantedSlugs = slugsToResolve.slice();

                const resolveWithRetry = async (slugs: string[]): Promise<any[]> => {
                    const uniq = Array.from(new Set(slugs.map((s) => String(s || '').trim()).filter(Boolean)));
                    if (!uniq.length) return [];
                    const outBySlug = new Map<string, any>();
                    let remain = uniq.slice();
                    for (let round = 0; round < 2 && remain.length; round++) {
                        const settled = await Promise.allSettled(remain.map(async (slug) => {
                            const url = `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}&limit=1`;
                            const data = await this.withTimeout(this.fetchGammaJson(url), 5_000, `Gamma slug ${slug}`);
                            const list = Array.isArray(data) ? data : [];
                            return { slug, m: list[0] || null };
                        }));
                        for (const r of settled) {
                            if (r.status !== 'fulfilled') continue;
                            if (r.value?.m) outBySlug.set(String(r.value.slug).toLowerCase(), r.value.m);
                        }
                        remain = remain.filter((s) => !outBySlug.has(String(s).toLowerCase()));
                        if (remain.length) await new Promise((r) => setTimeout(r, 250));
                    }
                    return Array.from(outBySlug.values());
                };

                const markets: any[] = await resolveWithRetry(slugsToResolve);
                diag.marketsFetched = markets.length;
                const baseMarkets: any[] = [];
                for (const m of markets) {
                    if (!m || !is15m(m)) continue;
                    const conditionId = String(m?.conditionId || m?.condition_id || '').trim();
                    if (!conditionId || !conditionId.startsWith('0x')) continue;
                    const end = m?.endDate || m?.endDateIso || m?.umaEndDate || m?.umaEndDateIso;
                    const endMsFromDate = Date.parse(String(end || ''));
                    const slugStartSec = parseStartSecFromSlug(String(m?.slug || ''));
                    let endMs = endMsFromDate;
                    let endMsSource: 'endDate' | 'slug' = 'endDate';
                    if (!Number.isFinite(endMs)) {
                        if (slugStartSec != null) {
                            endMs = (slugStartSec + 15 * 60) * 1000;
                            endMsSource = 'slug';
                        }
                    }
                    if (!Number.isFinite(endMs)) continue;
                    const outcomes = this.tryParseJsonArray(m?.outcomes);
                    const tokenIds = this.tryParseJsonArray(m?.clobTokenIds ?? m?.clob_token_ids ?? null);
                    if (outcomes.length < 2 || tokenIds.length < 2) continue;
                    const outsLower = outcomes.map((x) => String(x).toLowerCase());
                    const upIdx = outsLower.findIndex((x) => x.includes('up'));
                    const downIdx = outsLower.findIndex((x) => x.includes('down'));
                    if (upIdx < 0 || downIdx < 0) continue;
                    const upOutcome = outcomes[upIdx];
                    const downOutcome = outcomes[downIdx];
                    const upTokenId = tokenIds[upIdx];
                    const downTokenId = tokenIds[downIdx];
                    if (!upOutcome || !downOutcome || !upTokenId || !downTokenId) continue;
                    baseMarkets.push({
                        symbol: this.inferCryptoSymbolFromText(String(m?.slug || ''), String(m?.question || m?.title || '')),
                        conditionId,
                        slug: m?.slug,
                        title: m?.question || m?.title,
                        endMs,
                        endDate: new Date(endMs).toISOString(),
                        endMsSource,
                        outcomes: [upOutcome, downOutcome],
                        tokenIds: [upTokenId, downTokenId],
                        upIdx: 0,
                        downIdx: 1,
                    });
                }
                if (!baseMarkets.length) {
                    const tagId = await this.resolveCryptoTagId();
                    if (tagId) {
                        const pageSize = 50;
                        const maxPages = 6;
                        const wantedSyms = new Set<string>(['BTC', 'ETH', 'SOL', 'XRP']);
                        for (let page = 0; page < maxPages && wantedSyms.size; page++) {
                            const events = await this.fetchGammaCryptoEvents(tagId, pageSize, page * pageSize).catch(() => []);
                            if (!Array.isArray(events) || !events.length) break;
                            for (const ev of events) {
                                const evSlug = String((ev as any)?.slug || '').trim();
                                const evTitle = String((ev as any)?.title || (ev as any)?.question || '').trim();
                                const evEndIso = (ev as any)?.endDate ?? (ev as any)?.endDateIso ?? (ev as any)?.end_date ?? (ev as any)?.end_date_iso ?? null;
                                const marketsArr = Array.isArray((ev as any)?.markets) ? (ev as any).markets : [];
                                for (const mm of marketsArr) {
                                    const slug = String((mm as any)?.slug || (mm as any)?.marketSlug || evSlug || '').trim();
                                    const q = String((mm as any)?.question ?? (mm as any)?.title ?? evTitle ?? '').trim();
                                    if (!slug && !q) continue;
                                    if (!this.matchesCryptoAllTimeframe('15m', slug, q)) continue;
                                    const sym = this.inferCryptoSymbolFromText(slug, q);
                                    if (!sym || !wantedSyms.has(sym)) continue;
                                    const conditionId = String((mm as any)?.conditionId ?? (mm as any)?.condition_id ?? '').trim();
                                    if (!conditionId || !conditionId.startsWith('0x')) continue;
                                    const endIso = (mm as any)?.endDate ?? (mm as any)?.end_date ?? (mm as any)?.endDateIso ?? (mm as any)?.end_date_iso ?? evEndIso ?? null;
                                    const endMsFromDate = endIso ? Date.parse(String(endIso)) : NaN;
                                    const slugStartSec = parseStartSecFromSlug(slug);
                                    let endMs = endMsFromDate;
                                    let endMsSource: 'endDate' | 'slug' = 'endDate';
                                    if (!Number.isFinite(endMs) && slugStartSec != null) {
                                        endMs = (slugStartSec + 15 * 60) * 1000;
                                        endMsSource = 'slug';
                                    }
                                    if (!Number.isFinite(endMs) || endMs <= now) continue;
                                    const outcomes = this.tryParseJsonArray((mm as any)?.outcomes);
                                    const tokenIds = this.tryParseJsonArray((mm as any)?.clobTokenIds ?? (mm as any)?.clob_token_ids ?? null);
                                    if (outcomes.length < 2 || tokenIds.length < 2) continue;
                                    const outsLower = outcomes.map((x) => String(x).toLowerCase());
                                    const upIdx = outsLower.findIndex((x) => x.includes('up'));
                                    const downIdx = outsLower.findIndex((x) => x.includes('down'));
                                    if (upIdx < 0 || downIdx < 0) continue;
                                    const upOutcome = outcomes[upIdx];
                                    const downOutcome = outcomes[downIdx];
                                    const upTokenId = tokenIds[upIdx];
                                    const downTokenId = tokenIds[downIdx];
                                    if (!upOutcome || !downOutcome || !upTokenId || !downTokenId) continue;
                                    baseMarkets.push({
                                        symbol: sym,
                                        conditionId,
                                        slug,
                                        title: q,
                                        endMs,
                                        endDate: new Date(endMs).toISOString(),
                                        endMsSource,
                                        outcomes: [upOutcome, downOutcome],
                                        tokenIds: [upTokenId, downTokenId],
                                        upIdx: 0,
                                        downIdx: 1,
                                    });
                                    wantedSyms.delete(sym);
                                    if (!wantedSyms.size) break;
                                }
                                if (!wantedSyms.size) break;
                            }
                        }
                    }
                }
                const horizonMs = 60 * 60_000;
                const baseMarketsNear = baseMarkets.filter((m) => {
                    const endMs = Number(m?.endMs || 0);
                    if (!(endMs > now)) return false;
                    return (endMs - now) <= horizonMs;
                });
                diag.baseMarkets = baseMarketsNear.length;
                if (!baseMarketsNear.length) throw new Error('No 15m markets returned from Gamma');
                const bySym = new Map<string, any[]>();
                for (const m of baseMarketsNear) {
                    const sym = String(m?.symbol || '').toUpperCase();
                    if (!sym) continue;
                    if (!bySym.has(sym)) bySym.set(sym, []);
                    bySym.get(sym)!.push(m);
                }
                for (const [sym, arr] of bySym.entries()) {
                    arr.sort((a: any, b: any) => (Number(a?.endMs) || 0) - (Number(b?.endMs) || 0));
                    bySym.set(sym, arr);
                }
                const finalMarkets: any[] = [];
                const seen = new Set<string>();
                for (const sym of ['BTC', 'ETH', 'SOL', 'XRP']) {
                    const m0 = (bySym.get(sym) || [])[0];
                    if (!m0) continue;
                    const k = `${String(m0?.conditionId || '')}:${String(m0?.slug || '')}`;
                    if (k.startsWith(':') || seen.has(k)) continue;
                    seen.add(k);
                    finalMarkets.push(m0);
                }

                if (finalMarkets.length < 4) {
                    const prevMarketsAll = Array.isArray(this.crypto15mMarketSnapshot.markets) ? this.crypto15mMarketSnapshot.markets : [];
                    const nowMs = Date.now();
                    for (const sym of ['BTC', 'ETH', 'SOL', 'XRP']) {
                        if (finalMarkets.some((m) => String(m?.symbol || '').toUpperCase() === sym)) continue;
                        const prev = prevMarketsAll
                            .filter((m: any) => String(m?.symbol || '').toUpperCase() === sym && Array.isArray(m?.tokenIds) && m.tokenIds.length >= 2)
                            .filter((m: any) => {
                                const endMs = Number(m?.endMs || 0);
                                return endMs > nowMs && (endMs - nowMs) <= horizonMs;
                            })
                            .sort((a: any, b: any) => (Number(a?.endMs) || 0) - (Number(b?.endMs) || 0))[0];
                        if (prev) finalMarkets.push(prev);
                    }
                }

                if (!finalMarkets.length) throw new Error('No 15m markets returned from Gamma');
                diag.symbolCounts = Object.fromEntries(Array.from(bySym.entries()).map(([k, v]) => [k, v.length]));
                this.crypto15mMarketSnapshot = { atMs: Date.now(), markets: finalMarkets.slice(0, 4), lastError: null };
                (this.crypto15mMarketSnapshot as any).diag = diag;
                this.crypto15mMarketBackoffMs = 0;
                this.crypto15mMarketNextAllowedAtMs = 0;
            } catch (e: any) {
                const msg = e?.message || String(e);
                const next = this.crypto15mMarketBackoffMs ? Math.min(30_000, this.crypto15mMarketBackoffMs * 2) : 1000;
                this.crypto15mMarketBackoffMs = next;
                this.crypto15mMarketNextAllowedAtMs = Date.now() + next;
                this.crypto15mMarketSnapshot = { ...this.crypto15mMarketSnapshot, atMs: Date.now(), lastError: msg };
                (this.crypto15mMarketSnapshot as any).diag = { ...(diag || {}), atMs: Date.now(), error: msg };
            } finally {
                this.crypto15mMarketInFlight = null;
            }
        })();
        return this.crypto15mMarketInFlight;
    }

    private async refreshCrypto15mBooksSnapshot(): Promise<void> {
        if (this.crypto15mBooksInFlight) return this.crypto15mBooksInFlight;
        const now = Date.now();
        const lastAt = this.crypto15mBooksSnapshot.atMs ? Number(this.crypto15mBooksSnapshot.atMs) : 0;
        const staleTooLong = lastAt > 0 ? (now - lastAt) > 10_000 : false;
        if (this.crypto15mBooksNextAllowedAtMs && now < this.crypto15mBooksNextAllowedAtMs && !staleTooLong) return;
        this.crypto15mBooksInFlight = (async () => {
            this.crypto15mBooksSnapshot = { ...this.crypto15mBooksSnapshot, lastAttemptAtMs: Date.now(), lastAttemptError: null };
            try {
                const marketsAll = Array.isArray(this.crypto15mMarketSnapshot.markets) ? this.crypto15mMarketSnapshot.markets : [];
                const markets = marketsAll
                    .filter((m: any) => Array.isArray(m?.tokenIds) && m.tokenIds.length >= 2)
                    .slice()
                    .sort((a: any, b: any) => (Number(a?.endMs) || 0) - (Number(b?.endMs) || 0))
                    .slice(0, 12);
                const tokenIds = Array.from(new Set(markets.flatMap((m: any) => Array.isArray(m?.tokenIds) ? m.tokenIds : []).map((t: any) => String(t || '').trim()).filter((t: any) => !!t)));
                if (!tokenIds.length) {
                    const reason = marketsAll.length ? 'No tokenIds for books refresh (markets missing tokenIds)' : 'No tokenIds for books refresh (no markets)';
                    this.crypto15mBooksSnapshot = { ...this.crypto15mBooksSnapshot, lastError: reason, lastAttemptError: reason };
                    return;
                }
                const prevByTokenId = this.crypto15mBooksSnapshot.byTokenId || {};
                const byTokenId: Record<string, any> = { ...prevByTokenId };
                for (const t of tokenIds) {
                    if (!byTokenId[t]) byTokenId[t] = { tokenId: t, timestamp: null, fetchedAtMs: null, asksCount: 0, bidsCount: 0, bestAsk: null, bestBid: null, error: 'stale' };
                }
                let books: any[] = [];
                let usedSdkFallback = false;
                try {
                    books = await this.fetchClobBooks(tokenIds);
                } catch {
                    const settled = await Promise.allSettled(tokenIds.map(async (tid) => {
                        const ob = await this.sdk.clobApi.getOrderbook(tid);
                        return { asset_id: tid, asks: Array.isArray((ob as any)?.asks) ? (ob as any).asks : [], bids: Array.isArray((ob as any)?.bids) ? (ob as any).bids : [], timestamp: (ob as any)?.timestamp ?? null };
                    }));
                    books = settled.filter((r) => r.status === 'fulfilled').map((r: any) => r.value);
                    if (!books.length) throw new Error('No orderbooks from sdk fallback');
                    usedSdkFallback = true;
                }
                const booksCache = !usedSdkFallback ? ((this as any).clobBooksCache as Map<string, { atMs: number; data: any[] }> | undefined) : undefined;
                for (const b of books) {
                    const tokenId = String(b?.token_id ?? b?.tokenId ?? b?.tokenID ?? b?.asset_id ?? b?.assetId ?? '').trim();
                    if (!tokenId) continue;
                    const asks = Array.isArray(b?.asks) ? b.asks : [];
                    const bids = Array.isArray(b?.bids) ? b.bids : [];
                    let bestAsk = NaN;
                    for (const a of asks) {
                        const p = Number(a?.price);
                        if (!Number.isFinite(p) || p <= 0) continue;
                        if (!Number.isFinite(bestAsk) || p < bestAsk) bestAsk = p;
                    }
                    let bestBid = NaN;
                    for (const bb of bids) {
                        const p = Number(bb?.price);
                        if (!Number.isFinite(p) || p <= 0) continue;
                        if (!Number.isFinite(bestBid) || p > bestBid) bestBid = p;
                    }
                    const fetchedAtMs = booksCache?.get(tokenId)?.atMs ?? Date.now();
                    const topAskPrice = Number(asks?.[0]?.price);
                    const topAskSize = Number(asks?.[0]?.size);
                    const topAskUsd = Number.isFinite(topAskPrice) && Number.isFinite(topAskSize) ? (topAskPrice * topAskSize) : null;
                    let depthUsd980 = 0;
                    let depthUsd999 = 0;
                    for (const a of asks.slice(0, 200)) {
                        const p = Number((a as any)?.price);
                        const s = Number((a as any)?.size);
                        if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(s) || s <= 0) continue;
                        if (p <= 0.98) depthUsd980 += p * s;
                        if (p <= 0.999) depthUsd999 += p * s;
                        else break;
                    }
                    byTokenId[tokenId] = {
                        tokenId,
                        timestamp: b?.timestamp ?? null,
                        fetchedAtMs,
                        asksCount: asks.length,
                        bidsCount: bids.length,
                        bestAsk: Number.isFinite(bestAsk) ? bestAsk : null,
                        bestBid: Number.isFinite(bestBid) ? bestBid : null,
                    };
                    this.pushCrypto15mBook60sSample({
                        tokenId,
                        sec: Math.floor(fetchedAtMs / 1000),
                        bestAsk: Number.isFinite(bestAsk) ? bestAsk : null,
                        bestBid: Number.isFinite(bestBid) ? bestBid : null,
                        topAskSize: Number.isFinite(topAskSize) ? topAskSize : null,
                        topAskUsd: topAskUsd != null && Number.isFinite(Number(topAskUsd)) ? Number(topAskUsd) : null,
                        depthUsd980: Number.isFinite(depthUsd980) ? depthUsd980 : null,
                        depthUsd999: Number.isFinite(depthUsd999) ? depthUsd999 : null,
                        asksCount: asks.length,
                        bidsCount: bids.length,
                    });
                }
                this.crypto15mBooksSnapshot = { ...this.crypto15mBooksSnapshot, atMs: Date.now(), byTokenId, lastError: null, lastAttemptError: null };
                this.crypto15mBooksBackoffMs = 0;
                this.crypto15mBooksNextAllowedAtMs = 0;
            } catch (e: any) {
                const msg = e?.message || String(e);
                const next = this.crypto15mBooksBackoffMs ? Math.min(30_000, this.crypto15mBooksBackoffMs * 2) : 1000;
                this.crypto15mBooksBackoffMs = next;
                this.crypto15mBooksNextAllowedAtMs = Date.now() + next;
                this.crypto15mBooksSnapshot = { ...this.crypto15mBooksSnapshot, lastError: msg, lastAttemptError: msg };
            } finally {
                this.crypto15mBooksInFlight = null;
            }
        })();
        return this.crypto15mBooksInFlight;
    }

    private async refreshCrypto15mBooksSnapshotTiered(options?: { targetFreshMs?: number }): Promise<void> {
        const desired = Number(options?.targetFreshMs);
        const staleMsThreshold = Number.isFinite(Number(this.crypto15mAutoConfig.staleMsThreshold)) ? Number(this.crypto15mAutoConfig.staleMsThreshold) : 1500;
        const targetFreshMs = Math.max(100, Math.floor(Number.isFinite(desired) ? desired : 500));
        const target = Math.min(targetFreshMs, Math.max(200, Math.floor(staleMsThreshold)));
        const markets = Array.isArray(this.crypto15mMarketSnapshot.markets) ? this.crypto15mMarketSnapshot.markets : [];
        const tokenIds = Array.from(new Set(markets.flatMap((m: any) => Array.isArray(m?.tokenIds) ? m.tokenIds : []).map((t: any) => String(t || '').trim()).filter((t) => !!t)));
        if (!tokenIds.length) return;

        const prevByTokenId = this.crypto15mBooksSnapshot.byTokenId || {};
        const byTokenId: Record<string, any> = { ...prevByTokenId };
        for (const t of tokenIds) {
            if (!byTokenId[t]) byTokenId[t] = { tokenId: t, timestamp: null, fetchedAtMs: null, asksCount: 0, bidsCount: 0, bestAsk: null, bestBid: null, error: 'stale' };
        }

        const now = Date.now();
        const needs = tokenIds.filter((tid) => {
            const prev = byTokenId[tid];
            const at = prev?.fetchedAtMs != null ? Number(prev.fetchedAtMs) : NaN;
            if (!Number.isFinite(at) || at <= 0) return true;
            return (now - at) > target;
        });
        if (!needs.length) return;

        this.crypto15mBooksSnapshot = { ...this.crypto15mBooksSnapshot, lastAttemptAtMs: Date.now(), lastAttemptError: null };
        const chunkSize = 80;
        const booksCache = (this as any).clobBooksCache as Map<string, { atMs: number; data: any[] }> | undefined;
        let anyOk = false;
        let firstErrMsg: string | null = null;
        for (let i = 0; i < needs.length; i += chunkSize) {
            const chunk = needs.slice(i, i + chunkSize);
            try {
                const books = await this.fetchClobBooks(chunk);
                if (Array.isArray(books) && books.length) anyOk = true;
                for (const b of books) {
                    const tokenId = String(b?.token_id ?? b?.tokenId ?? b?.tokenID ?? b?.asset_id ?? b?.assetId ?? '').trim();
                    if (!tokenId) continue;
                    const asks = Array.isArray(b?.asks) ? b.asks : [];
                    const bids = Array.isArray(b?.bids) ? b.bids : [];
                    let bestAsk = NaN;
                    for (const a of asks) {
                        const p = Number((a as any)?.price);
                        if (!Number.isFinite(p) || p <= 0) continue;
                        if (!Number.isFinite(bestAsk) || p < bestAsk) bestAsk = p;
                    }
                    let bestBid = NaN;
                    for (const bb of bids) {
                        const p = Number((bb as any)?.price);
                        if (!Number.isFinite(p) || p <= 0) continue;
                        if (!Number.isFinite(bestBid) || p > bestBid) bestBid = p;
                    }
                    const fetchedAtMs = booksCache?.get(tokenId)?.atMs ?? Date.now();
                    const topAskPrice = Number(asks?.[0]?.price);
                    const topAskSize = Number(asks?.[0]?.size);
                    const topAskUsd = Number.isFinite(topAskPrice) && Number.isFinite(topAskSize) ? (topAskPrice * topAskSize) : null;
                    let depthUsd980 = 0;
                    let depthUsd999 = 0;
                    for (const a of asks.slice(0, 200)) {
                        const p = Number((a as any)?.price);
                        const s = Number((a as any)?.size);
                        if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(s) || s <= 0) continue;
                        if (p <= 0.98) depthUsd980 += p * s;
                        if (p <= 0.999) depthUsd999 += p * s;
                        else break;
                    }
                    byTokenId[tokenId] = {
                        tokenId,
                        timestamp: b?.timestamp ?? null,
                        fetchedAtMs,
                        asksCount: asks.length,
                        bidsCount: bids.length,
                        bestAsk: Number.isFinite(bestAsk) ? bestAsk : null,
                        bestBid: Number.isFinite(bestBid) ? bestBid : null,
                    };
                    this.pushCrypto15mBook60sSample({
                        tokenId,
                        sec: Math.floor(fetchedAtMs / 1000),
                        bestAsk: Number.isFinite(bestAsk) ? bestAsk : null,
                        bestBid: Number.isFinite(bestBid) ? bestBid : null,
                        topAskSize: Number.isFinite(topAskSize) ? topAskSize : null,
                        topAskUsd: topAskUsd != null && Number.isFinite(Number(topAskUsd)) ? Number(topAskUsd) : null,
                        depthUsd980: Number.isFinite(depthUsd980) ? depthUsd980 : null,
                        depthUsd999: Number.isFinite(depthUsd999) ? depthUsd999 : null,
                        asksCount: asks.length,
                        bidsCount: bids.length,
                    });
                }
            } catch (e: any) {
                const msg = e?.message || String(e);
                if (!firstErrMsg) firstErrMsg = msg;
            }
        }
        if (!anyOk && firstErrMsg) {
            this.crypto15mBooksSnapshot = { ...this.crypto15mBooksSnapshot, atMs: Date.now(), byTokenId, lastAttemptError: firstErrMsg, lastError: this.crypto15mBooksSnapshot.lastError || null };
            return;
        }
        this.crypto15mBooksSnapshot = { ...this.crypto15mBooksSnapshot, atMs: Date.now(), byTokenId, lastError: null, lastAttemptError: firstErrMsg };
    }

    private buildCrypto15mCandidatesFromSnapshots(options?: { minProb?: number; expiresWithinSec?: number; limit?: number }) {
        const minProb = Math.max(0, Math.min(1, Number(options?.minProb ?? this.crypto15mAutoConfig.minProb)));
        const expiresWithinSec = Math.max(5, Math.floor(Number(options?.expiresWithinSec ?? this.crypto15mAutoConfig.expiresWithinSec)));
        const limit = Math.max(1, Math.floor(Number(options?.limit ?? 20)));
        const staleMsThreshold = Number.isFinite(Number(this.crypto15mAutoConfig.staleMsThreshold)) ? Number(this.crypto15mAutoConfig.staleMsThreshold) : 1500;
        const now = Date.now();
        const markets = Array.isArray(this.crypto15mMarketSnapshot.markets) ? this.crypto15mMarketSnapshot.markets : [];
        const byTokenId = this.crypto15mBooksSnapshot.byTokenId || {};
        const snapshotAt = this.crypto15mBooksSnapshot.atMs ? new Date(this.crypto15mBooksSnapshot.atMs).toISOString() : null;
        const snapshotStaleMs = this.crypto15mBooksSnapshot.atMs ? Math.max(0, now - this.crypto15mBooksSnapshot.atMs) : null;
        const booksAttemptAt = this.crypto15mBooksSnapshot.lastAttemptAtMs ? new Date(this.crypto15mBooksSnapshot.lastAttemptAtMs).toISOString() : null;
        const candidates: any[] = [];
        for (const m of markets) {
            const endMs = Number(m?.endMs);
            if (!Number.isFinite(endMs)) continue;
            const secondsToExpire = Math.floor((endMs - now) / 1000);
            if (!(secondsToExpire > 0)) continue;
            const outcomes = Array.isArray(m?.outcomes) ? m.outcomes : [];
            const tokenIds = Array.isArray(m?.tokenIds) ? m.tokenIds : [];
            const upIdx = Number.isFinite(Number(m?.upIdx)) ? Number(m.upIdx) : 0;
            const downIdx = Number.isFinite(Number(m?.downIdx)) ? Number(m.downIdx) : 1;
            if (outcomes.length < 2 || tokenIds.length < 2) continue;
            const books = tokenIds.slice(0, 2).map((t: any) => byTokenId[String(t || '').trim()] || null);
            const booksFetchedAtMs = books.map((b: any) => (b?.fetchedAtMs != null && Number.isFinite(Number(b.fetchedAtMs)) ? Number(b.fetchedAtMs) : null));
            const booksStaleMs = booksFetchedAtMs.map((at: any) => (at != null ? Math.max(0, now - Number(at)) : null));
            const prices = books.map((b: any) => {
                const ask = b?.bestAsk;
                return ask != null && Number.isFinite(Number(ask)) ? Number(ask) : NaN;
            });
            const hasAsk = books.map((b: any) => (b?.asksCount != null ? Number(b.asksCount) : 0) > 0);
            const upPrice = Number(prices[upIdx]);
            const downPrice = Number(prices[downIdx]);
            const upHasAsk = hasAsk[upIdx] === true;
            const downHasAsk = hasAsk[downIdx] === true;
            let chosenIndex = upIdx;
            if (downHasAsk && (!upHasAsk || (Number.isFinite(downPrice) && Number.isFinite(upPrice) && downPrice > upPrice))) chosenIndex = downIdx;
            if (!downHasAsk && upHasAsk) chosenIndex = upIdx;
            if (!upHasAsk && !downHasAsk) chosenIndex = -1;
            const chosenPrice = chosenIndex >= 0 ? Number(prices[chosenIndex]) : NaN;
            const chosenFetchedAtMs = chosenIndex >= 0 ? booksFetchedAtMs[chosenIndex] : null;
            const chosenStaleMs = chosenIndex >= 0 ? booksStaleMs[chosenIndex] : null;
            const eligibleByExpiry = secondsToExpire <= expiresWithinSec;
            const meetsMinProb = Number.isFinite(chosenPrice) ? chosenPrice >= minProb : false;
            const chosenHasAsk = chosenIndex >= 0 ? hasAsk[chosenIndex] === true : false;
        let reason: string | null = null;
        if (this.crypto15mBooksSnapshot.lastError) reason = 'books_error';
        else if (this.crypto15mMarketSnapshot.lastError) reason = 'market_error';
        else if (chosenStaleMs != null && chosenStaleMs > staleMsThreshold) reason = 'stale';
        else if (!chosenHasAsk) reason = 'no-asks';
        else if (!eligibleByExpiry) reason = 'expiry';
        else if (!meetsMinProb) reason = 'price';
            candidates.push({
                symbol: m?.symbol,
                conditionId: m?.conditionId,
                slug: m?.slug,
                title: m?.title,
                endDate: m?.endDate,
                endMs,
                endMsSource: m?.endMsSource,
                secondsToExpire,
                eligibleByExpiry,
                meetsMinProb,
                reason,
                outcomes: outcomes.slice(0, 2),
                tokenIds: tokenIds.slice(0, 2),
                prices,
                asksCount: books.map((b: any) => Number(b?.asksCount ?? 0)),
                bidsCount: books.map((b: any) => Number(b?.bidsCount ?? 0)),
                chosenIndex,
                chosenOutcome: chosenIndex >= 0 ? String(outcomes[chosenIndex]) : null,
                chosenPrice: Number.isFinite(chosenPrice) ? chosenPrice : null,
                chosenTokenId: chosenIndex >= 0 ? String(tokenIds[chosenIndex]) : null,
                chosenFetchedAtMs,
                snapshotAt,
                staleMs: chosenStaleMs,
                booksStaleMs,
                booksFetchedAtMs,
                snapshotStaleMs,
                booksError: this.crypto15mBooksSnapshot.lastError,
                booksAttemptAt,
                booksAttemptError: this.crypto15mBooksSnapshot.lastAttemptError,
                marketsError: this.crypto15mMarketSnapshot.lastError,
            });
        }
        candidates.sort((a, b) => {
            const aOk = a.meetsMinProb === true && a.eligibleByExpiry === true && a.reason == null;
            const bOk = b.meetsMinProb === true && b.eligibleByExpiry === true && b.reason == null;
            if (aOk !== bOk) return aOk ? -1 : 1;
            const ap = a.chosenPrice != null ? Number(a.chosenPrice) : NaN;
            const bp = b.chosenPrice != null ? Number(b.chosenPrice) : NaN;
            if (Number.isFinite(ap) && Number.isFinite(bp) && ap !== bp) return bp - ap;
            return Number(a.secondsToExpire) - Number(b.secondsToExpire);
        });
        const countEligible = candidates.filter((c) => c.meetsMinProb && c.eligibleByExpiry && c.reason == null).length;
        return {
            success: true,
            count: candidates.length,
            countEligible,
            candidates: candidates.slice(0, limit),
            snapshotAt,
            staleMs: snapshotStaleMs,
            booksAttemptAt,
            booksAttemptError: this.crypto15mBooksSnapshot.lastAttemptError,
            marketSnapshotAt: this.crypto15mMarketSnapshot.atMs ? new Date(this.crypto15mMarketSnapshot.atMs).toISOString() : null,
            marketError: this.crypto15mMarketSnapshot.lastError,
            booksError: this.crypto15mBooksSnapshot.lastError,
        };
    }

    private startCrypto15mWsLoop() {
        if (this.crypto15mWsTimer) return;
        const tick = async () => {
            if (!this.crypto15mWsClients.size) return;
            const now = Date.now();
            if (!this.crypto15mMarketSnapshot.atMs || now - this.crypto15mMarketSnapshot.atMs > 5_000) {
                await this.refreshCrypto15mMarketSnapshot();
            }
            const markets = Array.isArray(this.crypto15mMarketSnapshot.markets) ? this.crypto15mMarketSnapshot.markets : [];
            const soon = markets.some((m: any) => Number(m?.endMs ?? 0) - now < 2 * 60_000);
            const targetStale = soon ? 250 : 500;
            if (!this.crypto15mBooksSnapshot.atMs || now - this.crypto15mBooksSnapshot.atMs > targetStale) {
                await this.refreshCrypto15mBooksSnapshot();
            }
            const status = this.getCrypto15mStatus();
            for (const [socket, cfg] of this.crypto15mWsClients.entries()) {
                try {
                    const payload = this.buildCrypto15mCandidatesFromSnapshots(cfg);
                    socket.send(JSON.stringify({
                        type: 'snapshot',
                        at: new Date().toISOString(),
                        status,
                        candidates: payload,
                    }));
                } catch (e: any) {
                    try {
                        socket.send(JSON.stringify({ type: 'error', at: new Date().toISOString(), message: e?.message || String(e) }));
                    } catch {
                    }
                }
            }
        };
        this.crypto15mWsTimer = setInterval(() => tick().catch(() => {}), 250);
    }

    public addCrypto15mWsClient(socket: any, options: { minProb?: number; expiresWithinSec?: number; limit?: number }) {
        const minProb = Math.max(0, Math.min(1, Number(options?.minProb ?? this.crypto15mAutoConfig.minProb)));
        const expiresWithinSec = Math.max(5, Math.floor(Number(options?.expiresWithinSec ?? this.crypto15mAutoConfig.expiresWithinSec)));
        const limit = Math.max(1, Math.floor(Number(options?.limit ?? 20)));
        this.crypto15mWsClients.set(socket, { minProb, expiresWithinSec, limit });
        this.startCrypto15mWsLoop();
    }

    public removeCrypto15mWsClient(socket: any) {
        this.crypto15mWsClients.delete(socket);
        if (!this.crypto15mWsClients.size && this.crypto15mWsTimer) {
            clearInterval(this.crypto15mWsTimer);
            this.crypto15mWsTimer = null;
        }
    }

    private startCryptoAllWsLoop() {
        if (this.cryptoAllWsTimer) return;
        const cache = new Map<string, { atMs: number; candidates: any[] }>();
        const tick = async () => {
            if (!this.cryptoAllWsClients.size) return;
            const status = this.getCryptoAllStatus();
            const now = Date.now();
            for (const [socket, cfg] of this.cryptoAllWsClients.entries()) {
                const key = JSON.stringify({ symbols: cfg.symbols.slice().sort(), timeframes: cfg.timeframes.slice().sort(), minProb: cfg.minProb, expiresWithinSec: cfg.expiresWithinSec, expiresWithinSecByTimeframe: (cfg as any).expiresWithinSecByTimeframe, limit: cfg.limit });
                try {
                    const c = cache.get(key);
                    let candidates: any[] = [];
                    if (c && now - c.atMs < 250) {
                        candidates = c.candidates;
                    } else {
                        const nextCandidates = await this.buildCryptoAllCandidatesFromSnapshots({
                            symbols: cfg.symbols,
                            timeframes: cfg.timeframes,
                            minProb: cfg.minProb,
                            expiresWithinSec: cfg.expiresWithinSec,
                            expiresWithinSecByTimeframe: (cfg as any).expiresWithinSecByTimeframe,
                            limit: cfg.limit,
                        });
                        candidates = (nextCandidates.length === 0 && c && c.candidates.length) ? c.candidates : nextCandidates;
                        cache.set(key, { atMs: now, candidates });
                    }
                    socket.send(JSON.stringify({
                        type: 'snapshot',
                        at: new Date().toISOString(),
                        status,
                        candidates,
                    }));
                } catch (e: any) {
                    try {
                        socket.send(JSON.stringify({ type: 'error', at: new Date().toISOString(), message: e?.message || String(e) }));
                    } catch {
                    }
                }
            }
        };
        this.cryptoAllWsTimer = setInterval(() => tick().catch(() => {}), 250);
    }

    private startCryptoAllSnapshotLoop() {
        if (this.cryptoAllSnapshotTimer) return;
        const tick = async () => {
            if (!this.cryptoAllWsClients.size) return;
            const symbols = Array.from(new Set(Array.from(this.cryptoAllWsClients.values()).flatMap((c: any) => c.symbols || [])));
            const timeframes = Array.from(new Set(Array.from(this.cryptoAllWsClients.values()).flatMap((c: any) => c.timeframes || [])))
                .map((x: any) => String(x || '').toLowerCase())
                .filter((t: any) => ['5m', '15m', '1h', '4h', '1d'].includes(t)) as Array<'5m' | '15m' | '1h' | '4h' | '1d'>;
            const limit = Math.max(10, Math.min(100, Math.max(...Array.from(this.cryptoAllWsClients.values()).map((c: any) => Number(c.limit) || 0), 0)));
            await this.refreshCryptoAllMarketSnapshot({ symbols, timeframes: timeframes.length ? timeframes : ['15m'], limit }).catch(() => {});
            await this.refreshCryptoAllBooksSnapshot({ symbols, timeframes: timeframes.length ? timeframes : ['15m'], limit }).catch(() => {});
        };
        this.cryptoAllSnapshotTimer = setInterval(() => tick().catch(() => {}), 1000);
        tick().catch(() => {});
    }

    private startDeltaBoxLoop() {
        if (this.deltaBoxTimer) return;
        const tick = async () => {
            await Promise.allSettled([this.deltaBoxTickBinance(), this.deltaBoxTickPolymarket()]);
        };
        this.deltaBoxTimer = setInterval(() => tick().catch(() => {}), 1_000);
        setTimeout(() => tick().catch(() => {}), 250);
    }

    private normalizeDeltaBoxSymbols(input?: string[] | string): Array<'BTC' | 'ETH' | 'SOL' | 'XRP'> {
        const arr =
            Array.isArray(input) ? input
            : typeof input === 'string' ? input.split(',').map((x) => x.trim()).filter(Boolean)
            : ['BTC', 'ETH', 'SOL', 'XRP'];
        const out = Array.from(new Set(arr.map((s) => String(s || '').toUpperCase()).filter(Boolean))) as any[];
        return out.filter((s) => s === 'BTC' || s === 'ETH' || s === 'SOL' || s === 'XRP');
    }

    private normalizeDeltaBoxTimeframes(input?: Array<'5m' | '15m' | '1h' | '4h' | '1d'> | string): Array<'5m' | '15m' | '1h' | '4h' | '1d'> {
        const arr =
            Array.isArray(input) ? input
            : typeof input === 'string' ? input.split(',').map((x) => x.trim()).filter(Boolean) as any
            : ['5m', '15m', '1h', '4h', '1d'];
        const out = Array.from(new Set(arr.map((x: any) => String(x || '').toLowerCase()).filter(Boolean))) as any[];
        return out.filter((t) => t === '5m' || t === '15m' || t === '1h' || t === '4h' || t === '1d');
    }

    private deltaBoxAvg(values: Array<number | null | undefined>): number | null {
        const xs = values.filter((v: any) => v != null && Number.isFinite(Number(v))) as number[];
        if (!xs.length) return null;
        return xs.reduce((a, b) => a + b, 0) / xs.length;
    }

    private buildDeltaBoxStatsForKey(symbol: string, timeframe: '5m' | '15m' | '1h' | '4h' | '1d') {
        const k = `${symbol}:${timeframe}`;
        const aList = this.deltaBoxBinanceHist.get(k) || [];
        const bList = this.deltaBoxPmHist.get(k) || [];
        const take = (arr: any[], n: number) => arr.slice(Math.max(0, arr.length - n));
        const a10 = take(aList, 10);
        const a20 = take(aList, 20);
        const a50 = take(aList, 50);
        const b10 = take(bList, 10);
        const b20 = take(bList, 20);
        const b50 = take(bList, 50);
        const avgOffsets = (rows: any[]) => ({
            last1: this.deltaBoxAvg(rows.map((r: any) => (Array.isArray(r?.lastOffsetsSec) ? r.lastOffsetsSec[0] : null))),
            last2: this.deltaBoxAvg(rows.map((r: any) => (Array.isArray(r?.lastOffsetsSec) ? r.lastOffsetsSec[1] : null))),
            last3: this.deltaBoxAvg(rows.map((r: any) => (Array.isArray(r?.lastOffsetsSec) ? r.lastOffsetsSec[2] : null))),
        });
        const avgDeltaAt = (rows: any[]) => ({
            last1: this.deltaBoxAvg(rows.map((r: any) => (Array.isArray(r?.lastDeltaAtOffsets) ? r.lastDeltaAtOffsets[0] : null))),
            last2: this.deltaBoxAvg(rows.map((r: any) => (Array.isArray(r?.lastDeltaAtOffsets) ? r.lastDeltaAtOffsets[1] : null))),
            last3: this.deltaBoxAvg(rows.map((r: any) => (Array.isArray(r?.lastDeltaAtOffsets) ? r.lastDeltaAtOffsets[2] : null))),
        });
        return {
            symbol,
            timeframe,
            counts: { a: aList.length, bc: bList.length },
            a: {
                avg10: this.deltaBoxAvg(a10.map((x: any) => x?.deltaAbs ?? null)),
                avg20: this.deltaBoxAvg(a20.map((x: any) => x?.deltaAbs ?? null)),
                avg50: this.deltaBoxAvg(a50.map((x: any) => x?.deltaAbs ?? null)),
            },
            b: {
                avg10: avgOffsets(b10),
                avg20: avgOffsets(b20),
                avg50: avgOffsets(b50),
            },
            c: {
                avg10: avgDeltaAt(b10),
                avg20: avgDeltaAt(b20),
                avg50: avgDeltaAt(b50),
            },
        };
    }

    public getDeltaBoxStats(options?: { symbols?: string[] | string; timeframes?: Array<'5m' | '15m' | '1h' | '4h' | '1d'> | string }) {
        this.startDeltaBoxLoop();
        const symbols = this.normalizeDeltaBoxSymbols(options?.symbols);
        const timeframes = this.normalizeDeltaBoxTimeframes(options?.timeframes);
        this.deltaBoxWantedSymbols = symbols.length ? symbols : ['BTC', 'ETH', 'SOL', 'XRP'];
        this.deltaBoxWantedTimeframes = timeframes.length ? timeframes : ['5m', '15m', '1h', '4h', '1d'];
        const rows: any[] = [];
        for (const s of symbols) {
            for (const tf of timeframes) {
                rows.push(this.buildDeltaBoxStatsForKey(s, tf));
            }
        }
        return { symbols, timeframes, rows };
    }

    private async deltaBoxTickBinance() {
        const symbols: Array<'BTC' | 'ETH' | 'SOL' | 'XRP'> = ['BTC', 'ETH', 'SOL', 'XRP'];
        const tfs: Array<'5m' | '15m' | '1h' | '4h' | '1d'> = ['5m', '15m', '1h', '4h', '1d'];
        const now = Date.now();
        for (const sym of symbols) {
            for (const tf of tfs) {
                const k = `${sym}:${tf}`;
                const tfSec = this.getCryptoAllTimeframeSec(tf);
                const tfMs = tfSec * 1000;
                const expectedEndMs = Math.floor(now / tfMs) * tfMs;
                const meta = this.deltaBoxBinanceMeta.get(k) || { lastEndMs: 0, nextAllowedAtMs: 0 };
                if (now < meta.nextAllowedAtMs) continue;
                if (meta.lastEndMs > 0 && expectedEndMs <= meta.lastEndMs) continue;
                meta.nextAllowedAtMs = now + 15_000;
                this.deltaBoxBinanceMeta.set(k, meta);
                const raw = await this.fetchBinanceKlinesByInterval({ symbol: sym, interval: tf, limit: 80 });
                const parsed = raw
                    .map((r: any) => {
                        const openTime = r?.[0] != null ? Number(r[0]) : NaN;
                        const open = r?.[1] != null ? Number(r[1]) : NaN;
                        const close = r?.[4] != null ? Number(r[4]) : NaN;
                        const closeTime = r?.[6] != null ? Number(r[6]) : NaN;
                        if (!Number.isFinite(openTime) || !Number.isFinite(closeTime) || !Number.isFinite(open) || !Number.isFinite(close)) return null;
                        const endMs = closeTime;
                        const deltaAbs = Math.abs(close - open);
                        if (!Number.isFinite(deltaAbs)) return null;
                        return { endMs, open, close, deltaAbs };
                    })
                    .filter(Boolean) as Array<{ endMs: number; open: number; close: number; deltaAbs: number }>;
                parsed.sort((a, b) => a.endMs - b.endMs);
                const trimmed = parsed.slice(Math.max(0, parsed.length - 220));
                if (trimmed.length) {
                    this.deltaBoxBinanceHist.set(k, trimmed);
                    meta.lastEndMs = Math.max(meta.lastEndMs || 0, trimmed[trimmed.length - 1].endMs);
                    meta.nextAllowedAtMs = now + Math.min(Math.max(15_000, Math.floor(tfMs / 3)), 5 * 60_000);
                    this.deltaBoxBinanceMeta.set(k, meta);
                }
            }
        }
    }

    private async deltaBoxFetchOrderbooks(tokenIds: string[]): Promise<any[]> {
        const ids = Array.from(new Set((tokenIds || []).map((t) => String(t || '').trim()).filter(Boolean)));
        if (!ids.length) return [];
        try {
            return await this.fetchClobBooks(ids);
        } catch {
            const concurrency = 8;
            const out: any[] = [];
            for (let i = 0; i < ids.length; i += concurrency) {
                const chunk = ids.slice(i, i + concurrency);
                const settled = await Promise.allSettled(chunk.map(async (tid) => {
                    const ob = await this.sdk.clobApi.getOrderbook(tid);
                    return { asset_id: tid, asks: Array.isArray((ob as any)?.asks) ? (ob as any).asks : [], bids: Array.isArray((ob as any)?.bids) ? (ob as any).bids : [], timestamp: (ob as any)?.timestamp ?? null };
                }));
                for (const r of settled) {
                    if (r.status === 'fulfilled') out.push((r as any).value);
                }
            }
            return out;
        }
    }

    private finalizeDeltaBoxPmMarket(m: { key: string; symbol: string; timeframe: '5m' | '15m' | '1h' | '4h' | '1d'; endMs: number; events: Array<{ atMs: number; deltaAbs: number | null }> }) {
        const key = `${m.symbol}:${m.timeframe}`;
        const events = Array.isArray(m.events) ? m.events : [];
        const last = events.slice(Math.max(0, events.length - 3));
        const lastOffsetsSec: Array<number | null> = [null, null, null];
        const lastDeltaAtOffsets: Array<number | null> = [null, null, null];
        const tfSec = this.getCryptoAllTimeframeSec(m.timeframe);
        for (let i = 0; i < last.length; i++) {
            const ev = last[last.length - 1 - i];
            const offsetSec = Math.ceil((Number(m.endMs) - Number(ev?.atMs || 0)) / 1000);
            const validOffset = Number.isFinite(offsetSec) && offsetSec >= 0 && offsetSec <= Math.max(0, tfSec);
            lastOffsetsSec[i] = validOffset ? Math.max(0, offsetSec) : null;
            lastDeltaAtOffsets[i] = validOffset && ev?.deltaAbs != null && Number.isFinite(Number(ev.deltaAbs)) ? Number(ev.deltaAbs) : null;
        }
        const list = this.deltaBoxPmHist.get(key) || [];
        list.push({ endMs: m.endMs, lastOffsetsSec, lastDeltaAtOffsets });
        while (list.length > 220) list.shift();
        this.deltaBoxPmHist.set(key, list);
    }

    private async deltaBoxTickPolymarket() {
        const now = Date.now();
        if (now < this.deltaBoxPmNextSampleAtMs) return;
        this.deltaBoxPmNextSampleAtMs = now + 1000;

        if (now >= this.deltaBoxPmNextMarketRefreshAtMs) {
            this.deltaBoxPmNextMarketRefreshAtMs = now + 12_000;
            const symbols = this.deltaBoxWantedSymbols.length ? this.deltaBoxWantedSymbols.slice() : (['BTC', 'ETH', 'SOL', 'XRP'] as any);
            const timeframes = this.deltaBoxWantedTimeframes.length ? this.deltaBoxWantedTimeframes.slice() : (['5m', '15m', '1h', '4h', '1d'] as any);
            await this.refreshCryptoAllMarketSnapshot({ symbols, timeframes, limit: 40 }).catch(() => {});
        }

        const marketKeys = new Set<string>();
        const addMarket = (m: any, tf: '5m' | '15m' | '1h' | '4h' | '1d', symbol: string, endMs: number, upTokenId: string, downTokenId: string, idHint: string) => {
            if (!symbol || !Number.isFinite(endMs) || !upTokenId || !downTokenId) return;
            const key = idHint ? `${tf}:${idHint}` : `${tf}:${symbol}:${endMs}`;
            marketKeys.add(key);
            if (!this.deltaBoxPmMarkets.has(key)) {
                const tfSec = this.getCryptoAllTimeframeSec(tf);
                const startMs = endMs - tfSec * 1000;
                this.deltaBoxPmMarkets.set(key, { key, symbol, timeframe: tf, endMs, startMs, upTokenId, downTokenId, lastHasRange: false, events: [] });
            }
        };

        const m15 = Array.isArray(this.crypto15mMarketSnapshot?.markets) ? this.crypto15mMarketSnapshot.markets : [];
        for (const m of m15) {
            const symbol = String(m?.symbol || '').toUpperCase();
            const endMs = Number(m?.endMs);
            const tids = Array.isArray(m?.tokenIds) ? m.tokenIds.map((t: any) => String(t || '').trim()).filter(Boolean) : [];
            const upIdx = Number.isFinite(Number(m?.upIdx)) ? Number(m.upIdx) : 0;
            const downIdx = Number.isFinite(Number(m?.downIdx)) ? Number(m.downIdx) : 1;
            const upTokenId = tids[upIdx] ? String(tids[upIdx]) : '';
            const downTokenId = tids[downIdx] ? String(tids[downIdx]) : '';
            const cid = String(m?.conditionId || m?.condition_id || m?.slug || '').trim();
            addMarket(m, '15m', symbol, endMs, upTokenId, downTokenId, cid);
        }

        const mAll = Array.isArray(this.cryptoAllMarketSnapshot?.markets) ? this.cryptoAllMarketSnapshot.markets : [];
        for (const m of mAll) {
            const symbol = String(m?.symbol || '').toUpperCase();
            const tf = String(m?.timeframe || '').toLowerCase() as any;
            if (!(tf === '5m' || tf === '15m' || tf === '1h' || tf === '4h' || tf === '1d')) continue;
            const endMs = Number(m?.endMs);
            const upTokenId = String(m?.upTokenId || '').trim();
            const downTokenId = String(m?.downTokenId || '').trim();
            const cid = String(m?.conditionId || m?.condition_id || m?.slug || '').trim();
            addMarket(m, tf, symbol, endMs, upTokenId, downTokenId, cid);
        }

        for (const [k, m] of Array.from(this.deltaBoxPmMarkets.entries())) {
            if (!marketKeys.has(k)) {
                if (now >= Number(m.endMs)) {
                    this.finalizeDeltaBoxPmMarket(m);
                }
                this.deltaBoxPmMarkets.delete(k);
            }
        }

        const active = Array.from(this.deltaBoxPmMarkets.values()).filter((m) => now < Number(m.endMs) && Number(m.endMs) - now <= 36 * 60 * 60_000);
        for (const m of active) {
            if (now >= Number(m.endMs)) continue;
            marketKeys.add(m.key);
        }

        const tokenIds = Array.from(new Set(active.flatMap((m) => [m.upTokenId, m.downTokenId]).filter(Boolean)));
        if (!tokenIds.length) return;
        const books = await this.deltaBoxFetchOrderbooks(tokenIds);
        const byTid = new Map<string, any>();
        for (const b of books) {
            const tid = String((b as any)?.asset_id || (b as any)?.assetId || '').trim();
            if (!tid) continue;
            byTid.set(tid, b);
        }

        const refPxByTid = new Map<string, number | null>();
        for (const tid of tokenIds) {
            const b = byTid.get(tid);
            const asks = Array.isArray((b as any)?.asks) ? (b as any).asks : [];
            const bids = Array.isArray((b as any)?.bids) ? (b as any).bids : [];
            let bestAsk = NaN;
            for (const a of asks) {
                const p = Number((a as any)?.price);
                if (!Number.isFinite(p) || p <= 0) continue;
                if (!Number.isFinite(bestAsk) || p < bestAsk) bestAsk = p;
            }
            let bestBid = NaN;
            for (const bb of bids) {
                const p = Number((bb as any)?.price);
                if (!Number.isFinite(p) || p <= 0) continue;
                if (!Number.isFinite(bestBid) || p > bestBid) bestBid = p;
            }
            const ref = Number.isFinite(bestBid) ? bestBid : (Number.isFinite(bestAsk) ? bestAsk : NaN);
            refPxByTid.set(tid, Number.isFinite(ref) ? ref : null);
        }

        for (const m of active) {
            if (now >= Number(m.endMs)) continue;
            const upRef = refPxByTid.get(m.upTokenId);
            const downRef = refPxByTid.get(m.downTokenId);
            const inRange = (p: any) => p != null && Number.isFinite(Number(p)) && Number(p) >= 0.98 && Number(p) <= 0.999;
            const hasRange = inRange(upRef) || inRange(downRef);
            if (hasRange && !m.lastHasRange) {
                const tfSec = this.getCryptoAllTimeframeSec(m.timeframe);
                const secRem = Math.ceil((Number(m.endMs) - now) / 1000);
                if (Number.isFinite(secRem) && secRem >= 0 && secRem <= Math.max(0, tfSec)) {
                    const beat = await this.fetchCryptoAllBeatAndCurrentFromBinance({ symbol: m.symbol, endMs: m.endMs, timeframeSec: tfSec });
                    m.events.push({ atMs: now, deltaAbs: beat?.deltaAbs != null && Number.isFinite(Number(beat.deltaAbs)) ? Number(beat.deltaAbs) : null });
                    while (m.events.length > 80) m.events.shift();
                }
            }
            m.lastHasRange = hasRange;
        }

        for (const m of active) {
            if (now < Number(m.endMs)) continue;
            this.finalizeDeltaBoxPmMarket(m);
            this.deltaBoxPmMarkets.delete(m.key);
        }
    }

    public addCryptoAllWsClient(socket: any, options: { symbols?: string[] | string; timeframes?: Array<'5m' | '15m' | '1h' | '4h' | '1d'> | string; minProb?: number; expiresWithinSec?: number; expiresWithinSecByTimeframe?: any; limit?: number; includeCandidates?: boolean | string }) {
        const symbolsInput = options?.symbols;
        const symbolsArr =
            Array.isArray(symbolsInput) ? symbolsInput
            : typeof symbolsInput === 'string' ? symbolsInput.split(',').map((x) => x.trim()).filter(Boolean)
            : this.cryptoAllAutoConfig.symbols;
        const symbols = Array.from(new Set(symbolsArr.map((s) => String(s || '').toUpperCase()).filter(Boolean)));

        const tfsInput = options?.timeframes;
        const tfArr =
            Array.isArray(tfsInput) ? tfsInput
            : typeof tfsInput === 'string' ? tfsInput.split(',').map((x) => x.trim()).filter(Boolean) as any
            : this.cryptoAllAutoConfig.timeframes;
        const timeframes = Array.from(new Set(tfArr.map((x: any) => String(x || '').toLowerCase()).filter(Boolean)))
            .filter((t) => ['5m', '15m', '1h', '4h', '1d'].includes(String(t))) as Array<'5m' | '15m' | '1h' | '4h' | '1d'>;

        const minProb = Math.max(0, Math.min(1, Number(options?.minProb ?? this.cryptoAllAutoConfig.minProb)));
        const expiresWithinSec = Math.max(10, Math.floor(Number(options?.expiresWithinSec ?? this.cryptoAllAutoConfig.expiresWithinSec)));
        const expiresWithinSecByTimeframeRaw =
            options?.expiresWithinSecByTimeframe && typeof options.expiresWithinSecByTimeframe === 'object'
                ? options.expiresWithinSecByTimeframe
                : (this.cryptoAllAutoConfig.expiresWithinSecByTimeframe || null);
        const expiresWithinSecByTimeframe = (['5m', '15m', '1h', '4h', '1d'] as const).reduce((acc: any, tf) => {
            const v = expiresWithinSecByTimeframeRaw && (expiresWithinSecByTimeframeRaw as any)[tf] != null ? Number((expiresWithinSecByTimeframeRaw as any)[tf]) : expiresWithinSec;
            acc[tf] = Math.max(10, Math.floor(Number.isFinite(v) ? v : expiresWithinSec));
            return acc;
        }, {}) as Record<'5m' | '15m' | '1h' | '4h' | '1d', number>;
        const limit = Math.max(1, Math.min(100, Math.floor(Number(options?.limit ?? 40))));
        const includeCandidates = options?.includeCandidates == null ? true : (String(options?.includeCandidates || '').toLowerCase() === '1' || String(options?.includeCandidates || '').toLowerCase() === 'true');
        this.cryptoAllWsClients.set(socket, { symbols, timeframes: timeframes.length ? timeframes : ['15m'], minProb, expiresWithinSec, expiresWithinSecByTimeframe, limit, includeCandidates });
        this.startCryptoAllSnapshotLoop();
        this.startCryptoAllWsLoop();
    }

    public removeCryptoAllWsClient(socket: any) {
        this.cryptoAllWsClients.delete(socket);
        if (!this.cryptoAllWsClients.size && this.cryptoAllWsTimer) {
            clearInterval(this.cryptoAllWsTimer);
            this.cryptoAllWsTimer = null;
        }
        if (!this.cryptoAllWsClients.size && this.cryptoAllSnapshotTimer) {
            clearInterval(this.cryptoAllSnapshotTimer);
            this.cryptoAllSnapshotTimer = null;
        }
    }

    async getCrypto15mCandidates(options?: { minProb?: number; expiresWithinSec?: number; limit?: number }) {
        const now = Date.now();
        const marketAt = this.crypto15mMarketSnapshot.atMs ? Number(this.crypto15mMarketSnapshot.atMs) : 0;
        const booksAt = this.crypto15mBooksSnapshot.atMs ? Number(this.crypto15mBooksSnapshot.atMs) : 0;
        const needMarket = marketAt <= 0;
        const needBooks = booksAt <= 0;
        const marketStale = !needMarket && (now - marketAt) > 5_000;
        const booksStale = !needBooks && (now - booksAt) > 500;

        if (needMarket) await this.refreshCrypto15mMarketSnapshot();
        else if (marketStale) this.refreshCrypto15mMarketSnapshot().catch(() => {});

        const markets = Array.isArray(this.crypto15mMarketSnapshot.markets) ? this.crypto15mMarketSnapshot.markets : [];
        const soon = markets.some((m: any) => Number(m?.endMs ?? 0) - now < 2 * 60_000);
        const targetStale = soon ? 250 : 500;
        if (needBooks) await this.refreshCrypto15mBooksSnapshot();
        else if (booksStale) this.refreshCrypto15mBooksSnapshot().catch(() => {});

        if (Array.isArray(this.crypto15mMarketSnapshot.markets) && this.crypto15mMarketSnapshot.markets.length > 0) {
            const byTokenId = this.crypto15mBooksSnapshot.byTokenId || {};
            const hasAnyBook = Object.keys(byTokenId).some((k) => {
                const b = byTokenId[k];
                return b && Number(b.asksCount || 0) > 0 && b.bestAsk != null;
            });
            if (!hasAnyBook && !this.crypto15mBooksSnapshot.lastError) {
                this.crypto15mBooksInFlight = null;
                this.crypto15mBooksBackoffMs = 0;
                this.crypto15mBooksNextAllowedAtMs = 0;
                this.refreshCrypto15mBooksSnapshot().catch(() => {});
            }
        }
        return this.buildCrypto15mCandidatesFromSnapshots(options);
    }

    getCrypto15mTradeAnalysis(options?: { limit?: number; tradeId?: number }) {
        const limit = Math.max(1, Math.min(200, Math.floor(Number(options?.limit) || 100)));
        const tradeId = options?.tradeId != null ? Number(options.tradeId) : null;
        const trades = (this.orderHistory || [])
            .filter((e: any) => e && String(e?.action || '') === 'crypto15m_order')
            .slice(0, limit);

        const offsets = Array.from({ length: 60 }, (_, i) => i - 59);
        const timeline = offsets.map((offsetSec) => ({
            offsetSec,
            count980: 0,
            usd980: 0,
            count999: 0,
            usd999: 0,
        }));
        const idxByOffset = new Map<number, any>(timeline.map((x) => [x.offsetSec, x]));

        for (const t of trades) {
            const endSec = t?.book60sEndSec != null ? Math.floor(Number(t.book60sEndSec) || 0) : Math.floor((Number(t?.id) || Date.now()) / 1000);
            const pts = Array.isArray(t?.book60s) ? t.book60s : [];
            for (const p of pts) {
                const sec = Number(p?.sec);
                if (!Number.isFinite(sec)) continue;
                const offsetSec = Math.floor(sec) - endSec;
                const row = idxByOffset.get(offsetSec);
                if (!row) continue;
                const bestAsk = p?.bestAsk != null ? Number(p.bestAsk) : NaN;
                const mil = Number.isFinite(bestAsk) ? Math.round(bestAsk * 1000) : NaN;
                const depthUsd980 = p?.depthUsd980 != null ? Number(p.depthUsd980) : NaN;
                const depthUsd999 = p?.depthUsd999 != null ? Number(p.depthUsd999) : NaN;
                if (mil === 980) {
                    row.count980 += 1;
                    if (Number.isFinite(depthUsd980)) row.usd980 += depthUsd980;
                }
                if (mil === 999) {
                    row.count999 += 1;
                    if (Number.isFinite(depthUsd999)) row.usd999 += depthUsd999;
                }
            }
        }

        const best980 = timeline.reduce((a, b) => (b.count980 > a.count980 ? b : a), timeline[0]);
        const best999 = timeline.reduce((a, b) => (b.count999 > a.count999 ? b : a), timeline[0]);

        const toFilledUsd = (e: any) => {
            const sweepFilled = e?.sweepLog?.summary?.totalFilledUsd;
            if (sweepFilled != null && Number.isFinite(Number(sweepFilled))) return Number(sweepFilled);
            const r0 = Array.isArray(e?.results) ? e.results[0] : null;
            const filledSize = r0?.filledSize != null ? Number(r0.filledSize) : NaN;
            const pxHint = r0?.orderPrice ?? r0?.price ?? e?.bestAsk ?? e?.price ?? e?.limitPrice ?? null;
            const px = pxHint != null ? Number(pxHint) : NaN;
            if (Number.isFinite(filledSize) && Number.isFinite(px)) return filledSize * px;
            return null;
        };

        const tradeRows = trades.map((e: any) => {
            const filledUsd = toFilledUsd(e);
            const attemptedUsd = e?.amountUsd != null ? Number(e.amountUsd) : null;
            const fillPct = filledUsd != null && attemptedUsd != null && attemptedUsd > 0 ? Math.max(0, Math.min(1, filledUsd / attemptedUsd)) : null;
            const r0 = Array.isArray(e?.results) ? e.results[0] : null;
            const orderRoundtripMs = r0?.orderRoundtripMs != null ? Number(r0.orderRoundtripMs) : null;
            return {
                id: e?.id ?? null,
                timestamp: e?.timestamp ?? null,
                symbol: e?.symbol ?? null,
                marketId: e?.marketId ?? null,
                slug: e?.slug ?? null,
                outcome: e?.outcome ?? null,
                bestAsk: e?.bestAsk ?? null,
                limitPrice: e?.limitPrice ?? null,
                depthUsdAtCap: e?.depthUsdAtCap ?? null,
                amountUsd: attemptedUsd,
                filledUsd,
                fillPct,
                preOpenOrdersCount: e?.preOpenOrdersCount ?? null,
                preOpenOrdersRemainingUsd: e?.preOpenOrdersRemainingUsd ?? null,
                orderRoundtripMs,
                book60sEndSec: e?.book60sEndSec ?? null,
                book60sPoints: Array.isArray(e?.book60s) ? e.book60s.length : 0,
            };
        });

        const buys = tradeRows.length;
        const sells = (this.orderHistory || []).filter((e: any) => {
            const a = String(e?.action || '');
            return a.includes('stoploss') || a.includes('sell');
        }).slice(0, limit).length;

        const detail = tradeId != null
            ? (trades.find((e: any) => Number(e?.id) === tradeId) || null)
            : null;

        return {
            success: true,
            limit,
            trades: tradeRows,
            tradeDetail: detail ? {
                id: detail?.id ?? null,
                timestamp: detail?.timestamp ?? null,
                symbol: detail?.symbol ?? null,
                marketId: detail?.marketId ?? null,
                slug: detail?.slug ?? null,
                outcome: detail?.outcome ?? null,
                bestAsk: detail?.bestAsk ?? null,
                limitPrice: detail?.limitPrice ?? null,
                depthUsdAtCap: detail?.depthUsdAtCap ?? null,
                amountUsd: detail?.amountUsd ?? null,
                preOpenOrdersCount: detail?.preOpenOrdersCount ?? null,
                preOpenOrdersRemainingUsd: detail?.preOpenOrdersRemainingUsd ?? null,
                book60sEndSec: detail?.book60sEndSec ?? null,
                book60s: Array.isArray(detail?.book60s) ? detail.book60s : [],
            } : null,
            timeline: timeline.map((r) => ({ ...r, usd980: Number(r.usd980.toFixed(6)), usd999: Number(r.usd999.toFixed(6)) })),
            peaks: {
                best980: { offsetSec: best980.offsetSec, count: best980.count980, usd: Number(best980.usd980.toFixed(6)) },
                best999: { offsetSec: best999.offsetSec, count: best999.count999, usd: Number(best999.usd999.toFixed(6)) },
            },
            buySell: {
                buyCount: buys,
                sellCount: sells,
            }
        };
    }

    getCrypto15mStatus() {
        this.crypto15mUpdateTracking(Date.now());
        const actives: any = {};
        for (const [symbol, a] of this.crypto15mActivesBySymbol.entries()) {
            actives[symbol] = a;
        }
        const adaptiveDelta: any = {};
        for (const sym of ['BTC', 'ETH', 'SOL', 'XRP']) {
            const base =
                sym === 'BTC' ? this.crypto15mDeltaThresholds.btcMinDelta
                : sym === 'ETH' ? this.crypto15mDeltaThresholds.ethMinDelta
                : sym === 'SOL' ? this.crypto15mDeltaThresholds.solMinDelta
                : sym === 'XRP' ? this.crypto15mDeltaThresholds.xrpMinDelta
                : 0;
            const st = this.crypto15mAdaptiveDeltaBySymbol.get(sym) || null;
            const overrideDelta = st?.overrideDelta != null && Number.isFinite(Number(st.overrideDelta)) ? Number(st.overrideDelta) : null;
            const noBuyCount = st?.noBuyCount != null ? Math.max(0, Math.floor(Number(st.noBuyCount))) : 0;
            const limit = Math.max(1, Math.floor(Number(this.crypto15mAutoConfig.adaptiveDeltaRevertNoBuyCount) || 4));
            adaptiveDelta[sym] = {
                enabled: this.crypto15mAutoConfig.adaptiveDeltaEnabled === true,
                baseMinDelta: base,
                overrideMinDelta: overrideDelta,
                effectiveMinDelta: overrideDelta != null ? overrideDelta : base,
                noBuyCount,
                revertAfter: limit,
                remainingToRevert: overrideDelta != null ? Math.max(0, limit - noBuyCount) : null,
                lastBigMoveAt: st?.lastBigMoveAt ?? null,
                lastBigMoveDelta: st?.lastBigMoveDelta ?? null,
            };
        }
        const tracked = Array.from(this.crypto15mTrackedByCondition.values())
            .sort((a: any, b: any) => String(b?.startedAt || '').localeCompare(String(a?.startedAt || '')))
            .slice(0, 50);
        return {
            hasValidKey: this.hasValidKey === true,
            trading: this.getTradingInitStatus(),
            enabled: this.crypto15mAutoEnabled,
            dryRun: this.crypto15mAutoDryRun === true,
            config: this.crypto15mAutoConfig,
            lastScanAt: this.crypto15mLastScanAt,
            lastError: this.crypto15mLastError,
            lastDecision: this.crypto15mLastDecision,
            lastCandidateStats: this.crypto15mLastCandidateStats,
            lastOrderAttempt: this.crypto15mLastOrderAttempt,
            adaptiveDelta,
            actives,
            tracked,
        };
    }

    getCrypto15mHedgeStatus() {
        const actives: any = {};
        for (const [symbol, a] of this.crypto15mHedgeActivesBySymbol.entries()) {
            actives[symbol] = a;
        }
        const tracked = Array.from(this.crypto15mHedgeTrackedByCondition.values())
            .sort((a: any, b: any) => String(b?.startedAt || '').localeCompare(String(a?.startedAt || '')))
            .slice(0, 50);
        return {
            hasValidKey: this.hasValidKey === true,
            trading: this.getTradingInitStatus(),
            enabled: this.crypto15mHedgeAutoEnabled,
            config: this.crypto15mHedgeAutoConfig,
            lastScanAt: this.crypto15mHedgeLastScanAt,
            lastError: this.crypto15mHedgeLastError,
            lastDecision: this.crypto15mHedgeLastDecision,
            lastOrderAttempt: this.crypto15mHedgeLastOrderAttempt,
            actives,
            tracked,
            configPersist: {
                path: this.crypto15mHedgeConfigPath,
                loadedAt: this.crypto15mHedgeConfigLoadedAt,
                persistedAt: this.crypto15mHedgeConfigPersistedAt,
                lastError: this.crypto15mHedgeConfigPersistLastError,
            },
        };
    }

    private computeCrypto15mHedgeEffectiveProfitCents(remainingSec: number | null, cfg?: any) {
        const c = cfg || this.crypto15mHedgeAutoConfig;
        const base = c?.targetProfitCents != null ? Number(c.targetProfitCents) : 10;
        const enabled = c?.profitDecayEnabled === true;
        if (!enabled) return Number.isFinite(base) ? base : 10;
        const startC = c?.profitStartCents != null ? Number(c.profitStartCents) : base;
        const endC = c?.profitEndCents != null ? Number(c.profitEndCents) : Math.max(0, base - 1);
        const startSec = c?.profitDecayStartSec != null ? Math.floor(Number(c.profitDecayStartSec)) : 300;
        const endSec = c?.profitDecayEndSec != null ? Math.floor(Number(c.profitDecayEndSec)) : 60;
        const mode = String(c?.profitDecayMode || 'linear').toLowerCase() === 'per_minute' ? 'per_minute' : 'linear';
        const perMinC = c?.profitDecayPerMinCents != null ? Number(c.profitDecayPerMinCents) : 1;
        const step = c?.profitStepCents != null ? Number(c.profitStepCents) : 0.1;
        const s = remainingSec != null && Number.isFinite(Number(remainingSec)) ? Math.max(0, Math.floor(Number(remainingSec))) : null;
        if (s == null) return Number.isFinite(startC) ? startC : base;
        const hi = Math.max(startSec, endSec);
        const lo = Math.min(startSec, endSec);
        const top = Number.isFinite(startC) ? startC : base;
        const bot = Number.isFinite(endC) ? endC : Math.max(0, base - 1);
        if (s >= hi) return top;
        if (s <= lo) return bot;
        let raw = top;
        if (mode === 'per_minute') {
            const rate = Number.isFinite(perMinC) && perMinC > 0 ? perMinC : 1;
            const minutes = Math.max(0, Math.floor((hi - s) / 60));
            raw = top - minutes * rate;
        } else {
            const t = (hi - s) / Math.max(1, (hi - lo));
            raw = top + (bot - top) * t;
        }
        const st = Number.isFinite(step) && step > 0 ? step : 0.1;
        const rounded = Math.round(raw / st) * st;
        const clamped = Math.max(Math.min(top, bot), Math.min(Math.max(top, bot), rounded));
        return clamped;
    }

    async getCrypto15mHedgeSignals() {
        const now = Date.now();
        const cfg = this.crypto15mHedgeAutoConfig;
        const entryMinSec = Math.max(0, Math.floor(Number(cfg.entryRemainingMinSec) || 0));
        const entryMaxSec = Math.max(entryMinSec, Math.floor(Number(cfg.entryRemainingMaxSec) || 900));
        const cheapMin = Number(cfg.entryCheapMinCents) / 100;
        const cheapMax = Number(cfg.entryCheapMaxCents) / 100;
        const candidatesResp: any = await this.getCrypto15mCandidates({ minProb: cfg.minProb, expiresWithinSec: 900, limit: 80 });
        const candidates = Array.isArray(candidatesResp?.candidates) ? candidatesResp.candidates : [];
        const entrySignals: any[] = [];
        const opportunities: any[] = [];

        const pickEntryIndex = (prices: any[]) => {
            const p0 = Number(prices?.[0]);
            const p1 = Number(prices?.[1]);
            const ok0 = Number.isFinite(p0) && p0 >= cheapMin && p0 <= cheapMax;
            const ok1 = Number.isFinite(p1) && p1 >= cheapMin && p1 <= cheapMax;
            if (ok0 && !ok1) return 0;
            if (ok1 && !ok0) return 1;
            if (ok0 && ok1) return Number.isFinite(p0) && Number.isFinite(p1) ? (p0 <= p1 ? 0 : 1) : 0;
            return Number.isFinite(p0) && Number.isFinite(p1) ? (p0 <= p1 ? 0 : 1) : 0;
        };

        const byTokenId = this.crypto15mBooksSnapshot.byTokenId || {};
        const symbolsAllow = new Set(['BTC', 'ETH', 'SOL', 'XRP']);
        const oppSeed: any[] = [];
        for (const c of candidates) {
            const symbol = String(c?.symbol || '').toUpperCase();
            if (!symbol) continue;
            const secondsToExpire = c?.secondsToExpire != null ? Math.floor(Number(c.secondsToExpire)) : null;
            const tokenIds = Array.isArray(c?.tokenIds) ? c.tokenIds : [];
            const outcomes = Array.isArray(c?.outcomes) ? c.outcomes : [];
            const prices = Array.isArray(c?.prices) ? c.prices : [];
            if (tokenIds.length < 2 || outcomes.length < 2 || prices.length < 2) continue;
            const idxEntry = pickEntryIndex(prices);
            const entryTokenId = String(tokenIds[idxEntry] || '').trim();
            const entryOutcome = String(outcomes[idxEntry] || '');
            const bestAsk = Number(prices[idxEntry]);
            const b = entryTokenId ? byTokenId[entryTokenId] : null;
            const bestBid = b?.bestBid != null && Number.isFinite(Number(b.bestBid)) ? Number(b.bestBid) : null;
            const spreadCents = bestBid != null && Number.isFinite(bestAsk) ? Math.max(0, (bestAsk - bestBid) * 100) : null;
            const withinEntryWindow = secondsToExpire != null && Number.isFinite(secondsToExpire) && secondsToExpire >= entryMinSec && secondsToExpire <= entryMaxSec;
            const cheapOk = Number.isFinite(bestAsk) && bestAsk >= cheapMin && bestAsk <= cheapMax;
            const baseReason = c?.reason != null ? String(c.reason) : null;
            const entryEligible = baseReason == null && withinEntryWindow && cheapOk;
            const reason =
                baseReason != null ? baseReason
                : !withinEntryWindow ? 'entry_window_closed'
                : !cheapOk ? 'not_cheap'
                : null;
            entrySignals.push({
                symbol,
                conditionId: c?.conditionId ?? null,
                slug: c?.slug ?? null,
                title: c?.title ?? null,
                endDate: c?.endDate ?? null,
                secondsToExpire,
                entryTokenId,
                entryOutcome,
                bestAsk: Number.isFinite(bestAsk) ? bestAsk : null,
                bestBid,
                spreadCents,
                cheapMin,
                cheapMax,
                entryEligible,
                reason,
            });

            if (symbolsAllow.has(symbol)) {
                const idxHedge = idxEntry === 0 ? 1 : 0;
                const hedgeTokenId = String(tokenIds[idxHedge] || '').trim();
                const hedgeOutcome = String(outcomes[idxHedge] || '');
                const conditionId = c?.conditionId ?? null;
                if (entryTokenId && hedgeTokenId && conditionId) {
                    oppSeed.push({
                        symbol,
                        conditionId,
                        slug: c?.slug ?? null,
                        title: c?.title ?? null,
                        endDate: c?.endDate ?? null,
                        secondsToExpire,
                        entryIndex: idxEntry,
                        hedgeIndex: idxHedge,
                        entryTokenId,
                        hedgeTokenId,
                        entryOutcome,
                        hedgeOutcome,
                        baseReason,
                        withinEntryWindow,
                        cheapOk,
                    });
                }
            }
        }
        entrySignals.sort((a, b) => {
            if (!!a.entryEligible !== !!b.entryEligible) return a.entryEligible ? -1 : 1;
            const as = a?.secondsToExpire != null ? Number(a.secondsToExpire) : Infinity;
            const bs = b?.secondsToExpire != null ? Number(b.secondsToExpire) : Infinity;
            return as - bs;
        });

        const computeBestFromBook = (book: any) => {
            const asks = Array.isArray(book?.asks) ? book.asks : [];
            const bids = Array.isArray(book?.bids) ? book.bids : [];
            let bestAsk = NaN;
            let bestBid = NaN;
            for (const a of asks) {
                const p = Number(a?.price);
                if (!Number.isFinite(p) || p <= 0) continue;
                if (!Number.isFinite(bestAsk) || p < bestAsk) bestAsk = p;
            }
            for (const b of bids) {
                const p = Number(b?.price);
                if (!Number.isFinite(p) || p <= 0) continue;
                if (!Number.isFinite(bestBid) || p > bestBid) bestBid = p;
            }
            const spreadCents = Number.isFinite(bestAsk) && Number.isFinite(bestBid) ? Math.max(0, (bestAsk - bestBid) * 100) : null;
            return { asks, bids, bestAsk: Number.isFinite(bestAsk) ? bestAsk : null, bestBid: Number.isFinite(bestBid) ? bestBid : null, spreadCents };
        };
        const computeTradableShares = (asks: any[], limitPrice: number, maxLevels: number) => {
            const normalized = (Array.isArray(asks) ? asks : [])
                .map((a: any) => {
                    const price = Number(a?.price);
                    const size = Number(a?.size ?? a?.amount ?? a?.quantity);
                    if (!Number.isFinite(price) || price <= 0) return null;
                    if (!Number.isFinite(size) || size <= 0) return null;
                    if (Number.isFinite(limitPrice) && price > limitPrice) return null;
                    return { price, size };
                })
                .filter(Boolean) as Array<{ price: number; size: number }>;
            normalized.sort((a, b) => a.price - b.price);
            let shares = 0;
            let levels = 0;
            for (const lvl of normalized) {
                if (levels >= maxLevels) break;
                shares += lvl.size;
                levels += 1;
            }
            return shares;
        };

        const padSec = 300;
        const oppCandidates = oppSeed.filter((x) => {
            const s = x?.secondsToExpire != null ? Number(x.secondsToExpire) : null;
            if (s == null || !Number.isFinite(s)) return false;
            return s >= Math.max(0, entryMinSec - padSec) && s <= (entryMaxSec + padSec);
        });
        const oppTokenIds = Array.from(new Set(oppCandidates.flatMap((x: any) => [String(x.entryTokenId || '').trim(), String(x.hedgeTokenId || '').trim()]).filter(Boolean)));
        const oppBooksByToken: Record<string, any> = {};
        if (oppTokenIds.length) {
            const books = await this.fetchClobBooks(oppTokenIds.slice(0, 60));
            for (const b of books || []) {
                const tokenId = String(b?.token_id ?? b?.tokenId ?? b?.tokenID ?? b?.asset_id ?? b?.assetId ?? '').trim();
                if (!tokenId) continue;
                oppBooksByToken[tokenId] = b;
            }
        }
        const oppBuffer = Number(cfg.bufferCents) / 100;
        const oppMaxSpreadCents = Number(cfg.maxSpreadCents);
        const oppMinDepthPct = Number(cfg.minDepthPct);
        const oppIgnoreSpread = cfg.hedgeIgnoreSpread === true;
        const estAmountUsd = Math.max(0.01, Number(cfg.amountUsd) || 1);
        for (const x of oppCandidates) {
            const secondsToExpire = x?.secondsToExpire != null ? Number(x.secondsToExpire) : null;
            const effProfitCents = this.computeCrypto15mHedgeEffectiveProfitCents(secondsToExpire, cfg);
            const effProfit = Number(effProfitCents) / 100;
            const entryBook = oppBooksByToken[String(x.entryTokenId || '')] || null;
            const hedgeBook = oppBooksByToken[String(x.hedgeTokenId || '')] || null;
            const entryBest = computeBestFromBook(entryBook);
            const hedgeBest = computeBestFromBook(hedgeBook);
            const entryBestAsk = entryBest.bestAsk;
            const cheapOk = entryBestAsk != null && entryBestAsk >= cheapMin && entryBestAsk <= cheapMax;
            const withinEntryWindow = secondsToExpire != null && Number.isFinite(secondsToExpire) && secondsToExpire >= entryMinSec && secondsToExpire <= entryMaxSec;
            const entryEligible = x.baseReason == null && withinEntryWindow && cheapOk;
            const entryReason =
                x.baseReason != null ? x.baseReason
                : !withinEntryWindow ? 'entry_window_closed'
                : !cheapOk ? 'not_cheap'
                : null;
            const p2Max = entryBestAsk != null ? (1 - effProfit - oppBuffer - entryBestAsk) : null;
            const hedgeBestAsk = hedgeBest.bestAsk;
            const hedgeBestBid = hedgeBest.bestBid;
            const hedgeSpreadCents = hedgeBest.spreadCents;
            const edgeOk = p2Max != null && Number.isFinite(p2Max) && p2Max > 0 && hedgeBestAsk != null && hedgeBestAsk <= p2Max;
            const spreadOk = oppIgnoreSpread ? true : (hedgeSpreadCents == null || !Number.isFinite(oppMaxSpreadCents) ? true : hedgeSpreadCents <= oppMaxSpreadCents);
            const estEntryShares = entryBestAsk != null && entryBestAsk > 0 ? (estAmountUsd / entryBestAsk) : null;
            const tradableShares = edgeOk && p2Max != null ? computeTradableShares(hedgeBest.asks, Math.min(0.999, p2Max), 50) : null;
            const depthThreshold = estEntryShares != null && estEntryShares > 0 ? estEntryShares * (Math.max(0, oppMinDepthPct) / 100) : 0;
            const depthOk = estEntryShares == null ? false : (oppMinDepthPct <= 0 ? (tradableShares != null && Number(tradableShares) > 0) : (tradableShares != null && Number(tradableShares) + 1e-9 >= Math.min(estEntryShares, depthThreshold)));
            const secondEligibleNow = entryEligible && edgeOk && spreadOk && depthOk;
            const secondReason =
                !entryEligible ? 'need_entry'
                : !spreadOk ? 'hedge_spread_too_wide'
                : !edgeOk ? 'hedge_edge_too_small'
                : !depthOk ? 'hedge_depth_too_thin'
                : null;
            const sharesToBuyNow = estEntryShares != null && tradableShares != null ? Math.min(estEntryShares, tradableShares) : null;
            const estHedgeUsdNow = sharesToBuyNow != null && hedgeBestAsk != null ? Math.max(0, sharesToBuyNow * hedgeBestAsk) : null;
            opportunities.push({
                symbol: x.symbol,
                conditionId: x.conditionId,
                slug: x.slug,
                title: x.title,
                endDate: x.endDate,
                secondsToExpire,
                entryOutcome: x.entryOutcome,
                hedgeOutcome: x.hedgeOutcome,
                entryBestAsk,
                entryBestBid: entryBest.bestBid,
                entrySpreadCents: entryBest.spreadCents,
                entryEligible,
                entryReason,
                effectiveProfitCents: effProfitCents,
                p2Max: p2Max != null && Number.isFinite(p2Max) ? p2Max : null,
                hedgeBestAsk,
                hedgeBestBid,
                hedgeSpreadCents,
                tradableShares,
                estEntryShares,
                estHedgeUsdNow,
                secondEligibleNow,
                secondReason,
            });
        }
        opportunities.sort((a, b) => {
            if (!!a.entryEligible !== !!b.entryEligible) return a.entryEligible ? -1 : 1;
            if (!!a.secondEligibleNow !== !!b.secondEligibleNow) return a.secondEligibleNow ? -1 : 1;
            const as = a?.secondsToExpire != null ? Number(a.secondsToExpire) : Infinity;
            const bs = b?.secondsToExpire != null ? Number(b.secondsToExpire) : Infinity;
            return as - bs;
        });

        const actives = Array.from(this.crypto15mHedgeActivesBySymbol.entries()).map(([symbol, a]) => ({ symbol, ...(a || {}) }));
        const hedgeTokenIds = Array.from(new Set(actives.map((a: any) => String(a?.hedgeTokenId || '').trim()).filter(Boolean)));
        const booksByToken: Record<string, any> = {};
        if (hedgeTokenIds.length) {
            const books = await this.fetchClobBooks(hedgeTokenIds);
            for (const b of books || []) {
                const tokenId = String(b?.token_id ?? b?.tokenId ?? b?.tokenID ?? b?.asset_id ?? b?.assetId ?? '').trim();
                if (!tokenId) continue;
                booksByToken[tokenId] = b;
            }
        }

        const hedgeSignals: any[] = [];
        const buffer = Number(cfg.bufferCents) / 100;
        const maxSpreadCents = Number(cfg.maxSpreadCents);
        const minDepthPct = Number(cfg.minDepthPct);
        const ignoreSpread = cfg.hedgeIgnoreSpread === true;
        const minSecToHedge = Math.floor(Number(cfg.minSecToHedge) || 0);
        for (const a of actives) {
            const symbol = String(a?.symbol || '').toUpperCase();
            const phase = String(a?.phase || '');
            const entryPrice = a?.entryPrice != null ? Number(a.entryPrice) : NaN;
            const entryShares = a?.entryFilledShares != null ? Number(a.entryFilledShares) : NaN;
            const hedgeFilledShares = a?.hedgeFilledShares != null ? Number(a.hedgeFilledShares) : 0;
            const remainingShares = (Number.isFinite(entryShares) ? entryShares : 0) - (Number.isFinite(hedgeFilledShares) ? hedgeFilledShares : 0);
            const expiresAtMs = a?.expiresAtMs != null ? Number(a.expiresAtMs) : NaN;
            const secondsToExpire = Number.isFinite(expiresAtMs) ? Math.floor((expiresAtMs - now) / 1000) : null;
            const effProfitCents = this.computeCrypto15mHedgeEffectiveProfitCents(secondsToExpire, cfg);
            const effProfit = Number(effProfitCents) / 100;
            const p2Max = Number.isFinite(entryPrice) ? (1 - effProfit - buffer - entryPrice) : NaN;
            const hedgeTokenId = String(a?.hedgeTokenId || '').trim();
            const book = hedgeTokenId ? booksByToken[hedgeTokenId] : null;
            const asks = Array.isArray(book?.asks) ? book.asks : [];
            const bids = Array.isArray(book?.bids) ? book.bids : [];
            let bestAsk = NaN;
            let bestBid = NaN;
            for (const x of asks) {
                const p = Number(x?.price);
                if (!Number.isFinite(p) || p <= 0) continue;
                if (!Number.isFinite(bestAsk) || p < bestAsk) bestAsk = p;
            }
            for (const x of bids) {
                const p = Number(x?.price);
                if (!Number.isFinite(p) || p <= 0) continue;
                if (!Number.isFinite(bestBid) || p > bestBid) bestBid = p;
            }
            const spreadCents = Number.isFinite(bestAsk) && Number.isFinite(bestBid) ? Math.max(0, (bestAsk - bestBid) * 100) : null;
            const windowOk = secondsToExpire == null || !Number.isFinite(secondsToExpire) ? true : secondsToExpire > minSecToHedge;
            const edgeOk = Number.isFinite(p2Max) && p2Max > 0 && Number.isFinite(bestAsk) && bestAsk <= p2Max;
            const spreadOk = ignoreSpread ? true : (spreadCents == null || !Number.isFinite(maxSpreadCents) ? true : spreadCents <= maxSpreadCents);
            let tradableShares = null as any;
            if (edgeOk && asks.length) {
                const limitPrice = Math.min(0.999, p2Max);
                const eligibleAsks = asks
                    .map((x: any) => ({ price: Number(x?.price), size: Number(x?.size ?? x?.amount ?? x?.quantity) }))
                    .filter((x: any) => Number.isFinite(x.price) && x.price > 0 && Number.isFinite(x.size) && x.size > 0 && x.price <= limitPrice)
                    .sort((x: any, y: any) => x.price - y.price);
                let s = 0;
                for (const x of eligibleAsks.slice(0, 50)) s += x.size;
                tradableShares = s;
            }
            const depthThreshold = remainingShares > 0 ? remainingShares * (Math.max(0, minDepthPct) / 100) : 0;
            const depthOk = remainingShares <= 0 ? true : (minDepthPct <= 0 ? (tradableShares != null && Number(tradableShares) > 0) : (tradableShares != null && Number(tradableShares) + 1e-9 >= Math.min(remainingShares, depthThreshold)));
            const hedgeEligible = phase !== 'failed' && remainingShares > 0.01 && windowOk && edgeOk && spreadOk && depthOk;
            const reason =
                phase === 'failed' ? 'failed'
                : !(remainingShares > 0.01) ? 'hedge_done'
                : !windowOk ? 'hedge_window_closed'
                : !spreadOk ? 'hedge_spread_too_wide'
                : !edgeOk ? 'hedge_edge_too_small'
                : !depthOk ? 'hedge_depth_too_thin'
                : null;
            hedgeSignals.push({
                symbol,
                conditionId: a?.conditionId ?? null,
                phase,
                secondsToExpire,
                entryPrice: Number.isFinite(entryPrice) ? entryPrice : null,
                effectiveProfitCents: effProfitCents,
                entryShares: Number.isFinite(entryShares) ? entryShares : null,
                hedgeFilledShares: Number.isFinite(hedgeFilledShares) ? hedgeFilledShares : null,
                remainingShares,
                hedgeTokenId,
                bestAsk: Number.isFinite(bestAsk) ? bestAsk : null,
                bestBid: Number.isFinite(bestBid) ? bestBid : null,
                spreadCents,
                p2Max: Number.isFinite(p2Max) ? p2Max : null,
                tradableShares,
                depthOk,
                hedgeEligible,
                reason,
            });
        }
        hedgeSignals.sort((a, b) => {
            if (!!a.hedgeEligible !== !!b.hedgeEligible) return a.hedgeEligible ? -1 : 1;
            const as = a?.secondsToExpire != null ? Number(a.secondsToExpire) : Infinity;
            const bs = b?.secondsToExpire != null ? Number(b.secondsToExpire) : Infinity;
            return as - bs;
        });

        return {
            success: true,
            at: new Date().toISOString(),
            config: cfg,
            entrySignals,
            opportunities,
            hedgeSignals,
            status: this.getCrypto15mHedgeStatus(),
        };
    }

    private recordCrypto15mHedgeEvent(payload: any) {
        this.orderHistory.unshift({
            id: Date.now(),
            timestamp: new Date().toISOString(),
            mode: 'crypto15m-hedge',
            action: payload?.action || 'crypto15m_hedge_event',
            ...payload,
        });
        if (this.orderHistory.length > 300) this.orderHistory.pop();
        this.schedulePersistOrderHistory();
    }

    getCrypto15mHedgeHistory(options?: { maxEntries?: number }) {
        const maxEntries = options?.maxEntries != null ? Math.max(1, Math.min(200, Math.floor(Number(options.maxEntries)))) : 50;
        const list = this.orderHistory
            .filter((e: any) => e && typeof e === 'object' && String(e?.mode || '') === 'crypto15m-hedge')
            .slice(0, maxEntries);
        return { success: true, history: list };
    }

    updateCrypto15mHedgeConfig(config?: Partial<{
        pollMs: number;
        minProb: number;
        amountUsd: number;
        entryRemainingMinSec: number;
        entryRemainingMaxSec: number;
        entryCheapMinCents: number;
        entryCheapMaxCents: number;
        targetProfitCents: number;
        profitDecayEnabled: boolean;
        profitDecayMode: 'linear' | 'per_minute' | string;
        profitDecayPerMinCents: number;
        profitStartCents: number;
        profitEndCents: number;
        profitDecayStartSec: number;
        profitDecayEndSec: number;
        profitStepCents: number;
        mode: 'conservative' | 'balanced' | 'aggressive' | string;
        bufferCents: number;
        maxSpreadCents: number;
        minDepthPct: number;
        minSecToHedge: number;
        hedgeIgnoreSpread: boolean;
        panicHedgeEnabled: boolean;
        panicHedgeStartSec: number;
        panicMaxLossCents: number;
    }>) {
        const pollMs = config?.pollMs != null ? Number(config.pollMs) : this.crypto15mHedgeAutoConfig.pollMs;
        const minProb = config?.minProb != null ? Number(config.minProb) : this.crypto15mHedgeAutoConfig.minProb;
        const amountUsd = config?.amountUsd != null ? Number(config.amountUsd) : this.crypto15mHedgeAutoConfig.amountUsd;
        const entryRemainingMinSecRaw = config?.entryRemainingMinSec != null ? Number(config.entryRemainingMinSec) : this.crypto15mHedgeAutoConfig.entryRemainingMinSec;
        const entryRemainingMaxSecRaw = config?.entryRemainingMaxSec != null ? Number(config.entryRemainingMaxSec) : this.crypto15mHedgeAutoConfig.entryRemainingMaxSec;
        const entryCheapMinCents = config?.entryCheapMinCents != null ? Number(config.entryCheapMinCents) : this.crypto15mHedgeAutoConfig.entryCheapMinCents;
        const entryCheapMaxCents = config?.entryCheapMaxCents != null ? Number(config.entryCheapMaxCents) : this.crypto15mHedgeAutoConfig.entryCheapMaxCents;
        const targetProfitCents = config?.targetProfitCents != null ? Number(config.targetProfitCents) : this.crypto15mHedgeAutoConfig.targetProfitCents;
        const profitDecayEnabled = config?.profitDecayEnabled != null ? !!config.profitDecayEnabled : this.crypto15mHedgeAutoConfig.profitDecayEnabled;
        const profitDecayModeRaw = config?.profitDecayMode != null ? String(config.profitDecayMode) : String(this.crypto15mHedgeAutoConfig.profitDecayMode);
        const profitDecayPerMinCentsRaw = config?.profitDecayPerMinCents != null ? Number(config.profitDecayPerMinCents) : this.crypto15mHedgeAutoConfig.profitDecayPerMinCents;
        const profitStartCentsRaw = config?.profitStartCents != null ? Number(config.profitStartCents) : this.crypto15mHedgeAutoConfig.profitStartCents;
        const profitEndCentsRaw = config?.profitEndCents != null ? Number(config.profitEndCents) : this.crypto15mHedgeAutoConfig.profitEndCents;
        const profitDecayStartSecRaw = config?.profitDecayStartSec != null ? Number(config.profitDecayStartSec) : this.crypto15mHedgeAutoConfig.profitDecayStartSec;
        const profitDecayEndSecRaw = config?.profitDecayEndSec != null ? Number(config.profitDecayEndSec) : this.crypto15mHedgeAutoConfig.profitDecayEndSec;
        const profitStepCentsRaw = config?.profitStepCents != null ? Number(config.profitStepCents) : this.crypto15mHedgeAutoConfig.profitStepCents;
        const minSecToHedge = config?.minSecToHedge != null ? Number(config.minSecToHedge) : this.crypto15mHedgeAutoConfig.minSecToHedge;
        const hedgeIgnoreSpread = config?.hedgeIgnoreSpread != null ? !!config.hedgeIgnoreSpread : this.crypto15mHedgeAutoConfig.hedgeIgnoreSpread;
        const panicHedgeEnabled = config?.panicHedgeEnabled != null ? !!config.panicHedgeEnabled : this.crypto15mHedgeAutoConfig.panicHedgeEnabled;
        const panicHedgeStartSecRaw = config?.panicHedgeStartSec != null ? Number(config.panicHedgeStartSec) : this.crypto15mHedgeAutoConfig.panicHedgeStartSec;
        const panicMaxLossCentsRaw = config?.panicMaxLossCents != null ? Number(config.panicMaxLossCents) : this.crypto15mHedgeAutoConfig.panicMaxLossCents;
        const modeInfo = this.applyCrypto15mHedgeMode(config?.mode ?? this.crypto15mHedgeAutoConfig.mode, {
            bufferCents: config?.bufferCents,
            maxSpreadCents: config?.maxSpreadCents,
            minDepthPct: config?.minDepthPct,
        });
        const entryRemainingMinSec = Math.max(60, Math.min(900, Math.floor(Number.isFinite(entryRemainingMinSecRaw) ? entryRemainingMinSecRaw : 480)));
        const entryRemainingMaxSec = Math.max(entryRemainingMinSec, Math.min(900, Math.floor(Number.isFinite(entryRemainingMaxSecRaw) ? entryRemainingMaxSecRaw : 900)));
        const profitStartCents = Math.max(0, Math.min(30, Number.isFinite(profitStartCentsRaw) ? profitStartCentsRaw : Number(targetProfitCents)));
        const profitEndCents = Math.max(0, Math.min(30, Number.isFinite(profitEndCentsRaw) ? profitEndCentsRaw : Math.max(0, profitStartCents - 1)));
        const profitDecayStartSec = Math.max(0, Math.min(900, Math.floor(Number.isFinite(profitDecayStartSecRaw) ? profitDecayStartSecRaw : 300)));
        const profitDecayEndSec = Math.max(0, Math.min(900, Math.floor(Number.isFinite(profitDecayEndSecRaw) ? profitDecayEndSecRaw : 60)));
        const profitStepCents = Math.max(0.05, Math.min(5, Number.isFinite(profitStepCentsRaw) ? profitStepCentsRaw : 0.1));
        const profitDecayMode: 'linear' | 'per_minute' = String(profitDecayModeRaw || '').toLowerCase() === 'per_minute' ? 'per_minute' : 'linear';
        const profitDecayPerMinCents = Math.max(0.05, Math.min(30, Number.isFinite(profitDecayPerMinCentsRaw) ? profitDecayPerMinCentsRaw : 1));
        const panicHedgeStartSec = Math.max(0, Math.min(900, Math.floor(Number.isFinite(panicHedgeStartSecRaw) ? panicHedgeStartSecRaw : 120)));
        const panicMaxLossCents = Math.max(0, Math.min(200, Number.isFinite(panicMaxLossCentsRaw) ? panicMaxLossCentsRaw : 20));
        this.crypto15mHedgeAutoConfig = {
            pollMs: Math.max(500, Math.floor(Number.isFinite(pollMs) ? pollMs : 2_000)),
            expiresWithinSec: 900,
            minProb: Math.max(0, Math.min(1, Number.isFinite(minProb) ? minProb : 0)),
            amountUsd: Math.max(1, Number.isFinite(amountUsd) ? amountUsd : 1),
            entryRemainingMinSec,
            entryRemainingMaxSec,
            entryCheapMinCents: Math.max(1, Math.min(49, Number.isFinite(entryCheapMinCents) ? entryCheapMinCents : 8)),
            entryCheapMaxCents: Math.max(1, Math.min(49, Number.isFinite(entryCheapMaxCents) ? entryCheapMaxCents : 15)),
            targetProfitCents: Math.max(1, Math.min(30, Number.isFinite(targetProfitCents) ? targetProfitCents : 10)),
            profitDecayEnabled,
            profitDecayMode,
            profitDecayPerMinCents,
            profitStartCents,
            profitEndCents,
            profitDecayStartSec,
            profitDecayEndSec,
            profitStepCents,
            mode: modeInfo.mode,
            bufferCents: Math.max(0, Math.min(10, Number.isFinite(modeInfo.bufferCents) ? modeInfo.bufferCents : 1.5)),
            maxSpreadCents: Math.max(0, Math.min(50, Math.floor(Number.isFinite(modeInfo.maxSpreadCents) ? modeInfo.maxSpreadCents : 3))),
            minDepthPct: Math.max(0, Math.min(100, Math.floor(Number.isFinite(modeInfo.minDepthPct) ? modeInfo.minDepthPct : 70))),
            minSecToHedge: Math.max(0, Math.min(900, Math.floor(Number.isFinite(minSecToHedge) ? minSecToHedge : 90))),
            hedgeIgnoreSpread,
            panicHedgeEnabled,
            panicHedgeStartSec,
            panicMaxLossCents,
        };
        this.persistCrypto15mHedgeConfigToFile();
        this.recordCrypto15mHedgeEvent({ action: 'crypto15m_hedge_config_update', strategy: 'crypto15m-hedge', config: { ...this.crypto15mHedgeAutoConfig } });
        return this.getCrypto15mHedgeStatus();
    }

    startCrypto15mHedgeAuto(config?: Partial<{ enabled?: boolean }> & Parameters<GroupArbitrageScanner['updateCrypto15mHedgeConfig']>[0]) {
        const enabled = config?.enabled != null ? !!config.enabled : true;
        this.updateCrypto15mHedgeConfig(config);
        this.crypto15mHedgeAutoEnabled = enabled;
        this.crypto15mHedgeLastError = null;

        if (this.crypto15mHedgeAutoTimer) {
            clearInterval(this.crypto15mHedgeAutoTimer);
            this.crypto15mHedgeAutoTimer = null;
        }
        if (this.crypto15mHedgeAutoEnabled) {
            const tick = () => {
                this.crypto15mHedgeTryAutoOnce().catch(() => {});
            };
            tick();
            this.crypto15mHedgeAutoTimer = setInterval(tick, this.crypto15mHedgeAutoConfig.pollMs);
        }
        this.recordCrypto15mHedgeEvent({ action: enabled ? 'crypto15m_hedge_auto_start' : 'crypto15m_hedge_auto_stop', strategy: 'crypto15m-hedge', config: { enabled, ...this.crypto15mHedgeAutoConfig } });
        return this.getCrypto15mHedgeStatus();
    }

    stopCrypto15mHedgeAuto() {
        this.crypto15mHedgeAutoEnabled = false;
        if (this.crypto15mHedgeAutoTimer) {
            clearInterval(this.crypto15mHedgeAutoTimer);
            this.crypto15mHedgeAutoTimer = null;
        }
        this.recordCrypto15mHedgeEvent({ action: 'crypto15m_hedge_auto_stop', strategy: 'crypto15m-hedge', config: { enabled: false, ...this.crypto15mHedgeAutoConfig } });
        return this.getCrypto15mHedgeStatus();
    }

    async getCryptoAll2Candidates(options?: { minProb?: number; expiresWithinSec?: number; limit?: number; symbols?: string[] | string }) {
        const symbolsInput = options?.symbols;
        const symbolsArr =
            Array.isArray(symbolsInput) ? symbolsInput
            : typeof symbolsInput === 'string' ? symbolsInput.split(',').map((x) => x.trim()).filter(Boolean)
            : (this.cryptoAllAutoConfig.symbols || ['BTC', 'ETH', 'SOL', 'XRP']);
        const symbols = new Set(symbolsArr.map((s) => String(s || '').toUpperCase()).filter(Boolean));
        const minProb = Math.max(0, Math.min(1, Number(options?.minProb ?? this.cryptoAllAutoConfig.minProb)));
        const expiresWithinSec = Math.max(5, Math.floor(Number(options?.expiresWithinSec ?? this.cryptoAllAutoConfig.expiresWithinSec)));
        const limit = Math.max(1, Math.min(100, Math.floor(Number(options?.limit ?? 40))));
        const base = await this.getCrypto15mCandidates({ minProb, expiresWithinSec, limit: Math.max(limit, 40) });
        const list = Array.isArray((base as any)?.candidates) ? (base as any).candidates : [];
        const candidates = list
            .filter((c: any) => !symbols.size || symbols.has(String(c?.symbol || '').toUpperCase()))
            .map((c: any) => {
                const outcomes = Array.isArray(c?.outcomes) ? c.outcomes : [];
                const tokenIds = Array.isArray(c?.tokenIds) ? c.tokenIds : [];
                const prices = Array.isArray(c?.prices) ? c.prices : [];
                const upIdx = outcomes.findIndex((o: any) => String(o || '').toLowerCase().includes('up'));
                const downIdx = outcomes.findIndex((o: any) => String(o || '').toLowerCase().includes('down'));
                const upPrice0 = upIdx >= 0 ? Number(prices[upIdx]) : NaN;
                const downPrice0 = downIdx >= 0 ? Number(prices[downIdx]) : NaN;
                return {
                    timeframe: '15m',
                    symbol: c?.symbol,
                    slug: c?.slug ?? null,
                    conditionId: c?.conditionId,
                    question: c?.title ?? null,
                    endMs: c?.endMs,
                    endDateIso: c?.endDate ?? null,
                    secondsToExpire: c?.secondsToExpire,
                    eligibleByExpiry: c?.eligibleByExpiry,
                    minProb,
                    meetsMinProb: c?.meetsMinProb,
                    upTokenId: upIdx >= 0 ? String(tokenIds[upIdx] || '') : null,
                    downTokenId: downIdx >= 0 ? String(tokenIds[downIdx] || '') : null,
                    upPrice: Number.isFinite(upPrice0) ? upPrice0 : null,
                    downPrice: Number.isFinite(downPrice0) ? downPrice0 : null,
                    chosenOutcome: c?.chosenOutcome ?? null,
                    chosenPrice: c?.chosenPrice ?? null,
                    chosenTokenId: c?.chosenTokenId ?? null,
                    chosenIndex: c?.chosenIndex ?? null,
                    riskState: 'pending',
                    riskPendingReason: 'not_computed',
                    riskScore: null,
                    riskError: null,
                    reason: c?.reason ?? null,
                    booksError: c?.booksError ?? null,
                    marketsError: c?.marketsError ?? null,
                    staleMs: c?.staleMs ?? null,
                    snapshotAt: c?.snapshotAt ?? null,
                };
            });
        const byTokenId = this.crypto15mBooksSnapshot.byTokenId || {};
        const riskLeadSec = Math.max(0, Math.floor(Number.isFinite(expiresWithinSec) ? expiresWithinSec : 0) + 60);
        const timeframeSec = this.getCryptoAllTimeframeSec('15m');
        await Promise.all(candidates.map(async (r: any) => {
            const secondsToExpire = r?.secondsToExpire != null ? Number(r.secondsToExpire) : NaN;
            if (!Number.isFinite(secondsToExpire)) {
                r.riskState = 'pending';
                r.riskPendingReason = 'missing_expiry';
                return;
            }
            if (secondsToExpire > riskLeadSec) {
                r.riskState = 'pending';
                r.riskPendingReason = 'not_in_window';
                return;
            }
            const endMs = r?.endMs != null ? Number(r.endMs) : NaN;
            if (!Number.isFinite(endMs)) {
                r.riskState = 'pending';
                r.riskPendingReason = 'missing_endMs';
                return;
            }
            const chosenTokenId = String(r?.chosenTokenId || '').trim();
            if (!chosenTokenId) {
                r.riskState = 'pending';
                r.riskPendingReason = 'missing_tokenId';
                return;
            }
            const sym = String(r?.symbol || '').toUpperCase();
            const chosenOutcomeLc = String(r?.chosenOutcome || '').toLowerCase();
            const direction = chosenOutcomeLc.includes('down') ? 'Down' : 'Up';
            const book0: any = byTokenId[chosenTokenId] || null;
            const beat = await this.fetchCryptoAllBeatAndCurrentFromBinance({ symbol: sym, endMs, timeframeSec }).catch((e: any) => ({ priceToBeat: null, currentPrice: null, deltaAbs: null, error: e?.message || String(e) }));
            const risk = await this.computeCryptoAllRisk({
                symbol: sym,
                timeframeSec,
                endMs,
                direction: direction as any,
                beat,
                book: book0 ? { bestAsk: book0.bestAsk ?? null, bestBid: book0.bestBid ?? null, asksCount: book0.asksCount, bidsCount: book0.bidsCount } : null,
            }).catch((e: any) => ({ riskScore: null, dojiLikely: null, wickRatio: null, bodyRatio: null, retraceRatio: null, marginPct: null, momentum3m: null, spread: null, reasons: [], error: e?.message || String(e) }));
            r.riskState = risk?.riskScore != null ? 'ready' : 'error';
            r.riskScore = risk?.riskScore ?? null;
            r.riskError = risk?.error ?? null;
            r.riskPendingReason = null;
        }));
        return { success: true, count: candidates.length, candidates: candidates.slice(0, limit) };
    }

    getCryptoAll2Status() {
        this.cryptoAll2UpdateTracking(Date.now());
        const actives: any = {};
        for (const [symbol, a] of this.cryptoAll2ActivesBySymbol.entries()) {
            actives[symbol] = a;
        }
        const adaptiveDelta: any = {};
        for (const sym of ['BTC', 'ETH', 'SOL', 'XRP']) {
            const base =
                sym === 'BTC' ? this.crypto15mDeltaThresholds.btcMinDelta
                : sym === 'ETH' ? this.crypto15mDeltaThresholds.ethMinDelta
                : sym === 'SOL' ? this.crypto15mDeltaThresholds.solMinDelta
                : sym === 'XRP' ? this.crypto15mDeltaThresholds.xrpMinDelta
                : 0;
            const st = this.cryptoAll2AdaptiveDeltaBySymbol.get(sym) || null;
            const overrideDelta = st?.overrideDelta != null && Number.isFinite(Number(st.overrideDelta)) ? Number(st.overrideDelta) : null;
            const noBuyCount = st?.noBuyCount != null ? Math.max(0, Math.floor(Number(st.noBuyCount))) : 0;
            const limit = Math.max(1, Math.floor(Number(this.cryptoAll2AutoConfig.adaptiveDeltaRevertNoBuyCount) || 4));
            adaptiveDelta[sym] = {
                enabled: this.cryptoAll2AutoConfig.adaptiveDeltaEnabled === true,
                baseMinDelta: base,
                overrideMinDelta: overrideDelta,
                effectiveMinDelta: overrideDelta != null ? overrideDelta : base,
                noBuyCount,
                revertAfter: limit,
                remainingToRevert: overrideDelta != null ? Math.max(0, limit - noBuyCount) : null,
                lastBigMoveAt: st?.lastBigMoveAt ?? null,
                lastBigMoveDelta: st?.lastBigMoveDelta ?? null,
            };
        }
        const tracked = Array.from(this.cryptoAll2TrackedByCondition.values())
            .sort((a: any, b: any) => String(b?.startedAt || '').localeCompare(String(a?.startedAt || '')))
            .slice(0, 50);
        return {
            hasValidKey: this.hasValidKey === true,
            trading: this.getTradingInitStatus(),
            enabled: this.cryptoAll2AutoEnabled,
            config: this.cryptoAll2AutoConfig,
            lastScanAt: this.cryptoAll2LastScanAt,
            lastError: this.cryptoAll2LastError,
            lastDecision: this.cryptoAll2LastDecision,
            lastCandidateStats: this.cryptoAll2LastCandidateStats,
            lastOrderAttempt: this.cryptoAll2LastOrderAttempt,
            splitBuyState: Array.from(this.cryptoAll2SplitBuyState.values()).slice(0, 10),
            lastSplitLegAttempt: this.cryptoAll2LastSplitLegAttempt,
            adaptiveDelta,
            actives,
            tracked,
        };
    }

    private cryptoAll2UpdateTracking(nowMs: number) {
        for (const [symbol, a] of this.cryptoAll2ActivesBySymbol.entries()) {
            const endMs = a?.expiresAtMs != null ? Number(a.expiresAtMs) : Date.parse(String(a?.endDate || ''));
            if (Number.isFinite(endMs) && nowMs > endMs) {
                const expired = { ...a, phase: 'expired', expiredAt: new Date(nowMs).toISOString() };
                this.cryptoAll2TrackedByCondition.set(String(expired.conditionId), expired);
                this.cryptoAll2ActivesBySymbol.delete(symbol);
            }
        }
        const cutoff = nowMs - 48 * 60 * 60_000;
        for (const [cid, a] of this.cryptoAll2TrackedByCondition.entries()) {
            const started = Date.parse(String(a?.startedAt || a?.started_at || ''));
            if (Number.isFinite(started) && started < cutoff) this.cryptoAll2TrackedByCondition.delete(cid);
        }
    }

    startCryptoAll2Auto(config?: {
        pollMs?: number;
        expiresWithinSec?: number;
        minProb?: number;
        amountUsd?: number;
        symbols?: string[];
        dojiGuardEnabled?: boolean;
        riskSkipScore?: number;
        splitBuyEnabled?: boolean;
        splitBuyPct3m?: number;
        splitBuyPct2m?: number;
        splitBuyPct1m?: number;
        splitBuyTrendEnabled?: boolean;
        splitBuyTrendMinutes3m?: number;
        splitBuyTrendMinutes2m?: number;
        splitBuyTrendMinutes1m?: number;
        stoplossEnabled?: boolean;
        stoplossCut1DropCents?: number;
        stoplossCut1SellPct?: number;
        stoplossCut2DropCents?: number;
        stoplossCut2SellPct?: number;
        stoplossMinSecToExit?: number;
        adaptiveDeltaEnabled?: boolean;
        adaptiveDeltaBigMoveMultiplier?: number;
        adaptiveDeltaRevertNoBuyCount?: number;
    }) {
        if (this.autoRedeemConfig.enabled !== true) {
            this.setAutoRedeemConfig({ enabled: true, persist: true });
        }
        const pollMsRaw = config?.pollMs != null ? Number(config.pollMs) : this.cryptoAll2AutoConfig.pollMs;
        const expiresWithinSecRaw = config?.expiresWithinSec != null ? Number(config.expiresWithinSec) : this.cryptoAll2AutoConfig.expiresWithinSec;
        const minProbRaw = config?.minProb != null ? Number(config.minProb) : this.cryptoAll2AutoConfig.minProb;
        const amountUsdRaw = config?.amountUsd != null ? Number(config.amountUsd) : this.cryptoAll2AutoConfig.amountUsd;
        const symbols = Array.isArray(config?.symbols) && config?.symbols.length ? Array.from(new Set(config.symbols.map((s) => String(s || '').toUpperCase()).filter(Boolean))) : this.cryptoAll2AutoConfig.symbols;
        const dojiGuardEnabled = config?.dojiGuardEnabled != null ? !!config.dojiGuardEnabled : this.cryptoAll2AutoConfig.dojiGuardEnabled;
        const riskSkipScoreRaw = config?.riskSkipScore != null ? Number(config.riskSkipScore) : this.cryptoAll2AutoConfig.riskSkipScore;
        const splitBuyEnabled = config?.splitBuyEnabled != null ? !!config.splitBuyEnabled : this.cryptoAll2AutoConfig.splitBuyEnabled;
        const splitBuyPct3mRaw = config?.splitBuyPct3m != null ? Number(config.splitBuyPct3m) : this.cryptoAll2AutoConfig.splitBuyPct3m;
        const splitBuyPct2mRaw = config?.splitBuyPct2m != null ? Number(config.splitBuyPct2m) : this.cryptoAll2AutoConfig.splitBuyPct2m;
        const splitBuyPct1mRaw = config?.splitBuyPct1m != null ? Number(config.splitBuyPct1m) : this.cryptoAll2AutoConfig.splitBuyPct1m;
        const splitBuyTrendEnabled = config?.splitBuyTrendEnabled != null ? !!config.splitBuyTrendEnabled : this.cryptoAll2AutoConfig.splitBuyTrendEnabled;
        const splitBuyTrendMinutes3mRaw = config?.splitBuyTrendMinutes3m != null ? Number(config.splitBuyTrendMinutes3m) : this.cryptoAll2AutoConfig.splitBuyTrendMinutes3m;
        const splitBuyTrendMinutes2mRaw = config?.splitBuyTrendMinutes2m != null ? Number(config.splitBuyTrendMinutes2m) : this.cryptoAll2AutoConfig.splitBuyTrendMinutes2m;
        const splitBuyTrendMinutes1mRaw = config?.splitBuyTrendMinutes1m != null ? Number(config.splitBuyTrendMinutes1m) : this.cryptoAll2AutoConfig.splitBuyTrendMinutes1m;
        const stoplossEnabled = config?.stoplossEnabled != null ? !!config.stoplossEnabled : this.cryptoAll2AutoConfig.stoplossEnabled;
        const stoplossCut1DropCentsRaw = config?.stoplossCut1DropCents != null ? Number(config.stoplossCut1DropCents) : this.cryptoAll2AutoConfig.stoplossCut1DropCents;
        const stoplossCut1SellPctRaw = config?.stoplossCut1SellPct != null ? Number(config.stoplossCut1SellPct) : this.cryptoAll2AutoConfig.stoplossCut1SellPct;
        const stoplossCut2DropCentsRaw = config?.stoplossCut2DropCents != null ? Number(config.stoplossCut2DropCents) : this.cryptoAll2AutoConfig.stoplossCut2DropCents;
        const stoplossCut2SellPctRaw = config?.stoplossCut2SellPct != null ? Number(config.stoplossCut2SellPct) : this.cryptoAll2AutoConfig.stoplossCut2SellPct;
        const stoplossMinSecToExitRaw = config?.stoplossMinSecToExit != null ? Number(config.stoplossMinSecToExit) : this.cryptoAll2AutoConfig.stoplossMinSecToExit;
        const adaptiveDeltaEnabled = config?.adaptiveDeltaEnabled != null ? !!config.adaptiveDeltaEnabled : this.cryptoAll2AutoConfig.adaptiveDeltaEnabled;
        const adaptiveDeltaBigMoveMultiplierRaw = config?.adaptiveDeltaBigMoveMultiplier != null ? Number(config.adaptiveDeltaBigMoveMultiplier) : this.cryptoAll2AutoConfig.adaptiveDeltaBigMoveMultiplier;
        const adaptiveDeltaRevertNoBuyCountRaw = config?.adaptiveDeltaRevertNoBuyCount != null ? Number(config.adaptiveDeltaRevertNoBuyCount) : this.cryptoAll2AutoConfig.adaptiveDeltaRevertNoBuyCount;

        this.cryptoAll2AutoConfig = {
            pollMs: Math.max(500, Math.floor(Number.isFinite(pollMsRaw) ? pollMsRaw : 2_000)),
            expiresWithinSec: Math.max(5, Math.floor(Number.isFinite(expiresWithinSecRaw) ? expiresWithinSecRaw : 180)),
            minProb: Math.max(0, Math.min(1, Number.isFinite(minProbRaw) ? minProbRaw : 0.9)),
            amountUsd: Math.max(1, Number.isFinite(amountUsdRaw) ? amountUsdRaw : 1),
            symbols,
            dojiGuardEnabled,
            riskSkipScore: Math.max(0, Math.min(100, Math.floor(Number.isFinite(riskSkipScoreRaw) ? riskSkipScoreRaw : 70))),
            splitBuyEnabled,
            splitBuyPct3m: Math.max(0, Math.min(1000, Number.isFinite(splitBuyPct3mRaw) ? splitBuyPct3mRaw : 34)),
            splitBuyPct2m: Math.max(0, Math.min(1000, Number.isFinite(splitBuyPct2mRaw) ? splitBuyPct2mRaw : 33)),
            splitBuyPct1m: Math.max(0, Math.min(1000, Number.isFinite(splitBuyPct1mRaw) ? splitBuyPct1mRaw : 33)),
            splitBuyTrendEnabled,
            splitBuyTrendMinutes3m: Math.max(1, Math.min(10, Math.floor(Number.isFinite(splitBuyTrendMinutes3mRaw) ? splitBuyTrendMinutes3mRaw : 3))),
            splitBuyTrendMinutes2m: Math.max(1, Math.min(10, Math.floor(Number.isFinite(splitBuyTrendMinutes2mRaw) ? splitBuyTrendMinutes2mRaw : 2))),
            splitBuyTrendMinutes1m: Math.max(1, Math.min(10, Math.floor(Number.isFinite(splitBuyTrendMinutes1mRaw) ? splitBuyTrendMinutes1mRaw : 1))),
            stoplossEnabled,
            stoplossCut1DropCents: Math.max(0, Math.min(50, Math.floor(Number.isFinite(stoplossCut1DropCentsRaw) ? stoplossCut1DropCentsRaw : 1))),
            stoplossCut1SellPct: Math.max(0, Math.min(100, Math.floor(Number.isFinite(stoplossCut1SellPctRaw) ? stoplossCut1SellPctRaw : 50))),
            stoplossCut2DropCents: Math.max(0, Math.min(50, Math.floor(Number.isFinite(stoplossCut2DropCentsRaw) ? stoplossCut2DropCentsRaw : 2))),
            stoplossCut2SellPct: Math.max(0, Math.min(100, Math.floor(Number.isFinite(stoplossCut2SellPctRaw) ? stoplossCut2SellPctRaw : 100))),
            stoplossMinSecToExit: Math.max(0, Math.min(600, Math.floor(Number.isFinite(stoplossMinSecToExitRaw) ? stoplossMinSecToExitRaw : 25))),
            adaptiveDeltaEnabled,
            adaptiveDeltaBigMoveMultiplier: Math.max(1, Math.min(10, Number.isFinite(adaptiveDeltaBigMoveMultiplierRaw) ? adaptiveDeltaBigMoveMultiplierRaw : 2)),
            adaptiveDeltaRevertNoBuyCount: Math.max(1, Math.min(50, Math.floor(Number.isFinite(adaptiveDeltaRevertNoBuyCountRaw) ? adaptiveDeltaRevertNoBuyCountRaw : 4))),
        };
        this.persistCryptoAll2AutoConfigToFile();

        this.cryptoAll2AutoEnabled = true;
        this.recordAutoConfigEvent('cryptoall2', 'start', { enabled: true, ...this.cryptoAll2AutoConfig });
        if (this.cryptoAll2AutoTimer) {
            clearInterval(this.cryptoAll2AutoTimer);
            this.cryptoAll2AutoTimer = null;
        }
        const tick = async () => {
            await this.cryptoAll2TryAutoOnce().catch(() => {});
        };
        setTimeout(() => tick().catch(() => null), 250);
        this.cryptoAll2AutoTimer = setInterval(() => setTimeout(() => tick().catch(() => null), 250), this.cryptoAll2AutoConfig.pollMs);
        return this.getCryptoAll2Status();
    }

    stopCryptoAll2Auto() {
        this.cryptoAll2AutoEnabled = false;
        this.recordAutoConfigEvent('cryptoall2', 'stop', { enabled: false, ...this.cryptoAll2AutoConfig });
        if (this.cryptoAll2AutoTimer) {
            clearInterval(this.cryptoAll2AutoTimer);
            this.cryptoAll2AutoTimer = null;
        }
        return this.getCryptoAll2Status();
    }

    updateCryptoAll2Config(config?: {
        pollMs?: number;
        expiresWithinSec?: number;
        minProb?: number;
        amountUsd?: number;
        symbols?: string[];
        dojiGuardEnabled?: boolean;
        riskSkipScore?: number;
        splitBuyEnabled?: boolean;
        splitBuyPct3m?: number;
        splitBuyPct2m?: number;
        splitBuyPct1m?: number;
        splitBuyTrendEnabled?: boolean;
        splitBuyTrendMinutes3m?: number;
        splitBuyTrendMinutes2m?: number;
        splitBuyTrendMinutes1m?: number;
        stoplossEnabled?: boolean;
        stoplossCut1DropCents?: number;
        stoplossCut1SellPct?: number;
        stoplossCut2DropCents?: number;
        stoplossCut2SellPct?: number;
        stoplossMinSecToExit?: number;
        adaptiveDeltaEnabled?: boolean;
        adaptiveDeltaBigMoveMultiplier?: number;
        adaptiveDeltaRevertNoBuyCount?: number;
    }) {
        const pollMsRaw = config?.pollMs != null ? Number(config.pollMs) : this.cryptoAll2AutoConfig.pollMs;
        const expiresWithinSecRaw = config?.expiresWithinSec != null ? Number(config.expiresWithinSec) : this.cryptoAll2AutoConfig.expiresWithinSec;
        const minProbRaw = config?.minProb != null ? Number(config.minProb) : this.cryptoAll2AutoConfig.minProb;
        const amountUsdRaw = config?.amountUsd != null ? Number(config.amountUsd) : this.cryptoAll2AutoConfig.amountUsd;
        const symbols = Array.isArray(config?.symbols) && config?.symbols.length ? Array.from(new Set(config.symbols.map((s) => String(s || '').toUpperCase()).filter(Boolean))) : this.cryptoAll2AutoConfig.symbols;
        const dojiGuardEnabled = config?.dojiGuardEnabled != null ? !!config.dojiGuardEnabled : this.cryptoAll2AutoConfig.dojiGuardEnabled;
        const riskSkipScoreRaw = config?.riskSkipScore != null ? Number(config.riskSkipScore) : this.cryptoAll2AutoConfig.riskSkipScore;
        const splitBuyEnabled = config?.splitBuyEnabled != null ? !!config.splitBuyEnabled : this.cryptoAll2AutoConfig.splitBuyEnabled;
        const splitBuyPct3mRaw = config?.splitBuyPct3m != null ? Number(config.splitBuyPct3m) : this.cryptoAll2AutoConfig.splitBuyPct3m;
        const splitBuyPct2mRaw = config?.splitBuyPct2m != null ? Number(config.splitBuyPct2m) : this.cryptoAll2AutoConfig.splitBuyPct2m;
        const splitBuyPct1mRaw = config?.splitBuyPct1m != null ? Number(config.splitBuyPct1m) : this.cryptoAll2AutoConfig.splitBuyPct1m;
        const splitBuyTrendEnabled = config?.splitBuyTrendEnabled != null ? !!config.splitBuyTrendEnabled : this.cryptoAll2AutoConfig.splitBuyTrendEnabled;
        const splitBuyTrendMinutes3mRaw = config?.splitBuyTrendMinutes3m != null ? Number(config.splitBuyTrendMinutes3m) : this.cryptoAll2AutoConfig.splitBuyTrendMinutes3m;
        const splitBuyTrendMinutes2mRaw = config?.splitBuyTrendMinutes2m != null ? Number(config.splitBuyTrendMinutes2m) : this.cryptoAll2AutoConfig.splitBuyTrendMinutes2m;
        const splitBuyTrendMinutes1mRaw = config?.splitBuyTrendMinutes1m != null ? Number(config.splitBuyTrendMinutes1m) : this.cryptoAll2AutoConfig.splitBuyTrendMinutes1m;
        const stoplossEnabled = config?.stoplossEnabled != null ? !!config.stoplossEnabled : this.cryptoAll2AutoConfig.stoplossEnabled;
        const stoplossCut1DropCentsRaw = config?.stoplossCut1DropCents != null ? Number(config.stoplossCut1DropCents) : this.cryptoAll2AutoConfig.stoplossCut1DropCents;
        const stoplossCut1SellPctRaw = config?.stoplossCut1SellPct != null ? Number(config.stoplossCut1SellPct) : this.cryptoAll2AutoConfig.stoplossCut1SellPct;
        const stoplossCut2DropCentsRaw = config?.stoplossCut2DropCents != null ? Number(config.stoplossCut2DropCents) : this.cryptoAll2AutoConfig.stoplossCut2DropCents;
        const stoplossCut2SellPctRaw = config?.stoplossCut2SellPct != null ? Number(config.stoplossCut2SellPct) : this.cryptoAll2AutoConfig.stoplossCut2SellPct;
        const stoplossMinSecToExitRaw = config?.stoplossMinSecToExit != null ? Number(config.stoplossMinSecToExit) : this.cryptoAll2AutoConfig.stoplossMinSecToExit;
        const adaptiveDeltaEnabled = config?.adaptiveDeltaEnabled != null ? !!config.adaptiveDeltaEnabled : this.cryptoAll2AutoConfig.adaptiveDeltaEnabled;
        const adaptiveDeltaBigMoveMultiplierRaw = config?.adaptiveDeltaBigMoveMultiplier != null ? Number(config.adaptiveDeltaBigMoveMultiplier) : this.cryptoAll2AutoConfig.adaptiveDeltaBigMoveMultiplier;
        const adaptiveDeltaRevertNoBuyCountRaw = config?.adaptiveDeltaRevertNoBuyCount != null ? Number(config.adaptiveDeltaRevertNoBuyCount) : this.cryptoAll2AutoConfig.adaptiveDeltaRevertNoBuyCount;

        this.cryptoAll2AutoConfig = {
            pollMs: Math.max(500, Math.floor(Number.isFinite(pollMsRaw) ? pollMsRaw : 2_000)),
            expiresWithinSec: Math.max(5, Math.floor(Number.isFinite(expiresWithinSecRaw) ? expiresWithinSecRaw : 180)),
            minProb: Math.max(0, Math.min(1, Number.isFinite(minProbRaw) ? minProbRaw : 0.9)),
            amountUsd: Math.max(1, Number.isFinite(amountUsdRaw) ? amountUsdRaw : 1),
            symbols,
            dojiGuardEnabled,
            riskSkipScore: Math.max(0, Math.min(100, Math.floor(Number.isFinite(riskSkipScoreRaw) ? riskSkipScoreRaw : 70))),
            splitBuyEnabled,
            splitBuyPct3m: Math.max(0, Math.min(1000, Math.floor(Number.isFinite(splitBuyPct3mRaw) ? splitBuyPct3mRaw : 34))),
            splitBuyPct2m: Math.max(0, Math.min(1000, Math.floor(Number.isFinite(splitBuyPct2mRaw) ? splitBuyPct2mRaw : 33))),
            splitBuyPct1m: Math.max(0, Math.min(1000, Math.floor(Number.isFinite(splitBuyPct1mRaw) ? splitBuyPct1mRaw : 33))),
            splitBuyTrendEnabled,
            splitBuyTrendMinutes3m: Math.max(1, Math.min(10, Math.floor(Number.isFinite(splitBuyTrendMinutes3mRaw) ? splitBuyTrendMinutes3mRaw : 3))),
            splitBuyTrendMinutes2m: Math.max(1, Math.min(10, Math.floor(Number.isFinite(splitBuyTrendMinutes2mRaw) ? splitBuyTrendMinutes2mRaw : 2))),
            splitBuyTrendMinutes1m: Math.max(1, Math.min(10, Math.floor(Number.isFinite(splitBuyTrendMinutes1mRaw) ? splitBuyTrendMinutes1mRaw : 1))),
            stoplossEnabled,
            stoplossCut1DropCents: Math.max(0, Math.min(50, Math.floor(Number.isFinite(stoplossCut1DropCentsRaw) ? stoplossCut1DropCentsRaw : 1))),
            stoplossCut1SellPct: Math.max(0, Math.min(100, Math.floor(Number.isFinite(stoplossCut1SellPctRaw) ? stoplossCut1SellPctRaw : 50))),
            stoplossCut2DropCents: Math.max(0, Math.min(50, Math.floor(Number.isFinite(stoplossCut2DropCentsRaw) ? stoplossCut2DropCentsRaw : 2))),
            stoplossCut2SellPct: Math.max(0, Math.min(100, Math.floor(Number.isFinite(stoplossCut2SellPctRaw) ? stoplossCut2SellPctRaw : 100))),
            stoplossMinSecToExit: Math.max(0, Math.min(600, Math.floor(Number.isFinite(stoplossMinSecToExitRaw) ? stoplossMinSecToExitRaw : 25))),
            adaptiveDeltaEnabled,
            adaptiveDeltaBigMoveMultiplier: Math.max(1, Math.min(10, Number.isFinite(adaptiveDeltaBigMoveMultiplierRaw) ? adaptiveDeltaBigMoveMultiplierRaw : 2)),
            adaptiveDeltaRevertNoBuyCount: Math.max(1, Math.min(50, Math.floor(Number.isFinite(adaptiveDeltaRevertNoBuyCountRaw) ? adaptiveDeltaRevertNoBuyCountRaw : 4))),
        };
        this.persistCryptoAll2AutoConfigToFile();
    }

    updateCryptoAllConfig(config?: {
        pollMs?: number;
        expiresWithinSec?: number;
        expiresWithinSecByTimeframe?: any;
        minProb?: number;
        amountUsd?: number;
        symbols?: string[];
        dojiGuardEnabled?: boolean;
        riskSkipScore?: number;
        splitBuyEnabled?: boolean;
        splitBuyPct3m?: number;
        splitBuyPct2m?: number;
        splitBuyPct1m?: number;
        splitBuyTrendEnabled?: boolean;
        splitBuyTrendMinutes3m?: number;
        splitBuyTrendMinutes2m?: number;
        splitBuyTrendMinutes1m?: number;
        stoplossEnabled?: boolean;
        stoplossCut1DropCents?: number;
        stoplossCut1SellPct?: number;
        stoplossCut2DropCents?: number;
        stoplossCut2SellPct?: number;
        stoplossMinSecToExit?: number;
        adaptiveDeltaEnabled?: boolean;
        adaptiveDeltaBigMoveMultiplier?: number;
        adaptiveDeltaRevertNoBuyCount?: number;
    }) {
        const pollMsRaw = config?.pollMs != null ? Number(config.pollMs) : this.cryptoAllAutoConfig.pollMs;
        const expiresWithinSecRaw = config?.expiresWithinSec != null ? Number(config.expiresWithinSec) : this.cryptoAllAutoConfig.expiresWithinSec;
        const expiresWithinSecByTimeframeInput = (config as any)?.expiresWithinSecByTimeframe && typeof (config as any).expiresWithinSecByTimeframe === 'object' ? (config as any).expiresWithinSecByTimeframe : null;
        const minProbRaw = config?.minProb != null ? Number(config.minProb) : this.cryptoAllAutoConfig.minProb;
        const amountUsdRaw = config?.amountUsd != null ? Number(config.amountUsd) : this.cryptoAllAutoConfig.amountUsd;
        const symbols = Array.isArray(config?.symbols) && config?.symbols.length ? Array.from(new Set(config.symbols.map((s) => String(s || '').toUpperCase()).filter(Boolean))) : this.cryptoAllAutoConfig.symbols;
        const dojiGuardEnabled = config?.dojiGuardEnabled != null ? !!config.dojiGuardEnabled : this.cryptoAllAutoConfig.dojiGuardEnabled;
        const riskSkipScoreRaw = config?.riskSkipScore != null ? Number(config.riskSkipScore) : this.cryptoAllAutoConfig.riskSkipScore;
        const splitBuyEnabled = config?.splitBuyEnabled != null ? !!config.splitBuyEnabled : this.cryptoAllAutoConfig.splitBuyEnabled;
        const splitBuyPct3mRaw = config?.splitBuyPct3m != null ? Number(config.splitBuyPct3m) : this.cryptoAllAutoConfig.splitBuyPct3m;
        const splitBuyPct2mRaw = config?.splitBuyPct2m != null ? Number(config.splitBuyPct2m) : this.cryptoAllAutoConfig.splitBuyPct2m;
        const splitBuyPct1mRaw = config?.splitBuyPct1m != null ? Number(config.splitBuyPct1m) : this.cryptoAllAutoConfig.splitBuyPct1m;
        const splitBuyTrendEnabled = config?.splitBuyTrendEnabled != null ? !!config.splitBuyTrendEnabled : this.cryptoAllAutoConfig.splitBuyTrendEnabled;
        const splitBuyTrendMinutes3mRaw = config?.splitBuyTrendMinutes3m != null ? Number(config.splitBuyTrendMinutes3m) : this.cryptoAllAutoConfig.splitBuyTrendMinutes3m;
        const splitBuyTrendMinutes2mRaw = config?.splitBuyTrendMinutes2m != null ? Number(config.splitBuyTrendMinutes2m) : this.cryptoAllAutoConfig.splitBuyTrendMinutes2m;
        const splitBuyTrendMinutes1mRaw = config?.splitBuyTrendMinutes1m != null ? Number(config.splitBuyTrendMinutes1m) : this.cryptoAllAutoConfig.splitBuyTrendMinutes1m;
        const stoplossEnabled = config?.stoplossEnabled != null ? !!config.stoplossEnabled : this.cryptoAllAutoConfig.stoplossEnabled;
        const stoplossCut1DropCentsRaw = config?.stoplossCut1DropCents != null ? Number(config.stoplossCut1DropCents) : this.cryptoAllAutoConfig.stoplossCut1DropCents;
        const stoplossCut1SellPctRaw = config?.stoplossCut1SellPct != null ? Number(config.stoplossCut1SellPct) : this.cryptoAllAutoConfig.stoplossCut1SellPct;
        const stoplossCut2DropCentsRaw = config?.stoplossCut2DropCents != null ? Number(config.stoplossCut2DropCents) : this.cryptoAllAutoConfig.stoplossCut2DropCents;
        const stoplossCut2SellPctRaw = config?.stoplossCut2SellPct != null ? Number(config.stoplossCut2SellPct) : this.cryptoAllAutoConfig.stoplossCut2SellPct;
        const stoplossMinSecToExitRaw = config?.stoplossMinSecToExit != null ? Number(config.stoplossMinSecToExit) : this.cryptoAllAutoConfig.stoplossMinSecToExit;
        const adaptiveDeltaEnabled = config?.adaptiveDeltaEnabled != null ? !!config.adaptiveDeltaEnabled : this.cryptoAllAutoConfig.adaptiveDeltaEnabled;
        const adaptiveDeltaBigMoveMultiplierRaw = config?.adaptiveDeltaBigMoveMultiplier != null ? Number(config.adaptiveDeltaBigMoveMultiplier) : this.cryptoAllAutoConfig.adaptiveDeltaBigMoveMultiplier;
        const adaptiveDeltaRevertNoBuyCountRaw = config?.adaptiveDeltaRevertNoBuyCount != null ? Number(config.adaptiveDeltaRevertNoBuyCount) : this.cryptoAllAutoConfig.adaptiveDeltaRevertNoBuyCount;
        const prevExpByTf = this.cryptoAllAutoConfig.expiresWithinSecByTimeframe || { '5m': this.cryptoAllAutoConfig.expiresWithinSec, '15m': this.cryptoAllAutoConfig.expiresWithinSec, '1h': this.cryptoAllAutoConfig.expiresWithinSec, '4h': this.cryptoAllAutoConfig.expiresWithinSec, '1d': this.cryptoAllAutoConfig.expiresWithinSec };
        const expiresWithinSecByTimeframe = (['5m', '15m', '1h', '4h', '1d'] as const).reduce((acc: any, tf) => {
            const raw = expiresWithinSecByTimeframeInput && (expiresWithinSecByTimeframeInput as any)[tf] != null ? Number((expiresWithinSecByTimeframeInput as any)[tf]) : Number(prevExpByTf[tf] ?? expiresWithinSecRaw);
            acc[tf] = Math.max(5, Math.floor(Number.isFinite(raw) ? raw : expiresWithinSecRaw));
            return acc;
        }, {}) as Record<'5m' | '15m' | '1h' | '4h' | '1d', number>;

        this.cryptoAllAutoConfig = {
            pollMs: Math.max(500, Math.floor(Number.isFinite(pollMsRaw) ? pollMsRaw : 2_000)),
            expiresWithinSec: Math.max(5, Math.floor(Number.isFinite(expiresWithinSecRaw) ? expiresWithinSecRaw : 180)),
            expiresWithinSecByTimeframe,
            minProb: Math.max(0, Math.min(1, Number.isFinite(minProbRaw) ? minProbRaw : 0.9)),
            amountUsd: Math.max(1, Number.isFinite(amountUsdRaw) ? amountUsdRaw : 1),
            symbols,
            timeframes: Array.isArray(this.cryptoAllAutoConfig.timeframes) && this.cryptoAllAutoConfig.timeframes.length ? this.cryptoAllAutoConfig.timeframes : ['15m'],
            dojiGuard: {
                ...this.cryptoAllAutoConfig.dojiGuard,
                enabled: dojiGuardEnabled,
                riskSkipScore: Math.max(0, Math.min(100, Math.floor(Number.isFinite(riskSkipScoreRaw) ? riskSkipScoreRaw : 70))),
            },
            addOn: { ...this.cryptoAllAutoConfig.addOn },
            stoploss: {
                ...this.cryptoAllAutoConfig.stoploss,
                enabled: stoplossEnabled,
                cut1DropCents: Math.max(0, Math.min(50, Math.floor(Number.isFinite(stoplossCut1DropCentsRaw) ? stoplossCut1DropCentsRaw : this.cryptoAllAutoConfig.stoploss.cut1DropCents))),
                cut1SellPct: Math.max(0, Math.min(100, Math.floor(Number.isFinite(stoplossCut1SellPctRaw) ? stoplossCut1SellPctRaw : this.cryptoAllAutoConfig.stoploss.cut1SellPct))),
                cut2DropCents: Math.max(0, Math.min(50, Math.floor(Number.isFinite(stoplossCut2DropCentsRaw) ? stoplossCut2DropCentsRaw : this.cryptoAllAutoConfig.stoploss.cut2DropCents))),
                cut2SellPct: Math.max(0, Math.min(100, Math.floor(Number.isFinite(stoplossCut2SellPctRaw) ? stoplossCut2SellPctRaw : this.cryptoAllAutoConfig.stoploss.cut2SellPct))),
                minSecToExit: Math.max(0, Math.min(600, Math.floor(Number.isFinite(stoplossMinSecToExitRaw) ? stoplossMinSecToExitRaw : this.cryptoAllAutoConfig.stoploss.minSecToExit))),
            },
            dojiGuardEnabled,
            riskSkipScore: Math.max(0, Math.min(100, Math.floor(Number.isFinite(riskSkipScoreRaw) ? riskSkipScoreRaw : 70))),
            splitBuyEnabled,
            splitBuyPct3m: Math.max(0, Math.min(1000, Math.floor(Number.isFinite(splitBuyPct3mRaw) ? splitBuyPct3mRaw : 34))),
            splitBuyPct2m: Math.max(0, Math.min(1000, Math.floor(Number.isFinite(splitBuyPct2mRaw) ? splitBuyPct2mRaw : 33))),
            splitBuyPct1m: Math.max(0, Math.min(1000, Math.floor(Number.isFinite(splitBuyPct1mRaw) ? splitBuyPct1mRaw : 33))),
            splitBuyTrendEnabled,
            splitBuyTrendMinutes3m: Math.max(1, Math.min(10, Math.floor(Number.isFinite(splitBuyTrendMinutes3mRaw) ? splitBuyTrendMinutes3mRaw : 3))),
            splitBuyTrendMinutes2m: Math.max(1, Math.min(10, Math.floor(Number.isFinite(splitBuyTrendMinutes2mRaw) ? splitBuyTrendMinutes2mRaw : 2))),
            splitBuyTrendMinutes1m: Math.max(1, Math.min(10, Math.floor(Number.isFinite(splitBuyTrendMinutes1mRaw) ? splitBuyTrendMinutes1mRaw : 1))),
            stoplossEnabled,
            stoplossCut1DropCents: Math.max(0, Math.min(50, Math.floor(Number.isFinite(stoplossCut1DropCentsRaw) ? stoplossCut1DropCentsRaw : 1))),
            stoplossCut1SellPct: Math.max(0, Math.min(100, Math.floor(Number.isFinite(stoplossCut1SellPctRaw) ? stoplossCut1SellPctRaw : 50))),
            stoplossCut2DropCents: Math.max(0, Math.min(50, Math.floor(Number.isFinite(stoplossCut2DropCentsRaw) ? stoplossCut2DropCentsRaw : 2))),
            stoplossCut2SellPct: Math.max(0, Math.min(100, Math.floor(Number.isFinite(stoplossCut2SellPctRaw) ? stoplossCut2SellPctRaw : 100))),
            stoplossMinSecToExit: Math.max(0, Math.min(600, Math.floor(Number.isFinite(stoplossMinSecToExitRaw) ? stoplossMinSecToExitRaw : 25))),
            adaptiveDeltaEnabled,
            adaptiveDeltaBigMoveMultiplier: Math.max(1, Math.min(10, Number.isFinite(adaptiveDeltaBigMoveMultiplierRaw) ? adaptiveDeltaBigMoveMultiplierRaw : 2)),
            adaptiveDeltaRevertNoBuyCount: Math.max(1, Math.min(50, Math.floor(Number.isFinite(adaptiveDeltaRevertNoBuyCountRaw) ? adaptiveDeltaRevertNoBuyCountRaw : 4))),
        };
        this.persistCryptoAllAutoConfigToFile();
    }

    private ensureCryptoAll2SplitBuyLoop() {
        if (this.cryptoAll2SplitBuyTimer) return;
        this.cryptoAll2SplitBuyTimer = setInterval(() => {
            this.tickCryptoAll2SplitBuyOnce().catch(() => {});
        }, 750);
    }

    private async tickCryptoAll2SplitBuyOnce() {
        if (!this.cryptoAll2SplitBuyState.size) {
            if (this.cryptoAll2SplitBuyTimer) {
                clearInterval(this.cryptoAll2SplitBuyTimer);
                this.cryptoAll2SplitBuyTimer = null;
            }
            return;
        }
        const now = Date.now();
        for (const [k, v] of Array.from(this.cryptoAll2SplitBuyState.entries())) {
            if (!v) { this.cryptoAll2SplitBuyState.delete(k); continue; }
            const expiresAtMs = Number(v.expiresAtMs || 0);
            const remainingSec = Math.floor((expiresAtMs - now) / 1000);
            if (!(remainingSec > 0)) { this.cryptoAll2SplitBuyState.delete(k); continue; }
            const lastAttemptAtMs = Number(v.lastAttemptAtMs || 0);
            if (now - lastAttemptAtMs < 2000) continue;
            const due3m = remainingSec <= 180 && remainingSec > 120;
            const due2m = remainingSec <= 120 && remainingSec > 60;
            const due1m = remainingSec <= 60;
            const nextLeg =
                !v.done3m && due3m ? '3m'
                : !v.done2m && due2m ? '2m'
                : !v.done1m && due1m ? '1m'
                : null;
            if (!nextLeg) continue;
            const amt = nextLeg === '3m' ? Number(v.amount3mUsd) : nextLeg === '2m' ? Number(v.amount2mUsd) : Number(v.amount1mUsd);
            if (!(amt > 0)) {
                if (nextLeg === '3m') v.done3m = true;
                if (nextLeg === '2m') v.done2m = true;
                if (nextLeg === '1m') v.done1m = true;
                v.lastAttemptAtMs = now;
                this.cryptoAll2SplitBuyState.set(k, v);
                continue;
            }
            v.lastAttemptAtMs = now;
            this.cryptoAll2SplitBuyState.set(k, v);
            if (this.cryptoAll2AutoConfig.splitBuyTrendEnabled !== false) {
                const needUpMin =
                    nextLeg === '3m' ? this.cryptoAll2AutoConfig.splitBuyTrendMinutes3m
                    : nextLeg === '2m' ? this.cryptoAll2AutoConfig.splitBuyTrendMinutes2m
                    : this.cryptoAll2AutoConfig.splitBuyTrendMinutes1m;
                const up = await this.isBinanceTrendOkWithSpot({ symbol: String(v.symbol || ''), minutes: needUpMin, direction: v.direction === 'Down' ? 'Down' : 'Up', allowEqual: nextLeg === '2m' || nextLeg === '1m' }).catch(() => ({ ok: false, closes: [], lastClose: null, spot: null, error: 'binance_error' }));
                if (!up.ok) continue;
            }
            const r: any = await this.placeCryptoAll2Order({
                conditionId: String(v.conditionId),
                outcomeIndex: Number(v.outcomeIndex),
                amountUsd: amt,
                minPrice: Number(v.minPrice),
                force: true,
                source: 'addon',
                symbol: v.symbol,
                endDate: v.endDate,
                secondsToExpire: remainingSec,
                stoplossEnabled: v.stoplossConfig?.enabled,
                stoplossCut1DropCents: v.stoplossConfig?.cut1DropCents,
                stoplossCut1SellPct: v.stoplossConfig?.cut1SellPct,
                stoplossCut2DropCents: v.stoplossConfig?.cut2DropCents,
                stoplossCut2SellPct: v.stoplossConfig?.cut2SellPct,
                stoplossMinSecToExit: v.stoplossConfig?.minSecToExit,
            }).catch((e: any) => ({ success: false, error: e?.message || String(e) }));
            if (r?.success === true) {
                if (nextLeg === '3m') v.done3m = true;
                if (nextLeg === '2m') v.done2m = true;
                if (nextLeg === '1m') v.done1m = true;
                this.cryptoAll2SplitBuyState.set(k, v);
            }
            if (v.done3m && v.done2m && v.done1m) {
                this.cryptoAll2SplitBuyState.delete(k);
            }
        }
    }

    private async cryptoAll2TryAutoOnce() {
        if (!this.cryptoAll2AutoEnabled) return;
        if (Date.now() < this.cryptoAll2NextScanAllowedAtMs) return;
        if (this.cryptoAll2AutoInFlight) return;
        this.cryptoAll2AutoInFlight = true;
        if (!this.hasValidKey) {
            this.cryptoAll2LastError = 'Missing private key';
            this.cryptoAll2AutoInFlight = false;
            return;
        }
        const cleanupLocks = () => {
            const now = Date.now();
            for (const [k, v] of this.cryptoAll2OrderLocks.entries()) {
                if (!v) { this.cryptoAll2OrderLocks.delete(k); continue; }
                if (now > Number(v.expiresAtMs || 0) + 10 * 60_000) this.cryptoAll2OrderLocks.delete(k);
                else if (now - Number(v.atMs || 0) > 60 * 60_000) this.cryptoAll2OrderLocks.delete(k);
            }
        };
        const nowMs = Date.now();
        this.cryptoAll2UpdateTracking(nowMs);
        this.cryptoAll2LastScanAt = new Date(nowMs).toISOString();
        try {
            cleanupLocks();
            const r: any = await this.getCryptoAll2Candidates({
                symbols: this.cryptoAll2AutoConfig.symbols,
                minProb: this.cryptoAll2AutoConfig.minProb,
                expiresWithinSec: this.cryptoAll2AutoConfig.expiresWithinSec,
                limit: 40,
            });
            const candidates = Array.isArray(r?.candidates) ? r.candidates : [];
            const okList = candidates.filter((c: any) => c?.eligibleByExpiry === true && c?.meetsMinProb === true && c?.reason == null && c?.conditionId && c?.chosenIndex != null);
            let picked: any = null;
            for (const c of okList) {
                const sym = String(c?.symbol || '').toUpperCase();
                const marketSlug = String(c?.slug || '').trim();
                if (!sym || sym === 'UNKNOWN') continue;
                if (this.cryptoAll2ActivesBySymbol.has(sym)) continue;
                if (this.cryptoAll2TrackedByCondition.has(String(c.conditionId))) continue;
                if (this.cryptoAll2AutoConfig.dojiGuardEnabled && c?.riskScore != null && Number(c.riskScore) >= Number(this.cryptoAll2AutoConfig.riskSkipScore)) continue;
                picked = c;
                break;
            }
            if (!picked) {
                this.cryptoAll2LastError = null;
                this.cryptoAll2AutoInFlight = false;
                return;
            }
            const placed: any = await this.placeCryptoAll2Order({
                conditionId: String(picked.conditionId),
                outcomeIndex: Number(picked.chosenIndex),
                amountUsd: this.cryptoAll2AutoConfig.amountUsd,
                minPrice: this.cryptoAll2AutoConfig.minProb,
                force: false,
                source: 'auto',
                symbol: picked.symbol,
                endDate: picked.endDateIso,
                secondsToExpire: picked.secondsToExpire,
                chosenPrice: picked.chosenPrice,
                stoplossEnabled: this.cryptoAll2AutoConfig.stoplossEnabled,
                stoplossCut1DropCents: this.cryptoAll2AutoConfig.stoplossCut1DropCents,
                stoplossCut1SellPct: this.cryptoAll2AutoConfig.stoplossCut1SellPct,
                stoplossCut2DropCents: this.cryptoAll2AutoConfig.stoplossCut2DropCents,
                stoplossCut2SellPct: this.cryptoAll2AutoConfig.stoplossCut2SellPct,
                stoplossMinSecToExit: this.cryptoAll2AutoConfig.stoplossMinSecToExit,
            }).catch((e: any) => ({ success: false, error: e?.message || String(e) }));
            if (this.cryptoAll2AutoConfig.adaptiveDeltaEnabled === true) {
                const sym = String(picked?.symbol || '').toUpperCase();
                const st = this.cryptoAll2AdaptiveDeltaBySymbol.get(sym);
                const overrideDelta = st?.overrideDelta != null ? Number(st.overrideDelta) : NaN;
                if (st && Number.isFinite(overrideDelta) && overrideDelta > 0) {
                    const didBuy = placed?.active?.phase === 'ordered' || placed?.order?.success === true;
                    const next = { ...st };
                    if (didBuy) {
                        next.noBuyCount = 0;
                    } else {
                        next.noBuyCount = Math.max(0, Math.floor(Number(next.noBuyCount || 0)) + 1);
                        const limit = Math.max(1, Math.floor(Number(this.cryptoAll2AutoConfig.adaptiveDeltaRevertNoBuyCount) || 4));
                        if (next.noBuyCount >= limit) {
                            next.overrideDelta = null;
                            next.noBuyCount = 0;
                        }
                    }
                    this.cryptoAll2AdaptiveDeltaBySymbol.set(sym, next);
                }
            }
            if (placed?.success !== true) {
                this.cryptoAll2LastError = placed?.error || 'order_failed';
                this.cryptoAll2NextScanAllowedAtMs = Date.now() + 2_000;
            } else {
                this.cryptoAll2LastError = null;
                this.cryptoAll2NextScanAllowedAtMs = Date.now() + 500;
            }
        } catch (e: any) {
            this.cryptoAll2LastError = e?.message || String(e);
            this.cryptoAll2NextScanAllowedAtMs = Date.now() + 2_000;
        } finally {
            this.cryptoAll2AutoInFlight = false;
        }
    }

    async placeCryptoAll2Order(params: { conditionId: string; outcomeIndex?: number; amountUsd?: number; minPrice?: number; force?: boolean; source?: 'auto' | 'semi' | 'addon'; symbol?: string; endDate?: string; secondsToExpire?: number; chosenPrice?: number; splitBuyEnabled?: boolean; splitBuyPct3m?: number; splitBuyPct2m?: number; splitBuyPct1m?: number; splitBuyTrendEnabled?: boolean; splitBuyTrendMinutes3m?: number; splitBuyTrendMinutes2m?: number; splitBuyTrendMinutes1m?: number; stoplossEnabled?: boolean; stoplossCut1DropCents?: number; stoplossCut1SellPct?: number; stoplossCut2DropCents?: number; stoplossCut2SellPct?: number; stoplossMinSecToExit?: number }) {
        if (!this.hasValidKey) throw new Error('Missing private key');
        const conditionId = String(params.conditionId || '').trim();
        if (!conditionId) throw new Error('Missing conditionId');
        const requestedAmountUsd = params.amountUsd != null ? Number(params.amountUsd) : NaN;
        const source = params.source || 'semi';
        let amountUsd = Math.max(source === 'addon' ? 0.01 : 1, Number.isFinite(requestedAmountUsd) ? requestedAmountUsd : this.cryptoAll2AutoConfig.amountUsd);
        const force = params.force === true;
        const requestedMinPrice = params.minPrice != null ? Number(params.minPrice) : NaN;
        const effectiveMinPrice = Math.max(0, this.cryptoAll2AutoConfig.minProb, Number.isFinite(requestedMinPrice) ? requestedMinPrice : -Infinity);
        const splitBuyEnabled = params.splitBuyEnabled != null ? (params.splitBuyEnabled === true) : this.cryptoAll2AutoConfig.splitBuyEnabled;
        const splitBuyPct3mRaw = params.splitBuyPct3m != null ? Number(params.splitBuyPct3m) : this.cryptoAll2AutoConfig.splitBuyPct3m;
        const splitBuyPct2mRaw = params.splitBuyPct2m != null ? Number(params.splitBuyPct2m) : this.cryptoAll2AutoConfig.splitBuyPct2m;
        const splitBuyPct1mRaw = params.splitBuyPct1m != null ? Number(params.splitBuyPct1m) : this.cryptoAll2AutoConfig.splitBuyPct1m;
        const splitBuyTrendEnabled = params.splitBuyTrendEnabled != null ? (params.splitBuyTrendEnabled === true) : this.cryptoAll2AutoConfig.splitBuyTrendEnabled;
        const splitBuyTrendMinutes3mRaw = params.splitBuyTrendMinutes3m != null ? Number(params.splitBuyTrendMinutes3m) : this.cryptoAll2AutoConfig.splitBuyTrendMinutes3m;
        const splitBuyTrendMinutes2mRaw = params.splitBuyTrendMinutes2m != null ? Number(params.splitBuyTrendMinutes2m) : this.cryptoAll2AutoConfig.splitBuyTrendMinutes2m;
        const splitBuyTrendMinutes1mRaw = params.splitBuyTrendMinutes1m != null ? Number(params.splitBuyTrendMinutes1m) : this.cryptoAll2AutoConfig.splitBuyTrendMinutes1m;
        const splitBuyConfig = {
            enabled: splitBuyEnabled,
            pct3m: Math.max(0, Math.min(1000, Number.isFinite(splitBuyPct3mRaw) ? splitBuyPct3mRaw : 34)),
            pct2m: Math.max(0, Math.min(1000, Number.isFinite(splitBuyPct2mRaw) ? splitBuyPct2mRaw : 33)),
            pct1m: Math.max(0, Math.min(1000, Number.isFinite(splitBuyPct1mRaw) ? splitBuyPct1mRaw : 33)),
        };
        const splitBuyTrendConfig = {
            enabled: splitBuyTrendEnabled,
            minutes3m: Math.max(1, Math.min(10, Math.floor(Number.isFinite(splitBuyTrendMinutes3mRaw) ? splitBuyTrendMinutes3mRaw : 3))),
            minutes2m: Math.max(1, Math.min(10, Math.floor(Number.isFinite(splitBuyTrendMinutes2mRaw) ? splitBuyTrendMinutes2mRaw : 2))),
            minutes1m: Math.max(1, Math.min(10, Math.floor(Number.isFinite(splitBuyTrendMinutes1mRaw) ? splitBuyTrendMinutes1mRaw : 1))),
        };
        if (
            params.splitBuyEnabled != null || params.splitBuyPct3m != null || params.splitBuyPct2m != null || params.splitBuyPct1m != null
            || params.splitBuyTrendEnabled != null || params.splitBuyTrendMinutes3m != null || params.splitBuyTrendMinutes2m != null || params.splitBuyTrendMinutes1m != null
        ) {
            this.cryptoAll2AutoConfig = {
                ...this.cryptoAll2AutoConfig,
                splitBuyEnabled: splitBuyConfig.enabled,
                splitBuyPct3m: splitBuyConfig.pct3m,
                splitBuyPct2m: splitBuyConfig.pct2m,
                splitBuyPct1m: splitBuyConfig.pct1m,
                splitBuyTrendEnabled: splitBuyTrendConfig.enabled,
                splitBuyTrendMinutes3m: splitBuyTrendConfig.minutes3m,
                splitBuyTrendMinutes2m: splitBuyTrendConfig.minutes2m,
                splitBuyTrendMinutes1m: splitBuyTrendConfig.minutes1m,
            };
        }
        const stoplossEnabled = params.stoplossEnabled != null ? (params.stoplossEnabled === true) : this.cryptoAll2AutoConfig.stoplossEnabled;
        const stoplossCut1DropCentsRaw = params.stoplossCut1DropCents != null ? Number(params.stoplossCut1DropCents) : this.cryptoAll2AutoConfig.stoplossCut1DropCents;
        const stoplossCut1SellPctRaw = params.stoplossCut1SellPct != null ? Number(params.stoplossCut1SellPct) : this.cryptoAll2AutoConfig.stoplossCut1SellPct;
        const stoplossCut2DropCentsRaw = params.stoplossCut2DropCents != null ? Number(params.stoplossCut2DropCents) : this.cryptoAll2AutoConfig.stoplossCut2DropCents;
        const stoplossCut2SellPctRaw = params.stoplossCut2SellPct != null ? Number(params.stoplossCut2SellPct) : this.cryptoAll2AutoConfig.stoplossCut2SellPct;
        const stoplossMinSecToExitRaw = params.stoplossMinSecToExit != null ? Number(params.stoplossMinSecToExit) : this.cryptoAll2AutoConfig.stoplossMinSecToExit;
        const stoplossConfig = {
            enabled: stoplossEnabled,
            cut1DropCents: Math.max(0, Math.min(50, Math.floor(Number.isFinite(stoplossCut1DropCentsRaw) ? stoplossCut1DropCentsRaw : 1))),
            cut1SellPct: Math.max(0, Math.min(100, Math.floor(Number.isFinite(stoplossCut1SellPctRaw) ? stoplossCut1SellPctRaw : 50))),
            cut2DropCents: Math.max(0, Math.min(50, Math.floor(Number.isFinite(stoplossCut2DropCentsRaw) ? stoplossCut2DropCentsRaw : 2))),
            cut2SellPct: Math.max(0, Math.min(100, Math.floor(Number.isFinite(stoplossCut2SellPctRaw) ? stoplossCut2SellPctRaw : 100))),
            spreadGuardCents: 0,
            minSecToExit: Math.max(0, Math.min(600, Math.floor(Number.isFinite(stoplossMinSecToExitRaw) ? stoplossMinSecToExitRaw : 25))),
        };
        if (params.stoplossEnabled != null || params.stoplossCut1DropCents != null || params.stoplossCut1SellPct != null || params.stoplossCut2DropCents != null || params.stoplossCut2SellPct != null || params.stoplossMinSecToExit != null) {
            this.cryptoAll2AutoConfig = {
                ...this.cryptoAll2AutoConfig,
                stoplossEnabled: stoplossConfig.enabled,
                stoplossCut1DropCents: stoplossConfig.cut1DropCents,
                stoplossCut1SellPct: stoplossConfig.cut1SellPct,
                stoplossCut2DropCents: stoplossConfig.cut2DropCents,
                stoplossCut2SellPct: stoplossConfig.cut2SellPct,
                stoplossMinSecToExit: stoplossConfig.minSecToExit,
            };
        }
        if (source !== 'addon' && this.cryptoAll2TrackedByCondition.has(conditionId)) {
            return { success: false, skipped: true, reason: 'already_ordered', conditionId };
        }
        const alreadyInHistory = this.orderHistory.some((e: any) => {
            if (!e) return false;
            if (String(e?.action || '') !== 'cryptoall2_order') return false;
            const mid = String(e?.marketId || '').trim().toLowerCase();
            if (!mid || mid !== conditionId.toLowerCase()) return false;
            const res0 = Array.isArray(e?.results) ? e.results[0] : null;
            const orderStatus = String(res0?.orderStatus || '').toLowerCase();
            if (orderStatus.startsWith('skipped:')) return false;
            const ok = res0?.success === true;
            const orderId = res0?.orderId != null ? String(res0.orderId) : '';
            return ok || !!orderId;
        });
        if (source !== 'addon' && alreadyInHistory) {
            return { success: false, skipped: true, reason: 'already_ordered_history', conditionId };
        }

        const cleanupLocks = () => {
            const now = Date.now();
            for (const [k, v] of this.cryptoAll2OrderLocks.entries()) {
                if (!v) { this.cryptoAll2OrderLocks.delete(k); continue; }
                if (now > Number(v.expiresAtMs || 0) + 10 * 60_000) this.cryptoAll2OrderLocks.delete(k);
                else if (now - Number(v.atMs || 0) > 60 * 60_000) this.cryptoAll2OrderLocks.delete(k);
            }
        };
        cleanupLocks();

        const market = await withRetry(() => this.sdk.clobApi.getMarket(conditionId), { maxRetries: 2 });
        const marketAny: any = market as any;
        const marketSlug = String(marketAny?.marketSlug ?? marketAny?.market_slug ?? '');
        const q = String(marketAny?.question || '');
        const slugLc = marketSlug.toLowerCase();
        const qLc = q.toLowerCase();
        const symbol = String(params.symbol || (slugLc.startsWith('btc-') ? 'BTC' : slugLc.startsWith('eth-') ? 'ETH' : slugLc.startsWith('sol-') ? 'SOL' : slugLc.startsWith('xrp-') ? 'XRP' : qLc.includes('bitcoin') ? 'BTC' : qLc.includes('ethereum') ? 'ETH' : qLc.includes('solana') ? 'SOL' : (qLc.includes('xrp') || qLc.includes('ripple')) ? 'XRP' : 'UNKNOWN'));
        let endDate: string | null = params.endDate != null ? String(params.endDate) : null;
        if (!endDate && marketSlug.includes('-15m-')) {
            const parts = marketSlug.split('-');
            const last = parts[parts.length - 1];
            const n = Number(last);
            if (Number.isFinite(n) && n > 1_500_000_000) {
                const endMs = (Math.floor(n) + 15 * 60) * 1000;
                endDate = new Date(endMs).toISOString();
            }
        }
        if (!endDate) {
            const endIso = marketAny?.endDateIso ?? marketAny?.end_date_iso ?? null;
            const ms = endIso ? Date.parse(String(endIso)) : NaN;
            if (Number.isFinite(ms)) endDate = new Date(ms).toISOString();
        }
        let expiresAtMs = endDate ? Date.parse(endDate) : NaN;
        if (!Number.isFinite(expiresAtMs)) {
            expiresAtMs = Date.now() + 20 * 60_000;
            endDate = new Date(expiresAtMs).toISOString();
        }

        const upperSymbol = String(symbol || '').toUpperCase();

        const tokens: any[] = Array.isArray(marketAny?.tokens) ? marketAny.tokens : [];
        if (tokens.length < 2) throw new Error('Invalid market tokens');
        const requestedIdxRaw = params.outcomeIndex != null ? Math.floor(Number(params.outcomeIndex)) : NaN;
        let idx = Number.isFinite(requestedIdxRaw) ? Math.max(0, Math.min(tokens.length - 1, requestedIdxRaw)) : 0;
        const tokenOutcomeLc = String(tokens[idx]?.outcome || '').toLowerCase();
        if (!tokenOutcomeLc.includes('up') && !tokenOutcomeLc.includes('down')) {
            const upIdx = tokens.findIndex((t: any) => String(t?.outcome || '').toLowerCase().includes('up'));
            const downIdx = tokens.findIndex((t: any) => String(t?.outcome || '').toLowerCase().includes('down'));
            if (upIdx < 0 || downIdx < 0) throw new Error('Missing Up/Down outcomes');
            idx = Number.isFinite(requestedIdxRaw) && requestedIdxRaw === downIdx ? downIdx : upIdx;
        }
        const baseStakeUsd = amountUsd;
        const nowForSplit = Date.now();
        const requestedSecondsToExpire = params.secondsToExpire != null ? Number(params.secondsToExpire) : NaN;
        const remainingSecForSplit = Number.isFinite(requestedSecondsToExpire) ? Math.floor(requestedSecondsToExpire) : Math.floor((expiresAtMs - nowForSplit) / 1000);
        let splitPlan: any = null;
        if (source !== 'addon' && splitBuyConfig.enabled && remainingSecForSplit > 0) {
            const dueLeg =
                remainingSecForSplit <= 180 && remainingSecForSplit > 120 ? '3m'
                : remainingSecForSplit <= 120 && remainingSecForSplit > 60 ? '2m'
                : remainingSecForSplit <= 60 ? '1m'
                : null;
            if (dueLeg) {
                const pctToMultiplier = (pctRaw: number): number => {
                    const pct = Math.max(0, Math.min(300, Math.floor(Number(pctRaw) || 0)));
                    if (pct <= 0) return 0;
                    const level = Math.max(1, Math.min(3, Math.floor(pct / 100)));
                    return Math.pow(2, level - 1);
                };
                const mult3 = pctToMultiplier(splitBuyConfig.pct3m);
                const mult2 = pctToMultiplier(splitBuyConfig.pct2m);
                const mult1 = pctToMultiplier(splitBuyConfig.pct1m);

                const seq1Usd = Number((baseStakeUsd * mult3).toFixed(6));
                const seq2Usd = Number((baseStakeUsd * mult2).toFixed(6));
                const seq3Usd = Number((baseStakeUsd * mult1).toFixed(6));

                const amount3mUsd = dueLeg === '3m' ? seq1Usd : 0;
                const amount2mUsd = dueLeg === '3m' ? seq2Usd : dueLeg === '2m' ? seq1Usd : 0;
                const amount1mUsd = dueLeg === '3m' ? seq3Usd : dueLeg === '2m' ? seq2Usd : dueLeg === '1m' ? seq1Usd : 0;

                const legAmount = dueLeg === '3m' ? amount3mUsd : dueLeg === '2m' ? amount2mUsd : amount1mUsd;
                if (legAmount >= 1) {
                    amountUsd = legAmount;
                    const direction: 'Up' | 'Down' = String(tokens[idx]?.outcome || '').toLowerCase().includes('down') ? 'Down' : 'Up';
                    splitPlan = {
                        key: `${conditionId}:${idx}`,
                        conditionId,
                        outcomeIndex: idx,
                        symbol,
                        direction,
                        endDate,
                        expiresAtMs,
                        minPrice: effectiveMinPrice,
                        stoplossConfig,
                        dueLeg,
                        amount3mUsd,
                        amount2mUsd,
                        amount1mUsd,
                        done3m: dueLeg !== '3m',
                        done2m: false,
                        done1m: dueLeg === '1m' || (dueLeg === '2m' && !(amount1mUsd >= 1)),
                        lastAttemptAtMs: 0,
                    };
                }
            }
        }
        const tok: any = tokens[idx];
        const tokenId = String(tok?.tokenId ?? tok?.token_id ?? tok?.id ?? '').trim();
        if (!tokenId) throw new Error('Missing tokenId');
        const outcome = String(tok?.outcome ?? '').trim() || `idx_${idx}`;

        const recordSkipEarly = (reason: string, extra?: any) => {
            try {
                const orderStatus = `skipped:${reason}`;
                const last = this.orderHistory[0];
                if (last && String(last?.action || '') === 'cryptoall2_order' && String(last?.marketId || '') === conditionId) {
                    const lastStatus = Array.isArray(last?.results) && last.results.length ? String(last.results[0]?.orderStatus || '') : '';
                    const lastTs = last?.timestamp ? Date.parse(String(last.timestamp)) : NaN;
                    if (lastStatus === orderStatus && Number.isFinite(lastTs) && (Date.now() - lastTs) < 5000) return;
                }
                this.orderHistory.unshift({
                    id: Date.now(),
                    timestamp: new Date().toISOString(),
                    mode: source,
                    action: 'cryptoall2_order',
                    marketId: conditionId,
                    symbol: upperSymbol || symbol,
                    slug: marketSlug || null,
                    marketQuestion: market?.question ?? null,
                    outcome,
                    outcomeIndex: idx,
                    tokenId,
                    amountUsd,
                    results: [{ success: false, orderId: null, tokenId, outcome, conditionId, orderStatus, errorMsg: extra != null ? String(extra) : '' }],
                });
                if (this.orderHistory.length > 300) this.orderHistory.pop();
                this.schedulePersistOrderHistory();
            } catch {
            }
        };

        if (!force && source !== 'addon' && upperSymbol && upperSymbol !== 'UNKNOWN' && marketSlug) {
            const baseMinDelta =
                upperSymbol === 'BTC' ? this.cryptoAll2DeltaThresholds.btcMinDelta
                : upperSymbol === 'ETH' ? this.cryptoAll2DeltaThresholds.ethMinDelta
                : upperSymbol === 'SOL' ? this.cryptoAll2DeltaThresholds.solMinDelta
                : upperSymbol === 'XRP' ? this.cryptoAll2DeltaThresholds.xrpMinDelta
                : 0;
            let overrideDelta: number | null = null;
            let minDeltaRequired = baseMinDelta;
            if (baseMinDelta > 0 && this.cryptoAll2AutoConfig.adaptiveDeltaEnabled === true) {
                const s = this.cryptoAll2AdaptiveDeltaBySymbol.get(upperSymbol);
                const d = s?.overrideDelta != null ? Number(s.overrideDelta) : NaN;
                overrideDelta = Number.isFinite(d) && d > 0 ? d : null;
                if (overrideDelta != null) minDeltaRequired = overrideDelta;
            }
            if (minDeltaRequired > 0) {
                const beat = await this.fetchCrypto15mBeatAndCurrentFromSite(marketSlug);
                if (beat.deltaAbs == null) {
                    recordSkipEarly('delta_unavailable', beat.error || 'Failed to compute delta');
                    return { success: false, skipped: true, reason: 'delta_unavailable', symbol: upperSymbol, slug: marketSlug || null, minDeltaBase: baseMinDelta, minDeltaRequired, minDeltaOverride: overrideDelta, error: beat.error || 'Failed to compute delta' };
                }
                const deltaAbs = Number(beat.deltaAbs);
                if (this.cryptoAll2AutoConfig.adaptiveDeltaEnabled === true && baseMinDelta > 0 && Number.isFinite(deltaAbs) && deltaAbs > 0) {
                    const m = Number(this.cryptoAll2AutoConfig.adaptiveDeltaBigMoveMultiplier) || 2;
                    if (deltaAbs >= baseMinDelta * Math.max(1, m)) {
                        this.cryptoAll2AdaptiveDeltaBySymbol.set(upperSymbol, { overrideDelta: deltaAbs, noBuyCount: 0, lastBigMoveAt: new Date().toISOString(), lastBigMoveDelta: deltaAbs });
                        overrideDelta = deltaAbs;
                        minDeltaRequired = deltaAbs;
                    }
                }
                if (Number.isFinite(deltaAbs) && deltaAbs < Number(minDeltaRequired)) {
                    recordSkipEarly('delta_too_small', `deltaAbs=${deltaAbs}, minDeltaRequired=${minDeltaRequired}`);
                    return { success: false, skipped: true, reason: 'delta_too_small', symbol: upperSymbol, slug: marketSlug || null, minDeltaBase: baseMinDelta, minDeltaRequired, minDeltaOverride: overrideDelta, deltaAbs, priceToBeat: beat.priceToBeat, currentPrice: beat.currentPrice };
                }
            }
        }

        const booksFetchedAtMs = Date.now();
        const books = await this.fetchClobBooks([tokenId]);
        const book = books && books.length ? books[0] : null;
        const booksCache = (this as any).clobBooksCache as Map<string, { atMs: number; data: any[] }> | undefined;
        const booksCacheAtMs = booksCache?.get(String(tokenId))?.atMs ?? null;
        const booksStaleMs = booksCacheAtMs != null ? Math.max(0, booksFetchedAtMs - Number(booksCacheAtMs)) : null;
        const asks = Array.isArray(book?.asks) ? book.asks : [];
        const bids = Array.isArray(book?.bids) ? book.bids : [];
        let bestAsk = NaN;
        for (const a of asks) {
            const p = Number(a?.price);
            if (!Number.isFinite(p) || p <= 0) continue;
            if (!Number.isFinite(bestAsk) || p < bestAsk) bestAsk = p;
        }
        const asksCount = asks.length;
        if (!(asksCount > 0) || !Number.isFinite(bestAsk) || bestAsk <= 0) {
            throw new Error(`No asks (orderbook unavailable) for tokenId=${tokenId}`);
        }
        const price = bestAsk;
        if (Number.isFinite(effectiveMinPrice) && effectiveMinPrice > 0 && price < effectiveMinPrice) {
            throw new Error(`Price below threshold: bestAsk=${price} < minPrice=${effectiveMinPrice}`);
        }

        const orderLockKey = upperSymbol && upperSymbol !== 'UNKNOWN' ? `${upperSymbol}:${expiresAtMs}` : null;
        if (!force && orderLockKey) {
            if (this.cryptoAll2ActivesBySymbol.has(upperSymbol)) {
                recordSkipEarly('already_active');
                return { success: false, skipped: true, reason: 'already_active', symbol: upperSymbol, slug: marketSlug || null, expiresAtMs };
            }
            const locked = this.cryptoAll2OrderLocks.get(orderLockKey);
            if (locked && locked.status === 'placing') {
                recordSkipEarly('duplicate_inflight');
                return { success: false, skipped: true, reason: 'duplicate_inflight', symbol: upperSymbol, slug: marketSlug || null, expiresAtMs };
            }
            this.cryptoAll2OrderLocks.set(orderLockKey, { atMs: Date.now(), symbol: upperSymbol, expiresAtMs, conditionId, status: 'placing' });
        }

        const limitPrice = Math.min(0.999, Math.max(effectiveMinPrice, price) + 0.02);
        const globalKey = `cryptoall2:${conditionId}`.toLowerCase();
        let order: any = null;
        let globalOk = false;
        try {
            if (!force) {
                if (!this.tryAcquireGlobalOrderLock(globalKey, 'other')) {
                    recordSkipEarly('global_locked');
                    return { success: false, skipped: true, reason: 'global_locked', symbol: upperSymbol || symbol, slug: marketSlug || null, expiresAtMs };
                }
                if (this.globalOrderPlaceInFlight) {
                    this.markGlobalOrderLockDone(globalKey, false);
                    recordSkipEarly('global_inflight');
                    return { success: false, skipped: true, reason: 'global_inflight', symbol: upperSymbol || symbol, slug: marketSlug || null, expiresAtMs };
                }
                this.globalOrderPlaceInFlight = true;
            }
            order = await this.tradingClient.createMarketOrder({
                tokenId,
                side: 'BUY',
                amount: amountUsd,
                price: limitPrice,
                orderType: 'FAK',
            });
            globalOk = !!order?.success;
            if (!globalOk) {
                const oid = order?.orderId != null ? String(order.orderId) : (order?.orderID != null ? String(order.orderID) : (order?.id != null ? String(order.id) : null));
                const probe = await this.probeRecentBuyState({ conditionId, tokenId, orderId: oid, maxWaitMs: 900 }).catch(() => null as any);
                const has = probe && ((probe.filledUsd != null && Number(probe.filledUsd) > 0) || probe.hasOpen === true || probe.orderFetched === true);
                if (has) {
                    globalOk = true;
                    order = { ...(order || {}), success: true, orderId: (order?.orderId ?? (probe?.orderId ?? null)), errorMsg: null };
                }
            }
        } catch (e: any) {
            if (orderLockKey) {
                this.cryptoAll2OrderLocks.set(orderLockKey, { atMs: Date.now(), symbol: upperSymbol, expiresAtMs, conditionId, status: 'failed' });
            }
            throw e;
        } finally {
            if (!force) {
                this.globalOrderPlaceInFlight = false;
                this.markGlobalOrderLockDone(globalKey, globalOk);
            }
        }

        const orderStatus = order?.success === true
            ? 'placed'
            : `failed:${String(order?.errorMsg || 'order_failed').slice(0, 160)}`;
        const entry = {
            id: Date.now(),
            timestamp: new Date().toISOString(),
            mode: source,
            action: 'cryptoall2_order',
            marketId: conditionId,
            symbol,
            slug: marketSlug || undefined,
            marketQuestion: market?.question,
            outcome,
            price: price,
            bestAsk: price,
            limitPrice,
            amountUsd: amountUsd,
            results: [{ ...order, orderStatus, tokenId, outcome, conditionId }],
        };
        this.orderHistory.unshift(entry);
        if (this.orderHistory.length > 100) this.orderHistory.pop();
        this.schedulePersistOrderHistory();

        if (order?.success === true && splitPlan && splitPlan.dueLeg) {
            if (splitPlan.dueLeg === '3m') splitPlan.done3m = true;
            if (splitPlan.dueLeg === '2m') splitPlan.done2m = true;
            if (splitPlan.dueLeg === '1m') splitPlan.done1m = true;
            splitPlan.lastAttemptAtMs = Date.now();
            this.cryptoAll2SplitBuyState.set(String(splitPlan.key), splitPlan);
            this.ensureCryptoAll2SplitBuyLoop();
        }

        const active = {
            startedAt: entry.timestamp,
            phase: order?.success ? 'ordered' : 'failed',
            symbol,
            conditionId,
            tokenId,
            outcome,
            price: price,
            bestAsk: price,
            limitPrice,
            amountUsd: amountUsd,
            source,
            orderId: order?.orderId ?? order?.id ?? null,
            order,
            endDate,
            expiresAtMs,
            secondsToExpire: params.secondsToExpire,
            chosenPrice: params.chosenPrice,
        };
        if (source === 'addon') {
            const prev = this.cryptoAll2TrackedByCondition.get(conditionId);
            if (prev) {
                const merged = {
                    ...prev,
                    amountUsd: (Number(prev?.amountUsd) || 0) + Number(amountUsd),
                    lastAddOnAt: entry.timestamp,
                    lastAddOnAmountUsd: amountUsd,
                };
                this.cryptoAll2TrackedByCondition.set(conditionId, merged);
                const sym = String(merged?.symbol || '').toUpperCase();
                if (sym && sym !== 'UNKNOWN' && this.cryptoAll2ActivesBySymbol.get(sym)?.conditionId === conditionId) {
                    this.cryptoAll2ActivesBySymbol.set(sym, merged);
                }
            }
        } else {
            this.cryptoAll2TrackedByCondition.set(conditionId, active);
            if (active.phase === 'ordered' && symbol && symbol !== 'UNKNOWN') {
                this.cryptoAll2ActivesBySymbol.set(symbol, active);
            }
        }

        if (active.phase === 'ordered' && stoplossConfig.enabled === true) {
            const entryPrice = active?.bestAsk != null ? Number(active.bestAsk) : NaN;
            const sizeEstimate = Number.isFinite(entryPrice) && entryPrice > 0 ? (Number(amountUsd) / entryPrice) : 0;
            const tf: any = '15m';
            if (Number.isFinite(entryPrice) && entryPrice > 0 && sizeEstimate > 0) {
                this.registerCryptoAllStoplossPosition({
                    strategy: 'cryptoall2',
                    conditionId,
                    tokenId,
                    symbol: upperSymbol,
                    timeframe: tf,
                    endMs: expiresAtMs,
                    entryPrice,
                    sizeEstimate,
                    stoploss: {
                        cut1DropCents: stoplossConfig.cut1DropCents,
                        cut1SellPct: stoplossConfig.cut1SellPct,
                        cut2DropCents: stoplossConfig.cut2DropCents,
                        cut2SellPct: stoplossConfig.cut2SellPct,
                        minSecToExit: stoplossConfig.minSecToExit,
                    }
                });
                this.startCryptoAllStoplossLoop();
            }
        }

        if (order?.success === true) {
            return { success: true, active, order };
        }
        return { success: false, error: order?.errorMsg || 'order_failed', active, order };
    }

    private crypto15mUpdateTracking(nowMs: number) {
        for (const [symbol, a] of this.crypto15mActivesBySymbol.entries()) {
            const endMs = a?.expiresAtMs != null ? Number(a.expiresAtMs) : Date.parse(String(a?.endDate || ''));
            if (Number.isFinite(endMs) && nowMs > endMs) {
                const expired = { ...a, phase: 'expired', expiredAt: new Date(nowMs).toISOString() };
                this.crypto15mTrackedByCondition.set(String(expired.conditionId), expired);
                const cid = String(expired.conditionId || '').trim();
                if (cid) this.crypto15mSweepStateByConditionId.delete(cid);
                this.crypto15mActivesBySymbol.delete(symbol);
                this.crypto15mCooldownUntilBySymbol.set(symbol, nowMs + 2_000);
            }
        }
        const cutoff = nowMs - 48 * 60 * 60_000;
        for (const [cid, a] of this.crypto15mTrackedByCondition.entries()) {
            const started = Date.parse(String(a?.startedAt || a?.started_at || ''));
            if (Number.isFinite(started) && started < cutoff) this.crypto15mTrackedByCondition.delete(cid);
        }
        for (const [cid, s] of this.crypto15mSweepStateByConditionId.entries()) {
            const expiresAtMs = s?.expiresAtMs != null ? Number(s.expiresAtMs) : NaN;
            if (Number.isFinite(expiresAtMs) && nowMs > expiresAtMs + 10 * 60_000) this.crypto15mSweepStateByConditionId.delete(cid);
        }
    }

    private crypto15mUpdateTracked(conditionId: string, updater: (cur: any) => any) {
        const cid = String(conditionId || '').trim();
        if (!cid) return;
        const cur = this.crypto15mTrackedByCondition.get(cid);
        if (!cur) return;
        const next = updater(cur);
        this.crypto15mTrackedByCondition.set(cid, next);
        const symbol = String(next?.symbol || '').toUpperCase();
        if (symbol && this.crypto15mActivesBySymbol.get(symbol)?.conditionId === cid) {
            this.crypto15mActivesBySymbol.set(symbol, next);
        }
    }

    private crypto15mSyncFromRedeemInFlight(conditionId: string) {
        const cid = String(conditionId || '').trim();
        if (!cid) return;
        const r = this.redeemInFlight.get(cid);
        if (!r) return;
        this.crypto15mUpdateTracked(cid, (cur) => ({
            ...cur,
            redeemStatus: r.status,
            redeemMethod: r.method,
            redeemTransactionId: r.transactionId ?? cur.redeemTransactionId,
            redeemTxHash: r.txHash ?? cur.redeemTxHash,
            redeemPaid: r.paid ?? cur.redeemPaid,
            redeemPayoutUsdc: r.payoutNetUsdc ?? r.payoutUsdc ?? cur.redeemPayoutUsdc,
            redeemUpdatedAt: new Date().toISOString(),
            phase: r.status === 'confirmed' && r.paid === true ? 'redeemed' : r.status === 'failed' ? 'redeem_failed' : cur.phase,
        }));
    }

    private async crypto15mTryAutoOnce() {
        if (!this.crypto15mAutoEnabled) return;
        if (Date.now() < this.crypto15mNextScanAllowedAtMs) return;
        if (this.crypto15mAutoInFlight) return;
        this.crypto15mAutoInFlight = true;
        if (!this.crypto15mAutoDryRun && !this.hasValidKey) {
            this.crypto15mLastError = 'Missing private key';
            this.crypto15mAutoInFlight = false;
            return;
        }
        const cleanupLocks = () => {
            const now = Date.now();
            for (const [k, v] of this.crypto15mOrderLocks.entries()) {
                if (!v) { this.crypto15mOrderLocks.delete(k); continue; }
                if (now > Number(v.expiresAtMs || 0) + 10 * 60_000) this.crypto15mOrderLocks.delete(k);
                else if (now - Number(v.atMs || 0) > 60 * 60_000) this.crypto15mOrderLocks.delete(k);
            }
        };
        const nowMs = Date.now();
        const staleMsThreshold = Number.isFinite(Number(this.crypto15mAutoConfig.staleMsThreshold)) ? Number(this.crypto15mAutoConfig.staleMsThreshold) : 1500;
        this.crypto15mUpdateTracking(nowMs);
        this.crypto15mLastScanAt = new Date(nowMs).toISOString();
        try {
            cleanupLocks();
            const r = await this.getCrypto15mCandidates({ minProb: this.crypto15mAutoConfig.minProb, expiresWithinSec: this.crypto15mAutoConfig.expiresWithinSec, limit: 30 });
            const staleMs = (r as any)?.staleMs != null ? Number((r as any).staleMs) : null;
            const booksError = (r as any)?.booksError != null ? String((r as any).booksError) : null;
            const marketError = (r as any)?.marketError != null ? String((r as any).marketError) : null;
            if (booksError) {
                this.crypto15mLastError = `books_error: ${booksError}`;
                return;
            }
            if (marketError) {
                this.crypto15mLastError = `market_error: ${marketError}`;
                return;
            }
            if (staleMs != null && Number.isFinite(staleMs) && staleMs > staleMsThreshold) {
                this.crypto15mLastError = `books_stale: ${Math.floor(staleMs)}ms`;
                return;
            }
            this.crypto15mLastError = null;
            const candidates = Array.isArray((r as any)?.candidates) ? (r as any).candidates : [];
            const symbols = ['BTC', 'ETH', 'SOL', 'XRP'];
            const decisions: any[] = [];
            for (const symbol of symbols) {
                if (this.crypto15mActivesBySymbol.has(symbol)) { decisions.push({ symbol, action: 'skip', reason: 'already_active' }); continue; }
                const cd = this.crypto15mCooldownUntilBySymbol.get(symbol);
                if (cd != null && nowMs < cd) { decisions.push({ symbol, action: 'skip', reason: 'cooldown', untilMs: cd }); continue; }
                const pick = candidates.find((c: any) => String(c?.symbol || '').toUpperCase() === symbol && c?.eligibleByExpiry && c?.meetsMinProb && c?.reason == null) || null;
                if (!pick) {
                    const best = candidates
                        .filter((c: any) => String(c?.symbol || '').toUpperCase() === symbol)
                        .slice()
                        .sort((a: any, b: any) => (Number(b?.chosenPrice) || -Infinity) - (Number(a?.chosenPrice) || -Infinity))[0] || null;
                    const sample = best ? {
                        conditionId: best?.conditionId ?? null,
                        reason: best?.reason ?? null,
                        eligibleByExpiry: best?.eligibleByExpiry ?? null,
                        meetsMinProb: best?.meetsMinProb ?? null,
                        chosenOutcome: best?.chosenOutcome ?? null,
                        chosenPrice: best?.chosenPrice ?? null,
                        secondsToExpire: best?.secondsToExpire ?? null,
                        booksError: best?.booksError ?? null,
                        marketsError: best?.marketsError ?? null,
                    } : null;
                    decisions.push({ symbol, action: 'skip', reason: 'no_candidate', sample });
                    continue;
                }
                const cid = String(pick.conditionId || '');
                if (cid && this.crypto15mTrackedByCondition.has(cid)) { decisions.push({ symbol, action: 'skip', reason: 'already_tracked', conditionId: cid }); continue; }
                const orderParams: any = {
                    conditionId: cid,
                    outcomeIndex: Number(pick.chosenIndex),
                    amountUsd: this.crypto15mAutoConfig.amountUsd,
                    minPrice: this.crypto15mAutoConfig.minProb,
                    source: 'auto',
                    symbol,
                    endDate: pick.endDate,
                    secondsToExpire: pick.secondsToExpire,
                    chosenPrice: pick.chosenPrice,
                };
                const placed: any = this.crypto15mAutoDryRun
                    ? { success: true, dryRun: true, wouldPlaceOrder: true, params: orderParams }
                    : await this.placeCrypto15mOrder(orderParams);
                if (this.crypto15mAutoDryRun) this.crypto15mLastOrderAttempt = { at: new Date().toISOString(), type: 'dry_run', params: orderParams };
                decisions.push({ symbol, action: this.crypto15mAutoDryRun ? 'would_place' : placed?.success ? 'placed' : 'failed', conditionId: cid, outcomeIndex: Number(pick.chosenIndex), chosenPrice: pick.chosenPrice, secondsToExpire: pick.secondsToExpire, dryRun: this.crypto15mAutoDryRun === true, error: placed?.error ?? null, reason: placed?.reason ?? null });
                if (!this.crypto15mAutoDryRun && this.crypto15mAutoConfig.adaptiveDeltaEnabled === true) {
                    const st = this.crypto15mAdaptiveDeltaBySymbol.get(symbol);
                    const overrideDelta = st?.overrideDelta != null ? Number(st.overrideDelta) : NaN;
                    if (st && Number.isFinite(overrideDelta) && overrideDelta > 0) {
                        const didBuy = placed?.active?.phase === 'ordered' || placed?.order?.success === true;
                        const next = { ...st };
                        if (didBuy) {
                            next.noBuyCount = 0;
                        } else {
                            next.noBuyCount = Math.max(0, Math.floor(Number(next.noBuyCount || 0)) + 1);
                            const limit = Math.max(1, Math.floor(Number(this.crypto15mAutoConfig.adaptiveDeltaRevertNoBuyCount) || 4));
                            if (next.noBuyCount >= limit) {
                                next.overrideDelta = null;
                                next.noBuyCount = 0;
                            }
                        }
                        this.crypto15mAdaptiveDeltaBySymbol.set(symbol, next);
                    }
                }
                if (placed?.success !== true) {
                    const reason = placed?.reason ? String(placed.reason) : 'order_skipped';
                    const msg = placed?.minDeltaRequired != null && placed?.deltaAbs != null
                        ? `${reason}: ${symbol} delta=${placed.deltaAbs} < ${placed.minDeltaRequired}`
                        : placed?.error ? String(placed.error) : reason;
                    this.crypto15mLastError = msg;
                }
            }
            if (this.crypto15mAutoDryRun) {
                this.crypto15mLastDecision = {
                    at: new Date().toISOString(),
                    dryRun: true,
                    config: { minProb: this.crypto15mAutoConfig.minProb, expiresWithinSec: this.crypto15mAutoConfig.expiresWithinSec, amountUsd: this.crypto15mAutoConfig.amountUsd },
                    candidatesCount: candidates.length,
                    decisions,
                };
            }
        } catch (e: any) {
            if (e?.retryAfterMs != null || String(e?.message || '').includes('(429)')) {
                const retryAfterMs = e?.retryAfterMs != null ? Number(e.retryAfterMs) : 60_000;
                this.crypto15mNextScanAllowedAtMs = Date.now() + Math.max(5_000, retryAfterMs);
            }
            this.crypto15mLastError = e?.message || String(e);
        } finally {
            this.crypto15mAutoInFlight = false;
        }
    }

    private crypto15mHedgeUpdateTracking(nowMs: number) {
        const now = Number(nowMs || Date.now());
        for (const [symbol, a] of this.crypto15mHedgeActivesBySymbol.entries()) {
            const expiresAtMs = a?.expiresAtMs != null ? Number(a.expiresAtMs) : NaN;
            if (Number.isFinite(expiresAtMs) && now >= expiresAtMs) {
                const cid = String(a?.conditionId || '').trim();
                const next = { ...a, phase: a?.phase === 'hedged' ? 'expired_hedged' : a?.phase === 'waiting_hedge' || a?.phase === 'hedging' ? 'expired_unhedged' : 'expired', endedAt: new Date(now).toISOString() };
                if (cid) this.crypto15mHedgeTrackedByCondition.set(cid, next);
                this.crypto15mHedgeActivesBySymbol.delete(symbol);
            }
        }
        if (this.crypto15mHedgeTrackedByCondition.size > 250) {
            const list = Array.from(this.crypto15mHedgeTrackedByCondition.entries())
                .sort((a: any, b: any) => String(b?.[1]?.startedAt || '').localeCompare(String(a?.[1]?.startedAt || '')));
            const keep = list.slice(0, 200);
            this.crypto15mHedgeTrackedByCondition = new Map(keep);
        }
    }

    private async crypto15mHedgeTryAutoOnce() {
        if (!this.crypto15mHedgeAutoEnabled) return;
        if (this.crypto15mHedgeAutoInFlight) return;
        this.crypto15mHedgeAutoInFlight = true;
        const nowMs = Date.now();
        this.crypto15mHedgeLastScanAt = new Date(nowMs).toISOString();
        if (!this.hasValidKey) {
            this.crypto15mHedgeLastError = 'Missing private key';
            this.crypto15mHedgeAutoInFlight = false;
            return;
        }
        const cleanupLocks = () => {
            const now = Date.now();
            for (const [k, v] of this.crypto15mHedgeOrderLocks.entries()) {
                if (!v) { this.crypto15mHedgeOrderLocks.delete(k); continue; }
                if (now > Number(v.expiresAtMs || 0) + 10 * 60_000) this.crypto15mHedgeOrderLocks.delete(k);
                else if (now - Number(v.atMs || 0) > 60 * 60_000) this.crypto15mHedgeOrderLocks.delete(k);
            }
        };
        const computeBest = (book: any) => {
            const asks = Array.isArray(book?.asks) ? book.asks : [];
            const bids = Array.isArray(book?.bids) ? book.bids : [];
            let bestAsk = NaN;
            let bestBid = NaN;
            for (const a of asks) {
                const p = Number(a?.price);
                if (!Number.isFinite(p) || p <= 0) continue;
                if (!Number.isFinite(bestAsk) || p < bestAsk) bestAsk = p;
            }
            for (const b of bids) {
                const p = Number(b?.price);
                if (!Number.isFinite(p) || p <= 0) continue;
                if (!Number.isFinite(bestBid) || p > bestBid) bestBid = p;
            }
            const spreadCents = Number.isFinite(bestAsk) && Number.isFinite(bestBid) ? Math.max(0, (bestAsk - bestBid) * 100) : null;
            return { asks, bestAsk: Number.isFinite(bestAsk) ? bestAsk : null, bestBid: Number.isFinite(bestBid) ? bestBid : null, spreadCents };
        };
        const computeTradableShares = (asks: any[], limitPrice: number, maxLevels: number) => {
            const normalized = (Array.isArray(asks) ? asks : [])
                .map((a: any) => {
                    const price = Number(a?.price);
                    const size = Number(a?.size ?? a?.amount ?? a?.quantity);
                    if (!Number.isFinite(price) || price <= 0) return null;
                    if (!Number.isFinite(size) || size <= 0) return null;
                    if (Number.isFinite(limitPrice) && price > limitPrice) return null;
                    return { price, size };
                })
                .filter(Boolean) as Array<{ price: number; size: number }>;
            normalized.sort((a, b) => a.price - b.price);
            let shares = 0;
            let levels = 0;
            for (const lvl of normalized) {
                if (levels >= maxLevels) break;
                shares += lvl.size;
                levels += 1;
            }
            return shares;
        };
        const waitForOrderFill = async (orderId: string) => {
            const id = String(orderId || '').trim();
            if (!id) return null;
            for (let i = 0; i < 3; i++) {
                const o = await this.tradingClient.getOrder(id).catch(() => null);
                if (o && (o.filledSize != null || o.status)) return o;
                await new Promise(r => setTimeout(r, 250));
            }
            return null;
        };
        const attemptHedge = async (active: any) => {
            const now = Date.now();
            const expiresAtMs = active?.expiresAtMs != null ? Number(active.expiresAtMs) : NaN;
            const remainingSec = Number.isFinite(expiresAtMs) ? Math.floor((expiresAtMs - now) / 1000) : null;
            const entryPrice = active?.entryPrice != null ? Number(active.entryPrice) : NaN;
            const entryShares = active?.entryFilledShares != null ? Number(active.entryFilledShares) : NaN;
            const hedgeFilledShares = active?.hedgeFilledShares != null ? Number(active.hedgeFilledShares) : 0;
            const remainingShares = (Number.isFinite(entryShares) ? entryShares : 0) - (Number.isFinite(hedgeFilledShares) ? hedgeFilledShares : 0);
            const panicNow = this.crypto15mHedgeAutoConfig.panicHedgeEnabled === true
                && remainingSec != null
                && Number.isFinite(Number(remainingSec))
                && Number(remainingSec) <= Number(this.crypto15mHedgeAutoConfig.panicHedgeStartSec);
            if (remainingSec != null && remainingSec <= this.crypto15mHedgeAutoConfig.minSecToHedge && !panicNow) {
                return { did: false, reason: 'hedge_window_closed', remainingSec };
            }
            if (!(remainingShares > 0.01)) return { did: false, reason: 'hedge_done', remainingSec };
            if (!Number.isFinite(entryPrice) || entryPrice <= 0) return { did: false, reason: 'missing_entry_price', remainingSec };
            const profitCents = this.computeCrypto15mHedgeEffectiveProfitCents(remainingSec, this.crypto15mHedgeAutoConfig);
            const profit = Number(profitCents) / 100;
            const bufferCents = Number(this.crypto15mHedgeAutoConfig.bufferCents);
            const buffer = bufferCents / 100;
            const panicLoss = Math.max(0, Number(this.crypto15mHedgeAutoConfig.panicMaxLossCents || 0)) / 100;
            const p2MaxRaw = panicNow ? (1 + panicLoss - buffer - entryPrice) : (1 - profit - buffer - entryPrice);
            const p2Max = Math.min(0.999, p2MaxRaw);
            if (!(p2Max > 0)) return { did: false, reason: 'hedge_edge_too_small', remainingSec, profitCents, bufferCents, entryPrice, p2Max };
            const hedgeTokenId = String(active?.hedgeTokenId || '').trim();
            if (!hedgeTokenId) return { did: false, reason: 'missing_hedge_token', remainingSec, profitCents, bufferCents, entryPrice, p2Max };
            const books = await this.fetchClobBooks([hedgeTokenId]);
            const book = books && books.length ? books[0] : null;
            const best = computeBest(book);
            const bestAsk = best.bestAsk != null ? Number(best.bestAsk) : NaN;
            const bestBid = best.bestBid != null ? Number(best.bestBid) : NaN;
            const spreadCents = best.spreadCents != null ? Number(best.spreadCents) : null;
            if (!Number.isFinite(bestAsk) || bestAsk <= 0) return { did: false, reason: 'no_asks', remainingSec, profitCents, bufferCents, entryPrice, p2Max };
            const ignoreSpread = panicNow ? true : (this.crypto15mHedgeAutoConfig.hedgeIgnoreSpread === true);
            if (!ignoreSpread && spreadCents != null && spreadCents > Number(this.crypto15mHedgeAutoConfig.maxSpreadCents)) {
                return { did: false, reason: 'hedge_spread_too_wide', remainingSec, profitCents, bufferCents, entryPrice, p2Max, bestAsk, spreadCents };
            }
            if (bestAsk > p2Max) return { did: false, reason: 'hedge_edge_too_small', remainingSec, profitCents, bufferCents, entryPrice, p2Max, bestAsk, spreadCents };
            const tradableShares = computeTradableShares(best.asks, p2Max, 50);
            const minDepthPct = panicNow ? 0 : Number(this.crypto15mHedgeAutoConfig.minDepthPct);
            const threshold = remainingShares * (Math.max(0, minDepthPct) / 100);
            const okDepth = minDepthPct <= 0 ? (tradableShares > 0) : (tradableShares > 0 && tradableShares + 1e-9 >= Math.min(remainingShares, threshold));
            if (!okDepth) {
                return { did: false, reason: 'hedge_depth_too_thin', remainingSec, profitCents, bufferCents, entryPrice, p2Max, bestAsk, spreadCents, tradableShares, minDepthPct, threshold, remainingShares };
            }
            const sharesToBuy = Math.min(remainingShares, tradableShares);
            const amountUsd = Math.max(0.01, sharesToBuy * bestAsk);
            const limitPrice = Math.min(0.999, p2Max);
            const res = await this.tradingClient.createMarketOrder({ tokenId: hedgeTokenId, side: 'BUY', amount: amountUsd, price: limitPrice, orderType: 'FAK' });
            const orderId = res?.orderId != null ? String(res.orderId) : null;
            const order = orderId ? await waitForOrderFill(orderId) : null;
            const filledSize = order?.filledSize != null ? Number(order.filledSize) : null;
            const nextFilled = typeof filledSize === 'number' && Number.isFinite(filledSize) ? filledSize : 0;
            const updatedFilled = (Number.isFinite(hedgeFilledShares) ? hedgeFilledShares : 0) + nextFilled;
            const done = Number.isFinite(entryShares) && updatedFilled >= entryShares * 0.98;
            return { did: true, res, order, remainingSec, profitCents, bufferCents, entryPrice, p2Max, bestAsk, bestBid: Number.isFinite(bestBid) ? bestBid : null, spreadCents, tradableShares, sharesToBuy, amountUsd, filledSize, updatedFilled, done, panicNow };
        };

        try {
            cleanupLocks();
            this.crypto15mHedgeUpdateTracking(nowMs);

            for (const [symbol, active] of this.crypto15mHedgeActivesBySymbol.entries()) {
                const phase = String(active?.phase || '');
                if (phase !== 'waiting_hedge' && phase !== 'hedging') continue;
                const r: any = await attemptHedge(active).catch((e: any) => ({ did: false, reason: 'hedge_error', error: e?.message || String(e) }));
                const cid = String(active?.conditionId || '').trim();
                this.crypto15mHedgeLastDecision = { at: new Date().toISOString(), type: 'hedge', symbol, conditionId: cid || null, ...r };
                if (cid && r?.did !== true && String(r?.reason || '') !== 'hedge_done') {
                    const key = cid;
                    const reason = String(r?.reason || 'hedge_unknown');
                    const prev = this.crypto15mHedgeAttemptLogState.get(key) || null;
                    const now2 = Date.now();
                    const shouldLog = !prev || prev.reason !== reason || now2 - Number(prev.atMs || 0) >= 10_000;
                    if (shouldLog) {
                        this.crypto15mHedgeAttemptLogState.set(key, { atMs: now2, reason });
                        this.recordCrypto15mHedgeEvent({
                            action: 'crypto15m_hedge_attempt',
                            symbol,
                            conditionId: cid,
                            tokenId: String(active?.hedgeTokenId || ''),
                            outcome: String(active?.hedgeOutcome || ''),
                            remainingSec: r?.remainingSec ?? null,
                            entryPrice: r?.entryPrice ?? active?.entryPrice ?? null,
                            profitCents: r?.profitCents ?? null,
                            bufferCents: r?.bufferCents ?? null,
                            p2Max: r?.p2Max ?? null,
                            bestAsk: r?.bestAsk ?? null,
                            spreadCents: r?.spreadCents ?? null,
                            tradableShares: r?.tradableShares ?? null,
                            minDepthPct: r?.minDepthPct ?? this.crypto15mHedgeAutoConfig.minDepthPct,
                            reason,
                            panicNow: r?.panicNow === true,
                            errorMsg: r?.error ?? null,
                        });
                    }
                }
                if (r?.did === true) {
                    const next = { ...active, phase: r.done ? 'hedged' : 'hedging', hedgeFilledShares: r.updatedFilled, hedgeP2Max: r.p2Max, hedgeLastAsk: r.bestAsk, hedgeLastAttemptAt: new Date().toISOString() };
                    this.crypto15mHedgeActivesBySymbol.set(symbol, next);
                    const cid2 = String(next?.conditionId || '').trim();
                    if (cid2) this.crypto15mHedgeTrackedByCondition.set(cid2, next);
                    this.crypto15mHedgeLastOrderAttempt = { at: new Date().toISOString(), type: 'hedge', symbol, conditionId: cid2, orderId: r?.res?.orderId ?? null, success: r?.res?.success ?? null, errorMsg: r?.res?.errorMsg ?? null, filledSize: r?.filledSize ?? null, p2Max: r?.p2Max ?? null, bestAsk: r?.bestAsk ?? null };
                    this.recordCrypto15mHedgeEvent({
                        action: 'crypto15m_hedge_buy',
                        symbol,
                        conditionId: cid2,
                        tokenId: String(next.hedgeTokenId || ''),
                        outcome: String(next.hedgeOutcome || ''),
                        bestAsk: r?.bestAsk ?? null,
                        p2Max: r?.p2Max ?? null,
                        amountUsd: r?.amountUsd ?? null,
                        sharesTarget: r?.sharesToBuy ?? null,
                        filledSize: r?.filledSize ?? null,
                        orderId: r?.res?.orderId ?? null,
                        success: r?.res?.success ?? null,
                        errorMsg: r?.res?.errorMsg ?? null,
                        phase: next.phase,
                    });
                }
            }

            const r = await this.getCrypto15mCandidates({ minProb: this.crypto15mHedgeAutoConfig.minProb, expiresWithinSec: 900, limit: 40 });
            const staleMs = (r as any)?.staleMs != null ? Number((r as any).staleMs) : null;
            const booksError = (r as any)?.booksError != null ? String((r as any).booksError) : null;
            const marketError = (r as any)?.marketError != null ? String((r as any).marketError) : null;
            if (booksError) { this.crypto15mHedgeLastError = `books_error: ${booksError}`; return; }
            if (marketError) { this.crypto15mHedgeLastError = `market_error: ${marketError}`; return; }
            if (staleMs != null && Number.isFinite(staleMs) && staleMs > 10_000) { this.crypto15mHedgeLastError = `books_stale: ${Math.floor(staleMs)}ms`; return; }
            const candidates = Array.isArray((r as any)?.candidates) ? (r as any).candidates : [];
            const cheapMin = Number(this.crypto15mHedgeAutoConfig.entryCheapMinCents) / 100;
            const cheapMax = Number(this.crypto15mHedgeAutoConfig.entryCheapMaxCents) / 100;
            const remMin = Number(this.crypto15mHedgeAutoConfig.entryRemainingMinSec);
            const remMax = Number(this.crypto15mHedgeAutoConfig.entryRemainingMaxSec);

            for (const symbol of ['BTC', 'ETH', 'SOL', 'XRP']) {
                if (this.crypto15mHedgeActivesBySymbol.has(symbol)) continue;
                const pick = candidates.find((c: any) => {
                    if (String(c?.symbol || '').toUpperCase() !== symbol) return false;
                    if (c?.secondsToExpire == null) return false;
                    const s = Number(c.secondsToExpire);
                    if (!Number.isFinite(s)) return false;
                    if (s < remMin || s > remMax) return false;
                    if (!Array.isArray(c?.prices) || c.prices.length < 2) return false;
                    const p0 = Number(c.prices[0]);
                    const p1 = Number(c.prices[1]);
                    const ok0 = Number.isFinite(p0) && p0 >= cheapMin && p0 <= cheapMax;
                    const ok1 = Number.isFinite(p1) && p1 >= cheapMin && p1 <= cheapMax;
                    if (!ok0 && !ok1) return false;
                    if (c?.booksError || c?.marketsError) return false;
                    return true;
                }) || null;
                if (!pick) continue;
                const cid = String(pick.conditionId || '').trim();
                if (!cid) continue;
                if (this.crypto15mHedgeTrackedByCondition.has(cid)) continue;
                const tokenIds = Array.isArray(pick.tokenIds) ? pick.tokenIds : [];
                const outcomes = Array.isArray(pick.outcomes) ? pick.outcomes : [];
                if (tokenIds.length < 2 || outcomes.length < 2) continue;
                const p0 = Number(pick.prices[0]);
                const p1 = Number(pick.prices[1]);
                const idxEntry =
                    Number.isFinite(p0) && p0 >= cheapMin && p0 <= cheapMax && !(Number.isFinite(p1) && p1 >= cheapMin && p1 <= cheapMax) ? 0
                    : Number.isFinite(p1) && p1 >= cheapMin && p1 <= cheapMax && !(Number.isFinite(p0) && p0 >= cheapMin && p0 <= cheapMax) ? 1
                    : (Number.isFinite(p0) && Number.isFinite(p1) && p0 <= p1 ? 0 : 1);
                const idxHedge = idxEntry === 0 ? 1 : 0;
                const entryTokenId = String(tokenIds[idxEntry] || '').trim();
                const hedgeTokenId = String(tokenIds[idxHedge] || '').trim();
                if (!entryTokenId || !hedgeTokenId) continue;
                const expiresAtMs = Number(pick.endMs) || (Date.now() + Number(pick.secondsToExpire || 0) * 1000);
                const orderLockKey = `${symbol}:${expiresAtMs}`;
                const locked = this.crypto15mHedgeOrderLocks.get(orderLockKey);
                if (locked && locked.status === 'placing') continue;
                this.crypto15mHedgeOrderLocks.set(orderLockKey, { atMs: Date.now(), symbol, expiresAtMs, conditionId: cid, status: 'placing' });
                const entryBooks = await this.fetchClobBooks([entryTokenId]);
                const entryBook = entryBooks && entryBooks.length ? entryBooks[0] : null;
                const best = computeBest(entryBook);
                const bestAsk = best.bestAsk != null ? Number(best.bestAsk) : NaN;
                const bestBid = best.bestBid != null ? Number(best.bestBid) : NaN;
                const spreadCents = best.spreadCents != null ? Number(best.spreadCents) : null;
                if (!Number.isFinite(bestAsk) || bestAsk <= 0) {
                    this.crypto15mHedgeOrderLocks.set(orderLockKey, { atMs: Date.now(), symbol, expiresAtMs, conditionId: cid, status: 'failed' });
                    continue;
                }
                const amountUsd = Number(this.crypto15mHedgeAutoConfig.amountUsd) || 1;
                const limitPrice = Math.min(0.999, bestAsk + 0.02);
                const estEntryShares = amountUsd > 0 && bestAsk > 0 ? (amountUsd / bestAsk) : null;
                const tradableShares = computeTradableShares(best.asks, limitPrice, 50);
                if (estEntryShares != null && Number.isFinite(estEntryShares) && tradableShares + 1e-9 < estEntryShares) {
                    this.crypto15mHedgeLastDecision = { at: new Date().toISOString(), type: 'entry', symbol, conditionId: cid, reason: 'entry_depth_too_thin', bestAsk, bestBid: Number.isFinite(bestBid) ? bestBid : null, spreadCents, limitPrice, estEntryShares, tradableShares };
                    this.crypto15mHedgeOrderLocks.set(orderLockKey, { atMs: Date.now(), symbol, expiresAtMs, conditionId: cid, status: 'failed' });
                    this.recordCrypto15mHedgeEvent({
                        action: 'crypto15m_hedge_skip',
                        symbol,
                        conditionId: cid,
                        reason: 'entry_depth_too_thin',
                        bestAsk,
                        bestBid: Number.isFinite(bestBid) ? bestBid : null,
                        spreadCents,
                        maxSpreadCents: this.crypto15mHedgeAutoConfig.maxSpreadCents,
                        limitPrice,
                        estEntryShares,
                        tradableShares,
                    });
                    continue;
                }
                const res = await this.tradingClient.createMarketOrder({ tokenId: entryTokenId, side: 'BUY', amount: amountUsd, price: limitPrice, orderType: 'FAK' });
                const orderId = res?.orderId != null ? String(res.orderId) : null;
                const order = orderId ? await waitForOrderFill(orderId) : null;
                const filledSize = order?.filledSize != null ? Number(order.filledSize) : null;
                const filled = typeof filledSize === 'number' && Number.isFinite(filledSize) && filledSize > 0 ? filledSize : null;
                const entryFilledShares = filled != null ? filled : (amountUsd / bestAsk);
                const entryOutcome = String(outcomes[idxEntry] || '');
                const hedgeOutcome = String(outcomes[idxHedge] || '');
                const active = {
                    startedAt: new Date().toISOString(),
                    phase: res?.success === true ? 'waiting_hedge' : 'failed',
                    symbol,
                    conditionId: cid,
                    slug: pick.slug ?? null,
                    title: pick.title ?? null,
                    endDate: pick.endDate ?? null,
                    expiresAtMs,
                    secondsToExpire: pick.secondsToExpire ?? null,
                    entryIndex: idxEntry,
                    hedgeIndex: idxHedge,
                    entryTokenId,
                    hedgeTokenId,
                    entryOutcome,
                    hedgeOutcome,
                    entryPrice: bestAsk,
                    entryLimitPrice: limitPrice,
                    entryAmountUsd: amountUsd,
                    entryOrderId: orderId,
                    entryOrder: res,
                    entryFilledShares,
                    hedgeFilledShares: 0,
                };
                this.crypto15mHedgeActivesBySymbol.set(symbol, active);
                this.crypto15mHedgeTrackedByCondition.set(cid, active);
                this.crypto15mHedgeOrderLocks.set(orderLockKey, { atMs: Date.now(), symbol, expiresAtMs, conditionId: cid, status: res?.success === true ? 'ordered' : 'failed' });
                this.crypto15mHedgeLastOrderAttempt = { at: new Date().toISOString(), type: 'entry', symbol, conditionId: cid, orderId, success: res?.success ?? null, errorMsg: res?.errorMsg ?? null, entryPrice: bestAsk, limitPrice, entryFilledShares };
                this.recordCrypto15mHedgeEvent({
                    action: 'crypto15m_hedge_entry',
                    symbol,
                    conditionId: cid,
                    slug: pick.slug ?? null,
                    tokenId: entryTokenId,
                    outcome: entryOutcome,
                    bestAsk,
                    bestBid: Number.isFinite(bestBid) ? bestBid : null,
                    spreadCents,
                    limitPrice,
                    amountUsd,
                    orderId,
                    success: res?.success ?? null,
                    errorMsg: res?.errorMsg ?? null,
                    filledSize,
                    entryFilledShares,
                    secondsToExpire: pick.secondsToExpire ?? null,
                    phase: active.phase,
                });
            }
        } catch (e: any) {
            this.crypto15mHedgeLastError = e?.message || String(e);
        } finally {
            this.crypto15mHedgeAutoInFlight = false;
        }
    }

    startCrypto15mAuto(config?: { enabled?: boolean; dryRun?: boolean; amountUsd?: number; minProb?: number; expiresWithinSec?: number; pollMs?: number; buySizingMode?: 'fixed' | 'orderbook_max' | 'all_capital' | string; sweepEnabled?: boolean; sweepWindowSec?: number; sweepMaxOrdersPerMarket?: number; sweepMaxTotalUsdPerMarket?: number; sweepMinIntervalMs?: number; trendEnabled?: boolean; trendMinutes?: number; staleMsThreshold?: number; stoplossEnabled?: boolean; stoplossCut1DropCents?: number; stoplossCut1SellPct?: number; stoplossCut2DropCents?: number; stoplossCut2SellPct?: number; stoplossMinSecToExit?: number; adaptiveDeltaEnabled?: boolean; adaptiveDeltaBigMoveMultiplier?: number; adaptiveDeltaRevertNoBuyCount?: number }) {
        const enabled = config?.enabled != null ? !!config.enabled : true;
        const dryRun = config?.dryRun != null ? (config.dryRun === true) : this.crypto15mAutoDryRun;
        const amountUsd = config?.amountUsd != null ? Number(config.amountUsd) : this.crypto15mAutoConfig.amountUsd;
        const minProb = config?.minProb != null ? Number(config.minProb) : this.crypto15mAutoConfig.minProb;
        const expiresWithinSec = config?.expiresWithinSec != null ? Number(config.expiresWithinSec) : this.crypto15mAutoConfig.expiresWithinSec;
        const pollMs = config?.pollMs != null ? Number(config.pollMs) : this.crypto15mAutoConfig.pollMs;
        const buySizingModeRaw = config?.buySizingMode != null ? String(config.buySizingMode) : this.crypto15mAutoConfig.buySizingMode;
        const sweepEnabled = config?.sweepEnabled != null ? !!config.sweepEnabled : this.crypto15mAutoConfig.sweepEnabled;
        const sweepWindowSecRaw = config?.sweepWindowSec != null ? Number(config.sweepWindowSec) : this.crypto15mAutoConfig.sweepWindowSec;
        const sweepMaxOrdersPerMarketRaw = config?.sweepMaxOrdersPerMarket != null ? Number(config.sweepMaxOrdersPerMarket) : this.crypto15mAutoConfig.sweepMaxOrdersPerMarket;
        const sweepMaxTotalUsdPerMarketRaw = config?.sweepMaxTotalUsdPerMarket != null ? Number(config.sweepMaxTotalUsdPerMarket) : this.crypto15mAutoConfig.sweepMaxTotalUsdPerMarket;
        const sweepMinIntervalMsRaw = config?.sweepMinIntervalMs != null ? Number(config.sweepMinIntervalMs) : this.crypto15mAutoConfig.sweepMinIntervalMs;
        const trendEnabled = config?.trendEnabled != null ? !!config.trendEnabled : this.crypto15mAutoConfig.trendEnabled;
        const trendMinutesRaw = config?.trendMinutes != null ? Number(config.trendMinutes) : this.crypto15mAutoConfig.trendMinutes;
        const staleMsThreshold = config?.staleMsThreshold != null ? Number(config.staleMsThreshold) : this.crypto15mAutoConfig.staleMsThreshold;
        const stoplossEnabled = config?.stoplossEnabled != null ? !!config.stoplossEnabled : this.crypto15mAutoConfig.stoplossEnabled;
        const stoplossCut1DropCentsRaw = config?.stoplossCut1DropCents != null ? Number(config.stoplossCut1DropCents) : this.crypto15mAutoConfig.stoplossCut1DropCents;
        const stoplossCut1SellPctRaw = config?.stoplossCut1SellPct != null ? Number(config.stoplossCut1SellPct) : this.crypto15mAutoConfig.stoplossCut1SellPct;
        const stoplossCut2DropCentsRaw = config?.stoplossCut2DropCents != null ? Number(config.stoplossCut2DropCents) : this.crypto15mAutoConfig.stoplossCut2DropCents;
        const stoplossCut2SellPctRaw = config?.stoplossCut2SellPct != null ? Number(config.stoplossCut2SellPct) : this.crypto15mAutoConfig.stoplossCut2SellPct;
        const stoplossMinSecToExitRaw = config?.stoplossMinSecToExit != null ? Number(config.stoplossMinSecToExit) : this.crypto15mAutoConfig.stoplossMinSecToExit;
        const adaptiveDeltaEnabled = config?.adaptiveDeltaEnabled != null ? !!config.adaptiveDeltaEnabled : this.crypto15mAutoConfig.adaptiveDeltaEnabled;
        const adaptiveDeltaBigMoveMultiplierRaw = config?.adaptiveDeltaBigMoveMultiplier != null ? Number(config.adaptiveDeltaBigMoveMultiplier) : this.crypto15mAutoConfig.adaptiveDeltaBigMoveMultiplier;
        const adaptiveDeltaRevertNoBuyCountRaw = config?.adaptiveDeltaRevertNoBuyCount != null ? Number(config.adaptiveDeltaRevertNoBuyCount) : this.crypto15mAutoConfig.adaptiveDeltaRevertNoBuyCount;

        this.crypto15mAutoConfig = {
            pollMs: Math.max(500, Math.floor(pollMs)),
            expiresWithinSec: Math.max(5, Math.floor(expiresWithinSec)),
            minProb: Math.max(0, Math.min(1, minProb)),
            amountUsd: Math.max(1, Number.isFinite(amountUsd) ? amountUsd : 1),
            buySizingMode: buySizingModeRaw === 'orderbook_max' ? 'orderbook_max' : buySizingModeRaw === 'all_capital' ? 'all_capital' : 'fixed',
            sweepEnabled,
            sweepWindowSec: Math.max(0, Math.min(900, Math.floor(Number.isFinite(sweepWindowSecRaw) ? sweepWindowSecRaw : 30))),
            sweepMaxOrdersPerMarket: Math.max(1, Math.min(200, Math.floor(Number.isFinite(sweepMaxOrdersPerMarketRaw) ? sweepMaxOrdersPerMarketRaw : 10))),
            sweepMaxTotalUsdPerMarket: Math.max(1, Math.min(50_000, Number.isFinite(sweepMaxTotalUsdPerMarketRaw) ? sweepMaxTotalUsdPerMarketRaw : 600)),
            sweepMinIntervalMs: Math.max(50, Math.min(30_000, Math.floor(Number.isFinite(sweepMinIntervalMsRaw) ? sweepMinIntervalMsRaw : 400))),
            trendEnabled,
            trendMinutes: Math.max(1, Math.min(10, Math.floor(Number.isFinite(trendMinutesRaw) ? trendMinutesRaw : 1))),
            staleMsThreshold: Math.max(500, Math.floor(staleMsThreshold)),
            stoplossEnabled,
            stoplossCut1DropCents: Math.max(0, Math.min(50, Math.floor(Number.isFinite(stoplossCut1DropCentsRaw) ? stoplossCut1DropCentsRaw : 1))),
            stoplossCut1SellPct: Math.max(0, Math.min(100, Math.floor(Number.isFinite(stoplossCut1SellPctRaw) ? stoplossCut1SellPctRaw : 50))),
            stoplossCut2DropCents: Math.max(0, Math.min(50, Math.floor(Number.isFinite(stoplossCut2DropCentsRaw) ? stoplossCut2DropCentsRaw : 2))),
            stoplossCut2SellPct: Math.max(0, Math.min(100, Math.floor(Number.isFinite(stoplossCut2SellPctRaw) ? stoplossCut2SellPctRaw : 100))),
            stoplossMinSecToExit: Math.max(0, Math.min(600, Math.floor(Number.isFinite(stoplossMinSecToExitRaw) ? stoplossMinSecToExitRaw : 25))),
            adaptiveDeltaEnabled,
            adaptiveDeltaBigMoveMultiplier: Math.max(1, Math.min(10, Number.isFinite(adaptiveDeltaBigMoveMultiplierRaw) ? adaptiveDeltaBigMoveMultiplierRaw : 2)),
            adaptiveDeltaRevertNoBuyCount: Math.max(1, Math.min(50, Math.floor(Number.isFinite(adaptiveDeltaRevertNoBuyCountRaw) ? adaptiveDeltaRevertNoBuyCountRaw : 4))),
        };
        this.persistCrypto15mAutoConfigToFile();

        this.crypto15mAutoEnabled = enabled;
        this.crypto15mAutoDryRun = dryRun;
        this.crypto15mLastError = null;

        if (this.crypto15mAutoTimer) {
            clearInterval(this.crypto15mAutoTimer);
            this.crypto15mAutoTimer = null;
        }

        if (this.crypto15mAutoEnabled) {
            const tick = () => {
                this.crypto15mTryAutoOnce().catch(() => {});
            };
            tick();
            this.crypto15mAutoTimer = setInterval(tick, this.crypto15mAutoConfig.pollMs);
            if (!this.autoRedeemConfig.enabled) {
                this.setAutoRedeemConfig({ enabled: true, persist: true });
            }
        }

        this.recordAutoConfigEvent('crypto15m', enabled ? 'start' : 'stop', { enabled, dryRun: this.crypto15mAutoDryRun === true, ...this.crypto15mAutoConfig });
        return this.getCrypto15mStatus();
    }

    stopCrypto15mAuto() {
        this.crypto15mAutoEnabled = false;
        this.recordAutoConfigEvent('crypto15m', 'stop', { enabled: false, ...this.crypto15mAutoConfig });
        if (this.crypto15mAutoTimer) {
            clearInterval(this.crypto15mAutoTimer);
            this.crypto15mAutoTimer = null;
        }
        return this.getCrypto15mStatus();
    }

    async runCrypto15mAutoOnce(options?: { dryRun?: boolean; minProb?: number; expiresWithinSec?: number; amountUsd?: number }) {
        const prevEnabled = this.crypto15mAutoEnabled;
        const prevDryRun = this.crypto15mAutoDryRun;
        const prevConfig = { ...this.crypto15mAutoConfig };
        try {
            this.crypto15mAutoEnabled = true;
            if (options?.dryRun != null) this.crypto15mAutoDryRun = options.dryRun === true;
            if (options?.minProb != null || options?.expiresWithinSec != null || options?.amountUsd != null) {
                const minProbRaw = options?.minProb != null ? Number(options.minProb) : prevConfig.minProb;
                const expiresWithinSecRaw = options?.expiresWithinSec != null ? Number(options.expiresWithinSec) : prevConfig.expiresWithinSec;
                const amountUsdRaw = options?.amountUsd != null ? Number(options.amountUsd) : prevConfig.amountUsd;
                this.crypto15mAutoConfig = {
                    ...prevConfig,
                    minProb: Math.max(0, Math.min(1, Number.isFinite(minProbRaw) ? minProbRaw : prevConfig.minProb)),
                    expiresWithinSec: Math.max(5, Math.floor(Number.isFinite(expiresWithinSecRaw) ? expiresWithinSecRaw : prevConfig.expiresWithinSec)),
                    amountUsd: Math.max(1, Number.isFinite(amountUsdRaw) ? amountUsdRaw : prevConfig.amountUsd),
                };
            }
            await this.crypto15mTryAutoOnce();
            return { success: true, status: this.getCrypto15mStatus() };
        } catch (e: any) {
            return { success: false, error: e?.message || String(e), status: this.getCrypto15mStatus() };
        } finally {
            this.crypto15mAutoEnabled = prevEnabled;
            this.crypto15mAutoDryRun = prevDryRun;
            this.crypto15mAutoConfig = prevConfig;
        }
    }

    updateCrypto15mConfig(config?: { amountUsd?: number; minProb?: number; expiresWithinSec?: number; pollMs?: number; buySizingMode?: 'fixed' | 'orderbook_max' | 'all_capital' | string; sweepEnabled?: boolean; sweepWindowSec?: number; sweepMaxOrdersPerMarket?: number; sweepMaxTotalUsdPerMarket?: number; sweepMinIntervalMs?: number; trendEnabled?: boolean; trendMinutes?: number; staleMsThreshold?: number; stoplossEnabled?: boolean; stoplossCut1DropCents?: number; stoplossCut1SellPct?: number; stoplossCut2DropCents?: number; stoplossCut2SellPct?: number; stoplossMinSecToExit?: number; adaptiveDeltaEnabled?: boolean; adaptiveDeltaBigMoveMultiplier?: number; adaptiveDeltaRevertNoBuyCount?: number }) {
        const amountUsd = config?.amountUsd != null ? Number(config.amountUsd) : this.crypto15mAutoConfig.amountUsd;
        const minProb = config?.minProb != null ? Number(config.minProb) : this.crypto15mAutoConfig.minProb;
        const expiresWithinSec = config?.expiresWithinSec != null ? Number(config.expiresWithinSec) : this.crypto15mAutoConfig.expiresWithinSec;
        const pollMs = config?.pollMs != null ? Number(config.pollMs) : this.crypto15mAutoConfig.pollMs;
        const buySizingModeRaw = (config as any)?.buySizingMode != null ? String((config as any).buySizingMode) : this.crypto15mAutoConfig.buySizingMode;
        const sweepEnabled = (config as any)?.sweepEnabled != null ? !!(config as any).sweepEnabled : this.crypto15mAutoConfig.sweepEnabled;
        const sweepWindowSecRaw = (config as any)?.sweepWindowSec != null ? Number((config as any).sweepWindowSec) : this.crypto15mAutoConfig.sweepWindowSec;
        const sweepMaxOrdersPerMarketRaw = (config as any)?.sweepMaxOrdersPerMarket != null ? Number((config as any).sweepMaxOrdersPerMarket) : this.crypto15mAutoConfig.sweepMaxOrdersPerMarket;
        const sweepMaxTotalUsdPerMarketRaw = (config as any)?.sweepMaxTotalUsdPerMarket != null ? Number((config as any).sweepMaxTotalUsdPerMarket) : this.crypto15mAutoConfig.sweepMaxTotalUsdPerMarket;
        const sweepMinIntervalMsRaw = (config as any)?.sweepMinIntervalMs != null ? Number((config as any).sweepMinIntervalMs) : this.crypto15mAutoConfig.sweepMinIntervalMs;
        const trendEnabled = config?.trendEnabled != null ? !!config.trendEnabled : this.crypto15mAutoConfig.trendEnabled;
        const trendMinutesRaw = config?.trendMinutes != null ? Number(config.trendMinutes) : this.crypto15mAutoConfig.trendMinutes;
        const staleMsThreshold = config?.staleMsThreshold != null ? Number(config.staleMsThreshold) : this.crypto15mAutoConfig.staleMsThreshold;
        const stoplossEnabled = config?.stoplossEnabled != null ? !!config.stoplossEnabled : this.crypto15mAutoConfig.stoplossEnabled;
        const stoplossCut1DropCentsRaw = config?.stoplossCut1DropCents != null ? Number(config.stoplossCut1DropCents) : this.crypto15mAutoConfig.stoplossCut1DropCents;
        const stoplossCut1SellPctRaw = config?.stoplossCut1SellPct != null ? Number(config.stoplossCut1SellPct) : this.crypto15mAutoConfig.stoplossCut1SellPct;
        const stoplossCut2DropCentsRaw = config?.stoplossCut2DropCents != null ? Number(config.stoplossCut2DropCents) : this.crypto15mAutoConfig.stoplossCut2DropCents;
        const stoplossCut2SellPctRaw = config?.stoplossCut2SellPct != null ? Number(config.stoplossCut2SellPct) : this.crypto15mAutoConfig.stoplossCut2SellPct;
        const stoplossMinSecToExitRaw = config?.stoplossMinSecToExit != null ? Number(config.stoplossMinSecToExit) : this.crypto15mAutoConfig.stoplossMinSecToExit;
        const adaptiveDeltaEnabled = config?.adaptiveDeltaEnabled != null ? !!config.adaptiveDeltaEnabled : this.crypto15mAutoConfig.adaptiveDeltaEnabled;
        const adaptiveDeltaBigMoveMultiplierRaw = config?.adaptiveDeltaBigMoveMultiplier != null ? Number(config.adaptiveDeltaBigMoveMultiplier) : this.crypto15mAutoConfig.adaptiveDeltaBigMoveMultiplier;
        const adaptiveDeltaRevertNoBuyCountRaw = config?.adaptiveDeltaRevertNoBuyCount != null ? Number(config.adaptiveDeltaRevertNoBuyCount) : this.crypto15mAutoConfig.adaptiveDeltaRevertNoBuyCount;

        this.crypto15mAutoConfig = {
            pollMs: Math.max(500, Math.floor(pollMs)),
            expiresWithinSec: Math.max(5, Math.floor(expiresWithinSec)),
            minProb: Math.max(0, Math.min(1, minProb)),
            amountUsd: Math.max(1, Number.isFinite(amountUsd) ? amountUsd : 1),
            buySizingMode: buySizingModeRaw === 'orderbook_max' ? 'orderbook_max' : buySizingModeRaw === 'all_capital' ? 'all_capital' : 'fixed',
            sweepEnabled,
            sweepWindowSec: Math.max(0, Math.min(900, Math.floor(Number.isFinite(sweepWindowSecRaw) ? sweepWindowSecRaw : 30))),
            sweepMaxOrdersPerMarket: Math.max(1, Math.min(200, Math.floor(Number.isFinite(sweepMaxOrdersPerMarketRaw) ? sweepMaxOrdersPerMarketRaw : 10))),
            sweepMaxTotalUsdPerMarket: Math.max(1, Math.min(50_000, Number.isFinite(sweepMaxTotalUsdPerMarketRaw) ? sweepMaxTotalUsdPerMarketRaw : 600)),
            sweepMinIntervalMs: Math.max(50, Math.min(30_000, Math.floor(Number.isFinite(sweepMinIntervalMsRaw) ? sweepMinIntervalMsRaw : 400))),
            trendEnabled,
            trendMinutes: Math.max(1, Math.min(10, Math.floor(Number.isFinite(trendMinutesRaw) ? trendMinutesRaw : 1))),
            staleMsThreshold: Math.max(500, Math.floor(staleMsThreshold)),
            stoplossEnabled,
            stoplossCut1DropCents: Math.max(0, Math.min(50, Math.floor(Number.isFinite(stoplossCut1DropCentsRaw) ? stoplossCut1DropCentsRaw : 1))),
            stoplossCut1SellPct: Math.max(0, Math.min(100, Math.floor(Number.isFinite(stoplossCut1SellPctRaw) ? stoplossCut1SellPctRaw : 50))),
            stoplossCut2DropCents: Math.max(0, Math.min(50, Math.floor(Number.isFinite(stoplossCut2DropCentsRaw) ? stoplossCut2DropCentsRaw : 2))),
            stoplossCut2SellPct: Math.max(0, Math.min(100, Math.floor(Number.isFinite(stoplossCut2SellPctRaw) ? stoplossCut2SellPctRaw : 100))),
            stoplossMinSecToExit: Math.max(0, Math.min(600, Math.floor(Number.isFinite(stoplossMinSecToExitRaw) ? stoplossMinSecToExitRaw : 25))),
            adaptiveDeltaEnabled,
            adaptiveDeltaBigMoveMultiplier: Math.max(1, Math.min(10, Number.isFinite(adaptiveDeltaBigMoveMultiplierRaw) ? adaptiveDeltaBigMoveMultiplierRaw : 2)),
            adaptiveDeltaRevertNoBuyCount: Math.max(1, Math.min(50, Math.floor(Number.isFinite(adaptiveDeltaRevertNoBuyCountRaw) ? adaptiveDeltaRevertNoBuyCountRaw : 4))),
        };
        this.persistCrypto15mAutoConfigToFile();
        this.recordConfigUpdateEvent('crypto15m', { kind: 'settings', enabled: this.crypto15mAutoEnabled === true, ...this.crypto15mAutoConfig });
        return this.getCrypto15mStatus();
    }

    getCrypto15mWatchdogStatus() {
        const w = this.crypto15mWatchdog;
        const now = Date.now();
        const hasEnd = w.endsAtMs != null && Number.isFinite(Number(w.endsAtMs)) && Number(w.endsAtMs) > 0;
        const remainingMs = w.running && hasEnd ? Math.max(0, Number(w.endsAtMs) - now) : null;
        return {
            running: w.running,
            pollMs: w.pollMs,
            startedAt: w.startedAtMs ? new Date(w.startedAtMs).toISOString() : null,
            endsAt: hasEnd ? new Date(Number(w.endsAtMs)).toISOString() : null,
            remainingMs: w.running ? remainingMs : null,
            lastTickAt: w.lastTickAtMs ? new Date(w.lastTickAtMs).toISOString() : null,
            lastError: w.lastError,
            stopReason: w.stopReason,
            thresholds: w.thresholds,
            counters: w.counters,
            issuesCount: w.issues.length,
            lastIssue: w.issues.length ? w.issues[w.issues.length - 1] : null,
            reportPaths: w.reportPaths,
        };
    }

    startCrypto15mWatchdog(options?: { durationHours?: number; pollMs?: number; staleMsThreshold?: number }) {
        const pollMs = options?.pollMs != null ? Number(options.pollMs) : 30_000;
        const staleMsThreshold = options?.staleMsThreshold != null ? Number(options.staleMsThreshold) : this.crypto15mWatchdog.thresholds.staleMsThreshold;
        const now = Date.now();
        this.crypto15mWatchdog.running = true;
        this.crypto15mWatchdog.pollMs = Math.max(5_000, Math.floor(pollMs));
        this.crypto15mWatchdog.startedAtMs = now;
        this.crypto15mWatchdog.endsAtMs = 0;
        this.crypto15mWatchdog.lastTickAtMs = 0;
        this.crypto15mWatchdog.lastError = null;
        this.crypto15mWatchdog.stopReason = null;
        this.crypto15mWatchdog.thresholds.staleMsThreshold = Math.max(1_000, staleMsThreshold);
        this.crypto15mWatchdog.counters = { consecutiveStale: 0, consecutiveDataError: 0, redeemFailed: 0, orderFailed: 0 };
        this.crypto15mWatchdog.issues = [];
        this.crypto15mWatchdog.reportPaths = {};
        if (this.crypto15mWatchdogTimer) {
            clearInterval(this.crypto15mWatchdogTimer);
            this.crypto15mWatchdogTimer = null;
        }
        const tick = () => {
            this.crypto15mWatchdogTick().catch((e: any) => {
                this.crypto15mWatchdog.lastError = e?.message || String(e);
            });
        };
        tick();
        this.crypto15mWatchdogTimer = setInterval(tick, this.crypto15mWatchdog.pollMs);
        return this.getCrypto15mWatchdogStatus();
    }

    stopCrypto15mWatchdog(options?: { reason?: string; stopAuto?: boolean }) {
        const reason = options?.reason != null ? String(options.reason) : 'manual_stop';
        const stopAuto = options?.stopAuto !== false;
        if (this.crypto15mWatchdogTimer) {
            clearInterval(this.crypto15mWatchdogTimer);
            this.crypto15mWatchdogTimer = null;
        }
        if (stopAuto) {
            try {
                this.stopCrypto15mAuto();
            } catch {
            }
        }
        this.crypto15mWatchdog.running = false;
        this.crypto15mWatchdog.stopReason = reason;
        this.crypto15mWatchdog.lastTickAtMs = Date.now();
        this.crypto15mWriteWatchdogReport(reason);
        return this.getCrypto15mWatchdogStatus();
    }

    getCrypto15mWatchdogReportLatest() {
        const jsonPath = this.crypto15mWatchdog.reportPaths.json;
        const mdPath = this.crypto15mWatchdog.reportPaths.md;
        let json: any = null;
        let md: string | null = null;
        try {
            if (jsonPath && fs.existsSync(jsonPath)) json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        } catch {
        }
        try {
            if (mdPath && fs.existsSync(mdPath)) md = String(fs.readFileSync(mdPath, 'utf8'));
        } catch {
        }
        return { success: true, jsonPath: jsonPath || null, mdPath: mdPath || null, json, md };
    }

    private async crypto15mWatchdogTick() {
        const w = this.crypto15mWatchdog;
        if (!w.running) return;
        const now = Date.now();
        w.lastTickAtMs = now;

        let staleMs: number | null = null;
        let booksError: string | null = null;
        let marketError: string | null = null;
        try {
            const r: any = await this.getCrypto15mCandidates({ minProb: this.crypto15mAutoConfig.minProb, expiresWithinSec: this.crypto15mAutoConfig.expiresWithinSec, limit: 1 });
            staleMs = r?.staleMs != null ? Number(r.staleMs) : null;
            booksError = r?.booksError != null ? String(r.booksError) : null;
            marketError = r?.marketError != null ? String(r.marketError) : null;
        } catch (e: any) {
            booksError = e?.message || String(e);
        }

        if (booksError || marketError) w.counters.consecutiveDataError += 1;
        else w.counters.consecutiveDataError = 0;

        if (staleMs != null && Number.isFinite(staleMs) && staleMs > w.thresholds.staleMsThreshold) w.counters.consecutiveStale += 1;
        else w.counters.consecutiveStale = 0;

        if (w.counters.consecutiveDataError >= w.thresholds.consecutiveDataStops) {
            if (w.counters.consecutiveDataError === w.thresholds.consecutiveDataStops) {
                w.issues.push({ at: new Date().toISOString(), type: 'data_error', message: `booksError=${booksError || '-'} marketError=${marketError || '-'}` });
            }
        }
        if (w.counters.consecutiveStale >= w.thresholds.consecutiveStaleStops) {
            if (w.counters.consecutiveStale === w.thresholds.consecutiveStaleStops) {
                w.issues.push({ at: new Date().toISOString(), type: 'books_stale', message: `staleMs=${Math.floor(Number(staleMs))} threshold=${w.thresholds.staleMsThreshold}` });
            }
        }

        await this.refreshHistoryStatuses({ maxEntries: 50, minIntervalMs: 1000 }).catch(() => null);
        const h: any = await this.getCrypto15mHistory({ refresh: false, maxEntries: 50 }).catch(() => null);
        const items = Array.isArray(h?.history) ? h.history : [];

        const anyRedeemFailed = items.find((it: any) => String(it?.redeemStatus || '') === 'failed' || String(it?.state || '') === 'redeem_failed') || null;
        if (anyRedeemFailed) {
            w.counters.redeemFailed += 1;
            if (w.counters.redeemFailed === w.thresholds.redeemFailedStops) {
                w.issues.push({ at: new Date().toISOString(), type: 'redeem_failed', message: `${anyRedeemFailed.slug || anyRedeemFailed.conditionId || ''}`, meta: { conditionId: anyRedeemFailed.conditionId, txHash: anyRedeemFailed.txHash || null } });
            }
        } else {
            w.counters.redeemFailed = 0;
        }

        const anyOrderFailed = items.find((it: any) => {
            const st = String(it?.orderStatus || '');
            return st === 'FAILED' || st === 'REJECTED';
        }) || null;
        if (anyOrderFailed) {
            w.counters.orderFailed += 1;
            if (w.counters.orderFailed === w.thresholds.orderFailedStops) {
                w.issues.push({ at: new Date().toISOString(), type: 'order_failed', message: `${anyOrderFailed.slug || anyOrderFailed.conditionId || ''}`, meta: { conditionId: anyOrderFailed.conditionId, orderId: anyOrderFailed.orderId || null, orderStatus: anyOrderFailed.orderStatus } });
            }
        } else {
            w.counters.orderFailed = 0;
        }

        const recentOrders = items
            .filter((it: any) => String(it?.action || '') === 'crypto15m_order' && (it?.marketId || it?.conditionId || it?.slug))
            .filter((it: any) => {
                const ts = Date.parse(String(it?.timestamp || it?.time || ''));
                return Number.isFinite(ts) ? (now - ts) <= 10 * 60_000 : true;
            });
        const dupCounts = new Map<string, number>();
        for (const it of recentOrders) {
            const key = String(it?.slug || it?.marketId || it?.conditionId || '').trim();
            if (!key) continue;
            dupCounts.set(key, (dupCounts.get(key) || 0) + 1);
        }
        const dup = Array.from(dupCounts.entries()).find(([, c]) => c >= 2) || null;
        if (dup) {
            const [key, count] = dup;
            w.issues.push({ at: new Date().toISOString(), type: 'duplicate_order', message: `${key} count=${count} (10m)`, meta: { key, count } });
        }

        for (const [cid, inflight] of this.redeemInFlight.entries()) {
            if (!inflight || inflight.status !== 'submitted') continue;
            const subAt = Date.parse(String(inflight.submittedAt || ''));
            if (!Number.isFinite(subAt)) continue;
            if (now - subAt <= w.thresholds.redeemSubmittedTimeoutMs) continue;
            w.issues.push({ at: new Date().toISOString(), type: 'redeem_timeout', message: `conditionId=${cid}`, meta: { submittedAt: inflight.submittedAt, transactionId: inflight.transactionId || null } });
        }

        if (w.issues.length > 2000) w.issues = w.issues.slice(-2000);
    }

    private crypto15mWriteWatchdogReport(stopReason: string) {
        const w = this.crypto15mWatchdog;
        const baseDir = this.orderHistoryPath ? path.dirname(this.orderHistoryPath) : path.join(os.tmpdir(), 'polymarket-tools');
        const dir = path.join(baseDir, 'crypto15m-watchdog');
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const jsonPath = path.join(dir, `crypto15m_watchdog_report_${stamp}.json`);
        const mdPath = path.join(dir, `crypto15m_watchdog_report_${stamp}.md`);
        const status = this.getCrypto15mStatus();
        const watchdogStatus = this.getCrypto15mWatchdogStatus();
        const autoRedeemStatus = this.getAutoRedeemStatus();
        const report = {
            generatedAt: new Date().toISOString(),
            stopReason: stopReason,
            watchdog: watchdogStatus,
            crypto15mStatus: status,
            autoRedeemStatus,
            issues: w.issues.slice(-200),
        };
        const md = [
            `# Crypto15m Watchdog Report`,
            ``,
            `- generatedAt: ${report.generatedAt}`,
            `- stopReason: ${stopReason}`,
            `- watchdog: ${watchdogStatus.running ? 'RUNNING' : 'STOPPED'}`,
            `- startedAt: ${watchdogStatus.startedAt || '-'}`,
            `- endsAt: ${watchdogStatus.endsAt || '-'}`,
            `- lastTickAt: ${watchdogStatus.lastTickAt || '-'}`,
            `- lastError: ${watchdogStatus.lastError || '-'}`,
            `- issuesCount: ${watchdogStatus.issuesCount}`,
            ``,
            `## Last Issue`,
            ``,
            '```json',
            JSON.stringify(watchdogStatus.lastIssue || null, null, 2),
            '```',
            ``,
            `## Auto Redeem`,
            ``,
            '```json',
            JSON.stringify(autoRedeemStatus, null, 2),
            '```',
        ].join('\n');
        fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), { encoding: 'utf8', mode: 0o600 });
        fs.writeFileSync(mdPath, md, { encoding: 'utf8', mode: 0o600 });
        w.reportPaths = { json: jsonPath, md: mdPath };
    }

    resetCrypto15mActive() {
        this.crypto15mActivesBySymbol.clear();
        this.crypto15mTrackedByCondition.clear();
        this.crypto15mCooldownUntilBySymbol.clear();
        return this.getCrypto15mStatus();
    }

    async placeCrypto15mOrder(params: { conditionId: string; outcomeIndex?: number; amountUsd?: number; minPrice?: number; force?: boolean; source?: 'auto' | 'semi'; symbol?: string; endDate?: string; secondsToExpire?: number; chosenPrice?: number; trendEnabled?: boolean; trendMinutes?: number; stoplossEnabled?: boolean; stoplossCut1DropCents?: number; stoplossCut1SellPct?: number; stoplossCut2DropCents?: number; stoplossCut2SellPct?: number; stoplossMinSecToExit?: number }) {
        if (!this.hasValidKey) throw new Error('Missing private key');
        const conditionId = String(params.conditionId || '').trim();
        if (!conditionId) throw new Error('Missing conditionId');
        const requestedAmountUsd = params.amountUsd != null ? Number(params.amountUsd) : NaN;
        const amountUsd = Math.max(1, Number.isFinite(requestedAmountUsd) ? requestedAmountUsd : this.crypto15mAutoConfig.amountUsd);
        const source = params.source || 'semi';
        const force = params.force === true;
        const requestedMinPrice = params.minPrice != null ? Number(params.minPrice) : NaN;
        const effectiveMinPrice = Math.max(0, this.crypto15mAutoConfig.minProb, Number.isFinite(requestedMinPrice) ? requestedMinPrice : -Infinity);
        const trendEnabled = params.trendEnabled != null ? (params.trendEnabled === true) : this.crypto15mAutoConfig.trendEnabled;
        const trendMinutesRaw = params.trendMinutes != null ? Number(params.trendMinutes) : this.crypto15mAutoConfig.trendMinutes;
        const trendMinutes = Math.max(1, Math.min(10, Math.floor(Number.isFinite(trendMinutesRaw) ? trendMinutesRaw : 1)));
        const stoplossEnabled = params.stoplossEnabled != null ? (params.stoplossEnabled === true) : this.crypto15mAutoConfig.stoplossEnabled;
        const stoplossCut1DropCentsRaw = params.stoplossCut1DropCents != null ? Number(params.stoplossCut1DropCents) : this.crypto15mAutoConfig.stoplossCut1DropCents;
        const stoplossCut1SellPctRaw = params.stoplossCut1SellPct != null ? Number(params.stoplossCut1SellPct) : this.crypto15mAutoConfig.stoplossCut1SellPct;
        const stoplossCut2DropCentsRaw = params.stoplossCut2DropCents != null ? Number(params.stoplossCut2DropCents) : this.crypto15mAutoConfig.stoplossCut2DropCents;
        const stoplossCut2SellPctRaw = params.stoplossCut2SellPct != null ? Number(params.stoplossCut2SellPct) : this.crypto15mAutoConfig.stoplossCut2SellPct;
        const stoplossMinSecToExitRaw = params.stoplossMinSecToExit != null ? Number(params.stoplossMinSecToExit) : this.crypto15mAutoConfig.stoplossMinSecToExit;
        const stoplossConfig = {
            enabled: stoplossEnabled,
            cut1DropCents: Math.max(0, Math.min(50, Math.floor(Number.isFinite(stoplossCut1DropCentsRaw) ? stoplossCut1DropCentsRaw : 1))),
            cut1SellPct: Math.max(0, Math.min(100, Math.floor(Number.isFinite(stoplossCut1SellPctRaw) ? stoplossCut1SellPctRaw : 50))),
            cut2DropCents: Math.max(0, Math.min(50, Math.floor(Number.isFinite(stoplossCut2DropCentsRaw) ? stoplossCut2DropCentsRaw : 2))),
            cut2SellPct: Math.max(0, Math.min(100, Math.floor(Number.isFinite(stoplossCut2SellPctRaw) ? stoplossCut2SellPctRaw : 100))),
            minSecToExit: Math.max(0, Math.min(600, Math.floor(Number.isFinite(stoplossMinSecToExitRaw) ? stoplossMinSecToExitRaw : 25))),
        };
        if (params.stoplossEnabled != null || params.stoplossCut1DropCents != null || params.stoplossCut1SellPct != null || params.stoplossCut2DropCents != null || params.stoplossCut2SellPct != null || params.stoplossMinSecToExit != null) {
            this.crypto15mAutoConfig = {
                ...this.crypto15mAutoConfig,
                stoplossEnabled: stoplossConfig.enabled,
                stoplossCut1DropCents: stoplossConfig.cut1DropCents,
                stoplossCut1SellPct: stoplossConfig.cut1SellPct,
                stoplossCut2DropCents: stoplossConfig.cut2DropCents,
                stoplossCut2SellPct: stoplossConfig.cut2SellPct,
                stoplossMinSecToExit: stoplossConfig.minSecToExit,
            };
        }
        if (params.trendEnabled != null || params.trendMinutes != null) {
            this.crypto15mAutoConfig = { ...this.crypto15mAutoConfig, trendEnabled, trendMinutes };
        }
        const buySizingMode = this.crypto15mAutoConfig.buySizingMode;
        const secondsToExpireRaw = params.secondsToExpire != null ? Math.floor(Number(params.secondsToExpire)) : NaN;
        const secondsToExpireParam = Number.isFinite(secondsToExpireRaw) ? secondsToExpireRaw : null;

        const market = await withRetry(() => this.sdk.clobApi.getMarket(conditionId), { maxRetries: 2 });
        const marketAny: any = market as any;
        const marketSlug = String(marketAny?.marketSlug ?? marketAny?.market_slug ?? '');
        const q = String(marketAny?.question || '');
        const slugLc = marketSlug.toLowerCase();
        const qLc = q.toLowerCase();
        const symbol = String(params.symbol || (slugLc.startsWith('btc-') ? 'BTC' : slugLc.startsWith('eth-') ? 'ETH' : slugLc.startsWith('sol-') ? 'SOL' : slugLc.startsWith('xrp-') ? 'XRP' : qLc.includes('bitcoin') ? 'BTC' : qLc.includes('ethereum') ? 'ETH' : qLc.includes('solana') ? 'SOL' : qLc.includes('xrp') ? 'XRP' : 'UNKNOWN'));
        let endDate: string | null = params.endDate != null ? String(params.endDate) : null;
        if (!endDate && marketSlug.includes('-15m-')) {
            const parts = marketSlug.split('-');
            const last = parts[parts.length - 1];
            const n = Number(last);
            if (Number.isFinite(n) && n > 1_500_000_000) {
                const endMs = (Math.floor(n) + 15 * 60) * 1000;
                endDate = new Date(endMs).toISOString();
            }
        }
        if (!endDate) {
            const endIso = marketAny?.endDateIso ?? marketAny?.end_date_iso ?? null;
            const ms = endIso ? Date.parse(String(endIso)) : NaN;
            if (Number.isFinite(ms)) endDate = new Date(ms).toISOString();
        }
        let expiresAtMs = endDate ? Date.parse(endDate) : NaN;
        if (!Number.isFinite(expiresAtMs)) {
            expiresAtMs = Date.now() + 20 * 60_000;
            endDate = new Date(expiresAtMs).toISOString();
        }

        const secondsToExpire = secondsToExpireParam != null ? secondsToExpireParam : Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));
        const sweepWindowSec = Math.max(0, Math.floor(Number(this.crypto15mAutoConfig.sweepWindowSec) || 0));
        const sweepActive = this.crypto15mAutoConfig.sweepEnabled === true && secondsToExpire <= sweepWindowSec;

        if (this.crypto15mTrackedByCondition.has(conditionId) && !sweepActive) {
            throw new Error(`Already ordered for this market (conditionId=${conditionId})`);
        }
        const alreadyInHistory = this.orderHistory.some((e: any) => {
            if (!e) return false;
            if (String(e?.action || '') !== 'crypto15m_order') return false;
            const mid = String(e?.marketId || '').trim().toLowerCase();
            return mid && mid === conditionId.toLowerCase();
        });
        if (alreadyInHistory && !sweepActive) {
            throw new Error(`Already ordered for this market (history) (conditionId=${conditionId})`);
        }

        const upperSymbol = String(symbol || '').toUpperCase();
        const orderLockKey = upperSymbol && upperSymbol !== 'UNKNOWN' ? `${upperSymbol}:${expiresAtMs}` : null;
        if (!force && orderLockKey) {
            const active = this.crypto15mActivesBySymbol.get(upperSymbol);
            if (active && !(sweepActive && String(active?.conditionId || '') === conditionId)) {
                return { success: false, skipped: true, reason: 'already_active', symbol: upperSymbol, slug: marketSlug || null, expiresAtMs };
            }
            const locked = this.crypto15mOrderLocks.get(orderLockKey);
            if (locked && locked.status === 'placing') {
                return { success: false, skipped: true, reason: 'duplicate_inflight', symbol: upperSymbol, slug: marketSlug || null, expiresAtMs };
            }
            this.crypto15mOrderLocks.set(orderLockKey, { atMs: Date.now(), symbol: upperSymbol, expiresAtMs, conditionId, status: 'placing' });
        }

        const tokens: any[] = Array.isArray(marketAny?.tokens) ? marketAny.tokens : [];
        if (tokens.length < 2) throw new Error('Invalid market tokens');
        const requestedIdxRaw = params.outcomeIndex != null ? Math.floor(Number(params.outcomeIndex)) : NaN;
        let idx = Number.isFinite(requestedIdxRaw) ? Math.max(0, Math.min(tokens.length - 1, requestedIdxRaw)) : 0;
        const tokenOutcomeLc = String(tokens[idx]?.outcome || '').toLowerCase();
        if (!tokenOutcomeLc.includes('up') && !tokenOutcomeLc.includes('down')) {
            const upIdx = tokens.findIndex((t: any) => String(t?.outcome || '').toLowerCase().includes('up'));
            const downIdx = tokens.findIndex((t: any) => String(t?.outcome || '').toLowerCase().includes('down'));
            if (upIdx < 0 || downIdx < 0) throw new Error('Missing Up/Down outcomes');
            idx = Number.isFinite(requestedIdxRaw) && requestedIdxRaw === downIdx ? downIdx : upIdx;
        }
        const tok: any = tokens[idx];
        const tokenId = String(tok?.tokenId ?? tok?.token_id ?? tok?.id ?? '').trim();
        if (!tokenId) throw new Error('Missing tokenId');
        const outcome = String(tok?.outcome ?? '').trim() || `idx_${idx}`;
        const direction: 'Up' | 'Down' = outcome.toLowerCase().includes('down') ? 'Down' : 'Up';
        if (!force && trendEnabled === true && upperSymbol && upperSymbol !== 'UNKNOWN') {
            const up = await this.isBinanceUpPerMinute(upperSymbol, trendMinutes, direction).catch(() => ({ ok: false, closes: [], error: 'binance_error' }));
            if (!up.ok) {
                return { success: false, skipped: true, reason: 'trend', symbol: upperSymbol, slug: marketSlug || null, trendMinutes, direction };
            }
        }
        if (!force && symbol && symbol !== 'UNKNOWN' && marketSlug) {
            const baseMinDelta =
                symbol === 'BTC' ? this.crypto15mDeltaThresholds.btcMinDelta
                : symbol === 'ETH' ? this.crypto15mDeltaThresholds.ethMinDelta
                : symbol === 'SOL' ? this.crypto15mDeltaThresholds.solMinDelta
                : symbol === 'XRP' ? this.crypto15mDeltaThresholds.xrpMinDelta
                : 0;
            let overrideDelta: number | null = null;
            let minDeltaRequired = baseMinDelta;
            if (baseMinDelta > 0 && this.crypto15mAutoConfig.adaptiveDeltaEnabled === true) {
                const s = this.crypto15mAdaptiveDeltaBySymbol.get(upperSymbol);
                const d = s?.overrideDelta != null ? Number(s.overrideDelta) : NaN;
                overrideDelta = Number.isFinite(d) && d > 0 ? d : null;
                if (overrideDelta != null) {
                    minDeltaRequired = overrideDelta;
                }
            }
            if (minDeltaRequired > 0) {
                const beat = await this.fetchCrypto15mBeatAndCurrentFromSite(marketSlug);
                if (beat.deltaAbs == null) {
                    return { success: false, skipped: true, reason: 'delta_unavailable', symbol, slug: marketSlug, minDeltaBase: baseMinDelta, minDeltaRequired, minDeltaOverride: overrideDelta, error: beat.error || 'Failed to compute delta' };
                }
                const deltaAbs = Number(beat.deltaAbs);
                if (this.crypto15mAutoConfig.adaptiveDeltaEnabled === true && baseMinDelta > 0 && Number.isFinite(deltaAbs) && deltaAbs > 0) {
                    const m = Number(this.crypto15mAutoConfig.adaptiveDeltaBigMoveMultiplier) || 2;
                    if (deltaAbs >= baseMinDelta * Math.max(1, m)) {
                        this.crypto15mAdaptiveDeltaBySymbol.set(upperSymbol, { overrideDelta: deltaAbs, noBuyCount: 0, lastBigMoveAt: new Date().toISOString(), lastBigMoveDelta: deltaAbs });
                        overrideDelta = deltaAbs;
                        minDeltaRequired = deltaAbs;
                    }
                }
                if (Number.isFinite(deltaAbs) && deltaAbs < Number(minDeltaRequired)) {
                    return { success: false, skipped: true, reason: 'delta_too_small', symbol, slug: marketSlug, minDeltaBase: baseMinDelta, minDeltaRequired, minDeltaOverride: overrideDelta, deltaAbs, priceToBeat: beat.priceToBeat, currentPrice: beat.currentPrice };
                }
            }
        }
        const booksFetchedAtMs = Date.now();
        const books = await this.fetchClobBooks([tokenId]);
        const book = books && books.length ? books[0] : null;
        const booksCache = (this as any).clobBooksCache as Map<string, { atMs: number; data: any[] }> | undefined;
        const booksCacheAtMs = booksCache?.get(String(tokenId))?.atMs ?? null;
        const booksStaleMs = booksCacheAtMs != null ? Math.max(0, booksFetchedAtMs - Number(booksCacheAtMs)) : null;
        const asks = Array.isArray((book as any)?.asks) ? (book as any).asks : [];
        const bids = Array.isArray((book as any)?.bids) ? (book as any).bids : [];
        let bestAsk = NaN;
        for (const a of asks) {
            const p = Number(a?.price);
            if (!Number.isFinite(p) || p <= 0) continue;
            if (!Number.isFinite(bestAsk) || p < bestAsk) bestAsk = p;
        }
        const asksCount = asks.length;
        const hasAsks = (asksCount > 0) && Number.isFinite(bestAsk) && bestAsk > 0;
        if (!hasAsks && !sweepActive) {
            throw new Error(`No asks (orderbook unavailable) for tokenId=${tokenId}`);
        }
        const price = hasAsks ? bestAsk : NaN;
        if (hasAsks && Number.isFinite(effectiveMinPrice) && effectiveMinPrice > 0 && price < effectiveMinPrice) {
            throw new Error(`Price below threshold: bestAsk=${price} < minPrice=${effectiveMinPrice}`);
        }

        const basePrice = hasAsks
            ? price
            : (Number.isFinite(effectiveMinPrice) && effectiveMinPrice > 0 ? effectiveMinPrice : 0.999);
        let limitPrice = Math.min(0.999, basePrice + 0.02);
        if (sweepActive) limitPrice = 0.999;
        const depthUsdAtCap = (() => {
            try {
                const r = computeAskDepthUsd({ asks, limitPrice, maxLevels: 200 });
                const v = r?.depthUsd != null ? Number(r.depthUsd) : NaN;
                return Number.isFinite(v) ? v : null;
            } catch {
                return null;
            }
        })();
        let amountUsdFinal = amountUsd;
        const buySizingModeFinal = sweepActive ? 'orderbook_max' : (this.crypto15mAutoConfig.buySizingMode || 'fixed');
        let sizingDepthUsd: number | null = null;
        let sizingDepthCap: number | null = null;
        let sizingAskLevelsUsed: number | null = null;
        const replayBefore = buildOrderbookSnapshot({ book: { asks, bids }, fetchedAtMs: Number(booksCacheAtMs) || booksFetchedAtMs, topN: 25 });
        const replay: any = {
            meta: {
                strategy: 'crypto15m',
                tokenId,
                conditionId,
                symbol: upperSymbol || symbol,
                outcome,
                outcomeIndex: idx,
                expiresAtMs,
                secondsToExpire,
                bestAsk: Number.isFinite(price) ? Number(price) : null,
                limitPrice,
                buySizingMode: buySizingModeFinal,
                requestedAmountUsd: amountUsd,
                booksStaleMs,
                depthUsdAtCap,
                preOpenOrdersCount: null,
                preOpenOrdersRemainingShares: null,
                preOpenOrdersRemainingUsd: null,
            },
            before: replayBefore,
            after: null,
        };

        let preOpenOrdersCount: number | null = null;
        let preOpenOrdersRemainingShares: number | null = null;
        let preOpenOrdersRemainingUsd: number | null = null;
        try {
            const openOrders = await this.tradingClient.getOpenOrders(conditionId).catch(() => []);
            const list = Array.isArray(openOrders) ? openOrders : [];
            preOpenOrdersCount = list.length;
            let remShares = 0;
            let remUsd = 0;
            for (const o of list) {
                const size = o?.size != null ? Number(o.size) : (o?.originalSize != null ? Number(o.originalSize) : NaN);
                const filled = o?.filledSize != null ? Number(o.filledSize) : (o?.filled != null ? Number(o.filled) : 0);
                const price0 = o?.price != null ? Number(o.price) : NaN;
                const remaining = Number.isFinite(size) ? Math.max(0, size - (Number.isFinite(filled) ? filled : 0)) : NaN;
                if (Number.isFinite(remaining)) remShares += remaining;
                if (Number.isFinite(remaining) && Number.isFinite(price0)) remUsd += remaining * price0;
            }
            preOpenOrdersRemainingShares = Number.isFinite(remShares) ? remShares : null;
            preOpenOrdersRemainingUsd = Number.isFinite(remUsd) ? remUsd : null;
        } catch {
        }
        replay.meta.preOpenOrdersCount = preOpenOrdersCount;
        replay.meta.preOpenOrdersRemainingShares = preOpenOrdersRemainingShares;
        replay.meta.preOpenOrdersRemainingUsd = preOpenOrdersRemainingUsd;
        let sweepState: { conditionId: string; symbol: string; expiresAtMs: number; ordersCount: number; totalUsd: number; lastOrderAtMs: number } | null = null;
        if (!force && sweepActive) {
            const maxOrders = Math.max(1, Math.floor(Number(this.crypto15mAutoConfig.sweepMaxOrdersPerMarket) || 10));
            const maxTotalUsd = Math.max(1, Number(this.crypto15mAutoConfig.sweepMaxTotalUsdPerMarket) || 600);
            const minIntervalMs = Math.max(0, Math.floor(Number(this.crypto15mAutoConfig.sweepMinIntervalMs) || 0));
            const cur = this.crypto15mSweepStateByConditionId.get(conditionId) || { conditionId, symbol: upperSymbol || symbol, expiresAtMs, ordersCount: 0, totalUsd: 0, lastOrderAtMs: 0 };
            if (cur.ordersCount >= maxOrders) {
                return { success: false, skipped: true, reason: 'sweep_max_orders', symbol: upperSymbol || symbol, slug: marketSlug || null, expiresAtMs, ordersCount: cur.ordersCount, maxOrders };
            }
            if (cur.totalUsd >= maxTotalUsd) {
                return { success: false, skipped: true, reason: 'sweep_max_total', symbol: upperSymbol || symbol, slug: marketSlug || null, expiresAtMs, totalUsd: cur.totalUsd, maxTotalUsd };
            }
            const nowMs = Date.now();
            if (minIntervalMs > 0 && cur.lastOrderAtMs > 0 && nowMs - cur.lastOrderAtMs < minIntervalMs) {
                return { success: false, skipped: true, reason: 'sweep_throttle', symbol: upperSymbol || symbol, slug: marketSlug || null, expiresAtMs, waitMs: minIntervalMs - (nowMs - cur.lastOrderAtMs) };
            }
            const remaining = maxTotalUsd - cur.totalUsd;
            if (remaining < 1) {
                return { success: false, skipped: true, reason: 'sweep_max_total', symbol: upperSymbol || symbol, slug: marketSlug || null, expiresAtMs, totalUsd: cur.totalUsd, maxTotalUsd };
            }
            amountUsdFinal = Math.max(1, Math.min(amountUsdFinal, remaining));
            sweepState = { ...cur, lastOrderAtMs: nowMs, expiresAtMs, symbol: upperSymbol || symbol };
            this.crypto15mSweepStateByConditionId.set(conditionId, sweepState);
        }
        if (buySizingModeFinal !== 'fixed') {
            const depth = computeAskDepthUsd({ asks, limitPrice, targetUsd: amountUsdFinal, maxLevels: 200 });
            const depthCap = depth.depthUsd * 0.95;
            sizingDepthUsd = depth.depthUsd;
            sizingDepthCap = depthCap;
            sizingAskLevelsUsed = depth.levelsUsed;
            if (buySizingModeFinal === 'orderbook_max') {
                amountUsdFinal = Number.isFinite(depthCap) ? Math.max(1, Math.min(amountUsdFinal, depthCap)) : amountUsdFinal;
            } else if (buySizingModeFinal === 'all_capital') {
                const pf: any = await this.getPortfolioSummary({ positionsLimit: 1 }).catch(() => null);
                const cash = pf?.cash != null ? Number(pf.cash) : NaN;
                if (!Number.isFinite(cash) || cash < 1) {
                    return { success: false, skipped: true, reason: 'no_cash', symbol: upperSymbol || symbol, slug: marketSlug || null, expiresAtMs };
                }
                const hardCap = 5_000;
                const cap = Math.min(cash, hardCap);
                amountUsdFinal = Math.max(1, Number.isFinite(depthCap) ? Math.min(cap, depthCap) : cap);
            }
        }
        const globalKey = `crypto15m:${conditionId}`.toLowerCase();
        const sweepMaxOrders = Math.max(1, Math.floor(Number(this.crypto15mAutoConfig.sweepMaxOrdersPerMarket) || 10));
        const sweepMinIntervalMs = Math.max(0, Math.floor(Number(this.crypto15mAutoConfig.sweepMinIntervalMs) || 0));
        const sweepOrdersRemaining = sweepState ? Math.max(1, sweepMaxOrders - (Number(sweepState.ordersCount) || 0)) : 1;

        if (sweepActive && !force) {
            if (!this.tryAcquireGlobalOrderLock(globalKey, 'crypto15m')) {
                return { success: false, skipped: true, reason: 'global_locked', symbol: upperSymbol || symbol, slug: marketSlug || null, expiresAtMs };
            }
        }

        const sweepResult = sweepActive
            ? await runSweepBuyLiveBurst({
                tokenId,
                priceCap: limitPrice,
                budgetUsd: amountUsdFinal,
                maxOrders: sweepOrdersRemaining,
                maxConcurrent: Math.min(12, Math.max(1, sweepOrdersRemaining)),
                windowMs: Math.max(0, Math.floor(Number(this.crypto15mAutoConfig.sweepWindowSec) || 0) * 1000),
                roundIntervalMs: sweepMinIntervalMs,
                maxRounds: 60,
                fetchAsks: async () => {
                    const books2 = await this.fetchClobBooks([tokenId]);
                    const book2 = books2 && books2.length ? books2[0] : null;
                    return Array.isArray(book2?.asks) ? book2.asks : [];
                },
                placeOrder: async ({ amountUsd, priceCap }) => {
                    try {
                        const res: any = await this.tradingClient.createMarketOrder({ tokenId, side: 'BUY', amount: amountUsd, price: priceCap, orderType: 'FAK' });
                        const ok = res?.success === true;
                        const rawErr =
                            res?.errorMsg ?? res?.errorMessage ?? res?.message ?? res?.error ?? res?.reason ?? res?.details ?? res?.data ?? null;
                        const errText = rawErr == null ? null : (() => {
                            try {
                                const s = typeof rawErr === 'string' ? rawErr : JSON.stringify(rawErr);
                                return s ? String(s).slice(0, 240) : null;
                            } catch {
                                return String(rawErr).slice(0, 240);
                            }
                        })();
                        return { success: ok, orderId: res?.orderId ?? null, errorMsg: ok ? null : (errText || 'order_rejected') };
                    } catch (e: any) {
                        return { success: false, orderId: null, errorMsg: e?.message || String(e) };
                    }
                },
                getOrder: async (orderId: string) => {
                    const id = String(orderId || '').trim();
                    if (!id) return {};
                    const o: any = await this.tradingClient.getOrder(id).catch(() => null);
                    return {
                        status: o?.status ?? null,
                        filledSize: o?.filledSize ?? null,
                        price: o?.price ?? null,
                    };
                },
                maxLevels: 200,
            })
            : null;

        if (sweepActive && !force) {
            this.markGlobalOrderLockDone(globalKey, sweepResult?.ok === true);
        }

        const order = sweepActive
            ? {
                success: sweepResult?.ok === true,
                orderId: sweepResult?.orders?.[0]?.orderId ?? null,
                orderStatus: sweepResult?.orders?.[0]?.orderStatus ?? null,
                filledSize: sweepResult?.summary?.totalFilledShares ?? null,
                errorMsg: (sweepResult?.summary?.totalFilledUsd != null && Number(sweepResult.summary.totalFilledUsd) > 0)
                    ? null
                    : (sweepResult?.orders?.find((o) => o?.success === false)?.errorMsg ?? (sweepResult?.ok === true ? null : (sweepResult?.summary?.stopReason ?? 'order_failed'))),
                sweep: sweepResult,
            }
            : await (async () => {
                let ord: any = null;
                let globalOk = false;
                const attempts: any[] = [];
                try {
                    if (!force) {
                        if (!this.tryAcquireGlobalOrderLock(globalKey, 'crypto15m')) {
                            return { success: false, errorMsg: 'global_locked' };
                        }
                        if (this.globalOrderPlaceInFlight) {
                            this.markGlobalOrderLockDone(globalKey, false);
                            return { success: false, errorMsg: 'global_inflight' };
                        }
                        this.globalOrderPlaceInFlight = true;
                    }
                    const runAttempt = async (attemptNo: number, attemptUsd: number) => {
                        const startedAtMs = Date.now();
                        const res = await this.tradingClient.createMarketOrder({
                            tokenId,
                            side: 'BUY',
                            amount: attemptUsd,
                            price: limitPrice,
                            orderType: 'FAK',
                        });
                        const orderRoundtripMs = Math.max(0, Date.now() - startedAtMs);
                        const out = { ...res, orderRoundtripMs, attemptedUsd: attemptUsd, attemptNo };
                        attempts.push(out);
                        return out;
                    };
                    const a1 = await runAttempt(1, amountUsdFinal);
                    ord = a1;
                    const orderId1 = a1?.orderId != null ? String(a1.orderId) : (a1?.orderID != null ? String(a1.orderID) : (a1?.id != null ? String(a1.id) : null));
                    const probe1 = await this.probeRecentBuyState({ conditionId, tokenId, orderId: orderId1, maxWaitMs: 900 }).catch(() => ({ orderId: orderId1, filledSize: null, filledUsd: null, hasOpen: false, openOrderId: null, openRemainingUsd: null } as any));
                    (a1 as any).verified = true;
                    (a1 as any).verifiedOrderId = probe1?.orderId ?? null;
                    (a1 as any).verifiedFilledSize = probe1?.filledSize ?? null;
                    (a1 as any).verifiedFilledUsd = probe1?.filledUsd ?? null;
                    (a1 as any).verifiedHasOpen = probe1?.hasOpen === true;
                    const filledUsd1 = probe1?.filledUsd != null ? Number(probe1.filledUsd) : 0;
                    const didFill1 = Number.isFinite(filledUsd1) && filledUsd1 > 0;
                    const remainingUsd1 = Math.max(0, amountUsdFinal - (Number.isFinite(filledUsd1) ? filledUsd1 : 0));
                    const minDepthUsd = Math.max(2, Math.min(10, amountUsdFinal * 0.2));
                    const depthOk = depthUsdAtCap != null && Number.isFinite(Number(depthUsdAtCap)) && Number(depthUsdAtCap) >= minDepthUsd;
                    if (!sweepActive && remainingUsd1 >= 1 && depthOk && secondsToExpire >= 4 && probe1?.hasOpen !== true) {
                        await new Promise((r) => setTimeout(r, 300));
                        const book2 = await this.fetchClobBookSingle(tokenId, { minIntervalMs: 0, timeoutMs: 1_200 }).catch(() => null);
                        const asks2 = Array.isArray((book2 as any)?.asks) ? (book2 as any).asks : [];
                        const depth2 = computeAskDepthUsd({ asks: asks2, limitPrice, maxLevels: 200 });
                        const d2 = depth2?.depthUsd != null ? Number(depth2.depthUsd) : NaN;
                        const cap2 = Number.isFinite(d2) && d2 > 0 ? Math.max(1, Math.min(remainingUsd1, d2 * 0.95)) : remainingUsd1;
                        const attemptUsd2 = Math.max(1, Math.min(remainingUsd1, cap2));
                        const a2 = await runAttempt(2, attemptUsd2);
                        ord = a2;
                        const orderId2 = a2?.orderId != null ? String(a2.orderId) : (a2?.orderID != null ? String(a2.orderID) : (a2?.id != null ? String(a2.id) : null));
                        const probe2 = await this.probeRecentBuyState({ conditionId, tokenId, orderId: orderId2, maxWaitMs: 900 }).catch(() => ({ orderId: orderId2, filledSize: null, filledUsd: null, hasOpen: false, openOrderId: null, openRemainingUsd: null } as any));
                        (a2 as any).verified = true;
                        (a2 as any).verifiedOrderId = probe2?.orderId ?? null;
                        (a2 as any).verifiedFilledSize = probe2?.filledSize ?? null;
                        (a2 as any).verifiedFilledUsd = probe2?.filledUsd ?? null;
                        (a2 as any).verifiedHasOpen = probe2?.hasOpen === true;
                    }
                    globalOk = attempts.some((x) => x?.success === true) || (probe1?.filledUsd != null && Number(probe1.filledUsd) > 0) || probe1?.hasOpen === true || !!probe1?.orderId;
                    const finalSuccess = globalOk;
                    return { ...ord, success: finalSuccess, attempts };
                } catch (e: any) {
                    if (orderLockKey) {
                        this.crypto15mOrderLocks.set(orderLockKey, { atMs: Date.now(), symbol: upperSymbol, expiresAtMs, conditionId, status: 'failed' });
                    }
                    throw e;
                } finally {
                    if (!force) {
                        this.globalOrderPlaceInFlight = false;
                        this.markGlobalOrderLockDone(globalKey, globalOk);
                    }
                }
            })();

        const amountUsdLogged = sweepActive && sweepResult ? Number(sweepResult.summary.totalAttemptedUsd || 0) : amountUsdFinal;

        if (buySizingModeFinal !== 'fixed') {
            replay.meta.sizingDepthUsd = sizingDepthUsd;
            replay.meta.sizingDepthCap = sizingDepthCap;
            replay.meta.sizingAskLevelsUsed = sizingAskLevelsUsed;
        }
        const book60s = this.getCrypto15mBook60sSnapshot(tokenId, Date.now());
        const entry = {
            id: Date.now(),
            timestamp: new Date().toISOString(),
            mode: source,
            action: 'crypto15m_order',
            marketId: conditionId,
            symbol,
            slug: marketSlug || undefined,
            marketQuestion: market?.question,
            outcome,
            price: price,
            bestAsk: price,
            limitPrice,
            buySizingMode: buySizingModeFinal,
            requestedAmountUsd: amountUsd,
            amountUsd: amountUsdLogged,
            preOpenOrdersCount,
            preOpenOrdersRemainingShares,
            preOpenOrdersRemainingUsd,
            depthUsdAtCap,
            book60sEndSec: book60s.endSec,
            book60s: book60s.points,
            sizingDepthUsd,
            sizingDepthCap,
            sizingAskLevelsUsed,
            sweep: sweepActive ? { windowSec: this.crypto15mAutoConfig.sweepWindowSec, ordersCount: sweepState?.ordersCount ?? 0, totalUsd: sweepState?.totalUsd ?? 0, maxOrders: this.crypto15mAutoConfig.sweepMaxOrdersPerMarket, maxTotalUsd: this.crypto15mAutoConfig.sweepMaxTotalUsdPerMarket } : null,
            sweepLog: sweepResult,
            replay,
            results: sweepActive && sweepResult
                ? [
                    { ...order, tokenId, outcome, conditionId },
                    ...sweepResult.orders.map((o) => ({
                        success: o.success,
                        orderId: o.orderId,
                        orderStatus: o.orderStatus,
                        filledSize: o.filledSize,
                        orderPrice: o.orderPrice,
                        errorMsg: o.errorMsg,
                        roundtripMs: o.roundtripMs,
                        statusLatencyMs: o.statusLatencyMs,
                        attemptedUsd: o.attemptedUsd,
                        submittedAt: o.submittedAt,
                        tokenId,
                        outcome,
                        conditionId,
                    })),
                ]
                : (Array.isArray((order as any)?.attempts) && (order as any).attempts.length
                    ? (order as any).attempts.map((o: any) => ({ ...o, tokenId, outcome, conditionId }))
                    : [{ ...order, tokenId, outcome, conditionId }]),
        };
        try {
            await new Promise((r) => setTimeout(r, 300));
            const afterFetchedAtMs = Date.now();
            const afterBooks = await this.fetchClobBooks([tokenId]).catch(() => []);
            const afterBook = Array.isArray(afterBooks) && afterBooks.length ? afterBooks[0] : null;
            const afterAsks = Array.isArray((afterBook as any)?.asks) ? (afterBook as any).asks : [];
            const afterBids = Array.isArray((afterBook as any)?.bids) ? (afterBook as any).bids : [];
            replay.after = buildOrderbookSnapshot({ book: { asks: afterAsks, bids: afterBids }, fetchedAtMs: afterFetchedAtMs, topN: 25 });
        } catch {
        }
        this.orderHistory.unshift(entry);
        if (this.orderHistory.length > 100) this.orderHistory.pop();
        this.schedulePersistOrderHistory();

        const active = {
            startedAt: entry.timestamp,
            phase: order?.success ? 'ordered' : 'failed',
            symbol,
            conditionId,
            tokenId,
            outcome,
            price: price,
            bestAsk: price,
            limitPrice,
            buySizingMode: buySizingModeFinal,
            requestedAmountUsd: amountUsd,
            amountUsd: amountUsdLogged,
            sizingDepthUsd,
            sizingDepthCap,
            sizingAskLevelsUsed,
            sweep: sweepActive ? { windowSec: this.crypto15mAutoConfig.sweepWindowSec, ordersCount: sweepState?.ordersCount ?? 0, totalUsd: sweepState?.totalUsd ?? 0, maxOrders: this.crypto15mAutoConfig.sweepMaxOrdersPerMarket, maxTotalUsd: this.crypto15mAutoConfig.sweepMaxTotalUsdPerMarket } : null,
            source,
            orderId: order?.orderId ?? order?.id ?? null,
            order,
            endDate,
            expiresAtMs,
            secondsToExpire,
            chosenPrice: params.chosenPrice,
        };
        if (sweepActive && sweepState && sweepResult) {
            const okOrders = (Array.isArray(sweepResult.orders) ? sweepResult.orders : []).filter((o) => o && o.success === true);
            const addCount = okOrders.length;
            const addUsd = okOrders.reduce((sum, o) => sum + (Number(o.attemptedUsd) || 0), 0);
            if (addCount > 0 && addUsd > 0) {
                const next = {
                    ...sweepState,
                    ordersCount: (Number(sweepState.ordersCount) || 0) + addCount,
                    totalUsd: (Number(sweepState.totalUsd) || 0) + addUsd,
                    lastOrderAtMs: Date.now(),
                };
                this.crypto15mSweepStateByConditionId.set(conditionId, next);
            }
        }
        this.crypto15mTrackedByCondition.set(conditionId, active);
        if (active.phase === 'ordered' && symbol && symbol !== 'UNKNOWN') {
            this.crypto15mActivesBySymbol.set(symbol, active);
        } else if (symbol && symbol !== 'UNKNOWN') {
            this.crypto15mCooldownUntilBySymbol.set(symbol, Date.now() + 5_000);
        }

        if (active.phase === 'ordered' && stoplossConfig.enabled === true) {
            const entryPrice = active?.bestAsk != null ? Number(active.bestAsk) : NaN;
            const sizeEstimate = Number.isFinite(entryPrice) && entryPrice > 0 ? (Number(amountUsdFinal) / entryPrice) : 0;
            const tf: any = '15m';
            if (Number.isFinite(entryPrice) && entryPrice > 0 && sizeEstimate > 0) {
                this.registerCryptoAllStoplossPosition({
                    strategy: 'crypto15m',
                    conditionId,
                    tokenId,
                    symbol: upperSymbol,
                    timeframe: tf,
                    endMs: expiresAtMs,
                    entryPrice,
                    sizeEstimate,
                    stoploss: {
                        cut1DropCents: stoplossConfig.cut1DropCents,
                        cut1SellPct: stoplossConfig.cut1SellPct,
                        cut2DropCents: stoplossConfig.cut2DropCents,
                        cut2SellPct: stoplossConfig.cut2SellPct,
                        minSecToExit: stoplossConfig.minSecToExit,
                    }
                });
                this.startCryptoAllStoplossLoop();
            }
        }

        return { success: true, active, order };
    }

    async redeemNow(options?: { max?: number; source?: 'manual' | 'auto' }): Promise<any> {
        if (!this.ctf || !this.hasValidKey) {
            return { success: false, error: 'CTF not configured (missing private key)' };
        }

        const funder = this.getFunderAddress();
        const max = Math.max(1, Math.floor(Number(options?.max ?? 20)));
        const source = options?.source || 'manual';

        const positions = await this.fetchDataApiPositions(funder);
        const redeemable = positions.filter((p: any) => !!p?.redeemable && p?.conditionId).slice(0, max);

        const results: any[] = [];
        for (const p of redeemable) {
            const conditionId = String(p.conditionId);

            try {
                const proxyWallet = String(p.proxyWallet || '').trim();
                const shouldUseSafe = !this.relayerConfigured && proxyWallet && this.redeemWallet && proxyWallet.toLowerCase() != this.redeemWallet.address.toLowerCase();

                if (this.relayerConfigured) {
                    const relayed = await this.redeemViaRelayerSubmit(conditionId, { proxyWallet: p.proxyWallet });
                    results.push({ success: true, confirmed: false, redeemStatus: 'submitted', conditionId, title: p.title, outcome: p.outcome, txHash: relayed.txHash, transactionId: relayed.transactionId, method: `relayer_${relayed.txType.toLowerCase()}` });
                } else if (shouldUseSafe) {
                    try {
                        const txHash = await this.redeemViaPolymarketProxy(proxyWallet, conditionId);
                        results.push({ success: true, conditionId, title: p.title, outcome: p.outcome, txHash, method: 'proxy', proxyWallet });
                    } catch (e1: any) {
                        const canUseSafe = await this.isLikelyGnosisSafe(proxyWallet);
                        if (!canUseSafe) throw e1;
                        const txHash = await this.redeemViaSafe(proxyWallet, conditionId);
                        results.push({ success: true, conditionId, title: p.title, outcome: p.outcome, txHash, method: 'safe', proxyWallet, proxyError: e1?.message || String(e1) });
                    }
                } else {
                    const market = await withRetry(() => this.sdk.clobApi.getMarket(conditionId), { maxRetries: 2 });
                    const tokens = market?.tokens || [];
                    const getTokenId = (t: any): string | undefined => t?.token_id ?? t?.tokenId ?? t?.id;
                    const yesTokenId = getTokenId(tokens[0]);
                    const noTokenId = getTokenId(tokens[1]);
                    if (!yesTokenId || !noTokenId) throw new Error('Missing token ids');
                    const r = await this.ctf.redeemByTokenIds(conditionId, { yesTokenId, noTokenId } as any);
                    results.push({ success: true, conditionId, title: p.title, outcome: p.outcome, txHash: r.txHash, usdcReceived: r.usdcReceived, method: 'eoa' });
                }
            } catch (e: any) {
                const error = e?.message || String(e);
                results.push({ success: false, conditionId, title: p.title, outcome: p.outcome, error, errorSummary: this.summarizeErrorMessage(error) });
            }
        }

        const entry = {
            id: Date.now(),
            timestamp: new Date().toISOString(),
            mode: 'system',
            action: 'redeem',
            remark: source === 'auto' ? 'auto_redeem' : 'redeem_now',
            funder,
            count: results.length,
            results,
        };
        this.orderHistory.unshift(entry);
        if (this.orderHistory.length > 100) this.orderHistory.pop();
        this.schedulePersistOrderHistory();

        const okCount = results.filter(r => r.success).length;
        const failCount = results.filter(r => !r.success).length;
        this.autoRedeemLast = { at: entry.timestamp, source, count: results.length, ok: okCount, fail: failCount };
        if (source === 'auto') {
            if (okCount > 0) {
                this.autoRedeemLastError = null;
            } else if (failCount > 0) {
                const firstErr = results.find(r => !r.success)?.error;
                this.autoRedeemLastError = firstErr ? String(firstErr) : 'Auto redeem failed';
            }
        }
        return { success: true, funder, count: results.length, results };
    }

    async redeemByConditions(items: Array<{ conditionId: string; title?: string; slug?: string; eventSlug?: string; outcome?: string }>, options?: { source?: 'manual' | 'auto'; force?: boolean }) {
        const list = Array.isArray(items) ? items : [];
        const source = options?.source || 'manual';
        const force = options?.force === true;
        const before = await this.getPortfolioSummary({ positionsLimit: 1 }).catch(() => null);
        const cashBefore = before?.cash != null ? Number(before.cash) : null;
        const claimableCountBefore = before?.claimableCount != null ? Number(before.claimableCount) : null;
        const funder = this.getFunderAddress();
        const positions = await this.fetchDataApiPositions(funder).catch(() => []);
        const conditionToMeta = new Map((Array.isArray(positions) ? positions : [])
            .map((p: any) => [String(p?.conditionId || '').trim(), { proxyWallet: String(p?.proxyWallet || '').trim(), redeemable: !!p?.redeemable, title: p?.title, slug: p?.slug, eventSlug: p?.eventSlug, outcome: p?.outcome }] as const)
            .filter(([cid]) => !!cid));
        const results: any[] = [];
        const conditionIds: string[] = [];
        for (const it of list) {
            const conditionId = String(it?.conditionId || '').trim();
            if (!conditionId) continue;
            conditionIds.push(conditionId);
            try {
                const meta = conditionToMeta.get(conditionId);
                if (!force && meta && meta.redeemable === false) {
                    results.push({
                        success: false,
                        confirmed: false,
                        redeemStatus: 'skipped',
                        conditionId,
                        title: it?.title ?? meta.title,
                        outcome: it?.outcome ?? meta.outcome,
                        slug: it?.slug ?? meta.slug,
                        eventSlug: it?.eventSlug ?? meta.eventSlug,
                        polymarketUrl: this.buildPolymarketMarketUrlFromSlug(it?.slug ?? meta.slug),
                        error: 'Not redeemable yet (data-api redeemable=false)',
                        errorSummary: 'Not redeemable yet',
                    });
                    continue;
                }

                const proxyWallet = String(meta?.proxyWallet || '').trim();
                const shouldUseSafe = !this.relayerConfigured && proxyWallet && this.redeemWallet && proxyWallet.toLowerCase() != this.redeemWallet.address.toLowerCase();
                if (shouldUseSafe) {
                    let method: string = 'proxy';
                    let txHash: string = '';
                    try {
                        txHash = await this.redeemViaPolymarketProxy(proxyWallet, conditionId);
                        method = 'proxy';
                    } catch (e1: any) {
                        const canUseSafe = await this.isLikelyGnosisSafe(proxyWallet);
                        if (!canUseSafe) throw e1;
                        txHash = await this.redeemViaSafe(proxyWallet, conditionId);
                        method = 'safe';
                    }
                    const payout = await this.computeUsdcTransfersFromTxHash(txHash, { recipients: [proxyWallet, funder] }).catch(() => null);
                    const submittedAt = new Date().toISOString();
                    this.redeemInFlight.set(conditionId, {
                        conditionId,
                        submittedAt,
                        method,
                        txHash,
                        status: 'confirmed',
                        txStatus: payout?.txStatus ?? 1,
                        payoutUsdc: payout?.netUsdc ?? 0,
                        payoutReceivedUsdc: payout?.receivedUsdc ?? 0,
                        payoutSentUsdc: payout?.sentUsdc ?? 0,
                        payoutNetUsdc: payout?.netUsdc ?? 0,
                        payoutRecipients: payout?.recipients ?? [proxyWallet.toLowerCase(), funder.toLowerCase()],
                        paid: (payout?.txStatus ?? 1) === 0 ? false : Number(payout?.netUsdc ?? 0) > 0,
                        payoutComputedAt: new Date().toISOString(),
                        usdcTransfers: payout?.transfers ?? [],
                    });
                    this.crypto15mSyncFromRedeemInFlight(conditionId);
                    results.push({
                        success: true,
                        confirmed: true,
                        redeemStatus: 'confirmed',
                        conditionId,
                        title: it?.title ?? meta?.title,
                        outcome: it?.outcome ?? meta?.outcome,
                        slug: it?.slug ?? meta?.slug,
                        eventSlug: it?.eventSlug ?? meta?.eventSlug,
                        polymarketUrl: this.buildPolymarketMarketUrlFromSlug(it?.slug),
                        txHash,
                        method,
                        payoutUsdc: payout?.netUsdc ?? 0,
                        payoutReceivedUsdc: payout?.receivedUsdc ?? 0,
                        payoutSentUsdc: payout?.sentUsdc ?? 0,
                        payoutNetUsdc: payout?.netUsdc ?? 0,
                        payoutRecipients: payout?.recipients ?? [proxyWallet.toLowerCase(), funder.toLowerCase()],
                        txStatus: payout?.txStatus ?? 1,
                        paid: (payout?.txStatus ?? 1) === 0 ? false : Number(payout?.netUsdc ?? 0) > 0,
                        usdcTransfers: payout?.transfers ?? [],
                    });
                } else if (this.relayerConfigured) {
                    const r = await this.redeemViaRelayerSubmit(conditionId, { proxyWallet: proxyWallet });
                    results.push({
                        success: true,
                        confirmed: false,
                        redeemStatus: 'submitted',
                        conditionId,
                        title: it?.title ?? meta?.title,
                        outcome: it?.outcome ?? meta?.outcome,
                        slug: it?.slug ?? meta?.slug,
                        eventSlug: it?.eventSlug ?? meta?.eventSlug,
                        polymarketUrl: this.buildPolymarketMarketUrlFromSlug(it?.slug),
                        transactionId: r?.transactionId,
                        method: `relayer_${String(r?.txType || '').toLowerCase()}`,
                    });
                } else {
                    const r = await this.redeemNow({ max: 1, source });
                    const first = Array.isArray(r?.results) ? r.results[0] : null;
                    results.push(first || { success: false, conditionId, error: 'Redeem attempted via non-relayer path' });
                }
            } catch (e: any) {
                const error = e?.message || String(e);
                const submittedAt = new Date().toISOString();
                this.redeemInFlight.set(conditionId, { conditionId, submittedAt, method: 'redeem_failed', status: 'failed', error });
                this.crypto15mSyncFromRedeemInFlight(conditionId);
                results.push({
                    success: false,
                    confirmed: false,
                    redeemStatus: 'failed',
                    conditionId,
                    title: it?.title,
                    outcome: it?.outcome,
                    slug: it?.slug,
                    eventSlug: it?.eventSlug,
                    polymarketUrl: this.buildPolymarketMarketUrlFromSlug(it?.slug),
                    error,
                    errorSummary: this.summarizeErrorMessage(error),
                });
            }
        }

        if (source === 'manual' && conditionIds.length) {
            const start = Date.now();
            const timeoutMs = 3 * 60_000;
            while (Date.now() - start < timeoutMs) {
                const pending = conditionIds.filter((id) => {
                    const st = this.redeemInFlight.get(id)?.status;
                    return st === 'submitted';
                });
                if (!pending.length) break;
                await new Promise(r => setTimeout(r, 750));
            }
        }

        for (const r of results) {
            const cid = r?.conditionId ? String(r.conditionId) : '';
            if (!cid) continue;
            const inflight = this.redeemInFlight.get(cid);
            if (!inflight) continue;
            r.redeemStatus = inflight.status;
            r.txHash = inflight.txHash ?? r.txHash;
            r.payoutUsdc = inflight.payoutUsdc ?? r.payoutUsdc;
            r.payoutReceivedUsdc = inflight.payoutReceivedUsdc ?? r.payoutReceivedUsdc;
            r.payoutSentUsdc = inflight.payoutSentUsdc ?? r.payoutSentUsdc;
            r.payoutNetUsdc = inflight.payoutNetUsdc ?? r.payoutNetUsdc;
            r.payoutRecipients = inflight.payoutRecipients ?? r.payoutRecipients;
            r.txStatus = inflight.txStatus ?? r.txStatus;
            r.paid = inflight.paid ?? r.paid;
            r.usdcTransfers = inflight.usdcTransfers ?? r.usdcTransfers;
            if (inflight.status === 'confirmed') r.confirmed = true;
            if (inflight.status === 'failed') {
                r.success = false;
                r.error = inflight.error ?? r.error;
                r.errorSummary = this.summarizeErrorMessage(r.error);
            }
        }

        const after = await this.getPortfolioSummary({ positionsLimit: 1 }).catch(() => null);
        const cashAfter = after?.cash != null ? Number(after.cash) : null;
        const claimableCountAfter = after?.claimableCount != null ? Number(after.claimableCount) : null;
        const cashDelta = cashBefore != null && cashAfter != null ? (cashAfter - cashBefore) : null;

        if (results.length) {
            this.orderHistory.unshift({
                id: Date.now(),
                timestamp: new Date().toISOString(),
                marketQuestion: `Redeem selected (${results.length})`,
                mode: source,
                action: 'redeem',
                cashBefore,
                cashAfter,
                cashDelta,
                claimableCountBefore,
                claimableCountAfter,
                results,
            });
            if (this.orderHistory.length > 100) this.orderHistory.pop();
            this.schedulePersistOrderHistory();
        }

        return { success: true, source, count: results.length, cashBefore, cashAfter, cashDelta, claimableCountBefore, claimableCountAfter, results };
    }

    async debugCrypto15mOrderStatus(orderId: string): Promise<any> {
        const id = String(orderId || '').trim();
        if (!id) return { success: false, error: 'Missing orderId' };
        try {
            const o = await this.tradingClient.getOrder(id);
            return { success: true, order: o };
        } catch (e: any) {
            return { success: false, error: e?.message || String(e) };
        }
    }

    async debugCrypto15mProof(orderId: string): Promise<any> {
        const id = String(orderId || '').trim();
        if (!id) return { success: false, error: 'Missing orderId' };
        try {
            const signerAddress = this.tradingClient.getSignerAddress();
            const funderAddress = this.tradingClient.getFunderAddress();
            const order = await this.tradingClient.getOrder(id);
            const conditionId = String(order?.marketId || order?.market || order?.market_id || '').trim();
            let inFlight = conditionId ? this.redeemInFlight.get(conditionId) : undefined;
            if (conditionId && inFlight && inFlight.status === 'confirmed' && inFlight.txHash && inFlight.paid == null && inFlight.payoutNetUsdc == null) {
                try {
                    const payout = await this.computeUsdcTransfersFromTxHash(String(inFlight.txHash), { recipients: inFlight.payoutRecipients });
                    inFlight.txStatus = payout.txStatus;
                    inFlight.payoutUsdc = payout.netUsdc;
                    inFlight.payoutReceivedUsdc = payout.receivedUsdc;
                    inFlight.payoutSentUsdc = payout.sentUsdc;
                    inFlight.payoutNetUsdc = payout.netUsdc;
                    inFlight.payoutRecipients = payout.recipients;
                    inFlight.usdcTransfers = payout.transfers;
                    inFlight.paid = payout.txStatus === 0 ? false : Number(payout.netUsdc) > 0;
                    inFlight.error = undefined;
                    inFlight.payoutComputedAt = new Date().toISOString();
                } catch (e: any) {
                    inFlight.payoutComputedAt = new Date().toISOString();
                    inFlight.error = e?.message || String(e);
                }
            }
            const positions = conditionId ? await this.fetchDataApiPositions(funderAddress) : [];
            const position = conditionId
                ? (Array.isArray(positions)
                    ? positions.find((p: any) => String(p?.conditionId || '').trim().toLowerCase() === conditionId.toLowerCase())
                    : null)
                : null;
            const historyEntry = this.orderHistory.find((e: any) => {
                if (!e) return false;
                if (conditionId && String(e?.marketId || '').trim().toLowerCase() === conditionId.toLowerCase()) return true;
                const results = Array.isArray(e?.results) ? e.results : [];
                return results.some((r: any) => String(r?.orderId || '').trim().toLowerCase() === id.toLowerCase());
            }) || null;
            if (historyEntry && Array.isArray(historyEntry.results)) {
                const results = historyEntry.results as any[];
                for (const r of results) {
                    if (String(r?.orderId || '').trim().toLowerCase() !== id.toLowerCase()) continue;
                    const txHash = String(r?.txHash || '').trim();
                    if (!txHash || !txHash.startsWith('0x')) continue;
                    if (r.paid != null || r.payoutNetUsdc != null) {
                        r.payoutError = null;
                        continue;
                    }
                    try {
                        const recipients = Array.isArray(r?.payoutRecipients) && r.payoutRecipients.length ? r.payoutRecipients : [funderAddress];
                        const payout = await this.computeUsdcTransfersFromTxHash(txHash, { recipients });
                        r.txStatus = payout.txStatus;
                        r.payoutUsdc = payout.netUsdc;
                        r.payoutReceivedUsdc = payout.receivedUsdc;
                        r.payoutSentUsdc = payout.sentUsdc;
                        r.payoutNetUsdc = payout.netUsdc;
                        r.payoutRecipients = payout.recipients;
                        r.usdcTransfers = payout.transfers;
                        r.paid = payout.txStatus === 0 ? false : Number(payout.netUsdc) > 0;
                        r.payoutError = null;
                        r.payoutComputedAt = new Date().toISOString();
                    } catch (e: any) {
                        r.payoutComputedAt = new Date().toISOString();
                        r.payoutError = e?.message || String(e);
                    }
                }
                this.schedulePersistOrderHistory();
            }
            const autoRedeemStatus = this.getAutoRedeemStatus();
            const redeemConfirmed = conditionId ? (!!inFlight && inFlight.status === 'confirmed' && inFlight.paid === true) : false;
            return {
                success: true,
                orderId: id,
                addresses: {
                    signerAddress,
                    funderAddress,
                    proxyAddress: funderAddress && signerAddress && funderAddress.toLowerCase() !== signerAddress.toLowerCase() ? funderAddress : null,
                },
                order,
                conditionId: conditionId || null,
                dataApiPosition: position || null,
                autoRedeemStatus,
                redeemInFlight: inFlight || null,
                redeemConfirmed,
                historyEntry,
            };
        } catch (e: any) {
            return { success: false, error: e?.message || String(e) };
        }
    }

    async debugCrypto15mProofMarket(options: { slug?: string; conditionId?: string }): Promise<any> {
        const slugRaw = options?.slug != null ? String(options.slug).trim() : '';
        const conditionIdRaw = options?.conditionId != null ? String(options.conditionId).trim() : '';
        const funderAddress = this.tradingClient.getFunderAddress();
        let conditionId = conditionIdRaw;
        let slug = slugRaw;
        if (!conditionId && slug) {
            const m = await this.fetchEventMarketFromSite(slug);
            conditionId = String(m?.conditionId || m?.condition_id || '').trim();
            if (!slug) slug = String(m?.slug || '').trim();
        }
        if (!conditionId || !conditionId.startsWith('0x')) return { success: false, error: 'Missing conditionId/slug' };
        const toolOrders = this.orderHistory
            .filter((e: any) => e && String(e?.action || '') === 'crypto15m_order')
            .filter((e: any) => {
                const mid = String(e?.marketId || '').trim().toLowerCase();
                const eslug = String(e?.slug || '').trim().toLowerCase();
                if (mid && mid === conditionId.toLowerCase()) return true;
                if (slug && eslug && eslug === slug.toLowerCase()) return true;
                return false;
            })
            .slice(0, 20);
        const inFlight = this.redeemInFlight.get(conditionId) || null;
        const positions = await this.fetchDataApiPositions(funderAddress).catch(() => []);
        const position = Array.isArray(positions)
            ? positions.find((p: any) => String(p?.conditionId || '').trim().toLowerCase() === conditionId.toLowerCase()) || null
            : null;
        return {
            success: true,
            slug: slug || null,
            conditionId,
            isToolOrder: toolOrders.length > 0,
            toolOrders,
            redeemInFlight: inFlight,
            dataApiPosition: position,
        };
    }

    resetCryptoAllActive() {
        this.cryptoAllActivesByKey.clear();
        this.cryptoAllTrackedByCondition.clear();
        return this.getCryptoAllStatus();
    }

    getCryptoAllStatus() {
        const now = Date.now();
        const addOnPositions = Array.from(this.cryptoAllAddOnState.values())
            .slice(0, 80)
            .map((p: any) => {
                const secondsToExpire = Math.floor((Number(p.endMs) - now) / 1000);
                return {
                    ...p,
                    secondsToExpire,
                    window: this.getCryptoAllAddOnWindow(secondsToExpire),
                };
            });
        const stoplossPositions = Array.from(this.cryptoAllStoplossState.values())
            .slice(0, 80)
            .map((p: any) => {
                const secondsToExpire = Math.floor((Number(p.endMs) - now) / 1000);
                const soldPct = (Number(p.soldSize) / Math.max(1e-9, Number(p.totalSize))) * 100;
                return { ...p, secondsToExpire, soldPct };
            });
        const adaptiveDelta: any = {};
        for (const tf of ['5m', '15m', '1h', '4h', '1d'] as const) {
            adaptiveDelta[tf] = {};
            for (const sym of ['BTC', 'ETH', 'SOL', 'XRP']) {
                const base = this.getCryptoAllMinDeltaRequired(sym, tf);
                const st = this.cryptoAllAdaptiveDeltaBySymbol.get(`${sym}:${tf}`) || null;
                const overrideDelta = st?.overrideDelta != null && Number.isFinite(Number(st.overrideDelta)) ? Number(st.overrideDelta) : null;
                const noBuyCount = st?.noBuyCount != null ? Math.max(0, Math.floor(Number(st.noBuyCount))) : 0;
                const limit = Math.max(1, Math.floor(Number(this.cryptoAllAutoConfig.adaptiveDeltaRevertNoBuyCount) || 4));
                adaptiveDelta[tf][sym] = {
                    enabled: this.cryptoAllAutoConfig.adaptiveDeltaEnabled === true,
                    baseMinDelta: base,
                    overrideMinDelta: overrideDelta,
                    effectiveMinDelta: overrideDelta != null ? overrideDelta : base,
                    noBuyCount,
                    revertAfter: limit,
                    remainingToRevert: overrideDelta != null ? Math.max(0, limit - noBuyCount) : null,
                    lastBigMoveAt: st?.lastBigMoveAt ?? null,
                    lastBigMoveDelta: st?.lastBigMoveDelta ?? null,
                };
            }
        }
        return {
            hasValidKey: this.hasValidKey === true,
            trading: this.getTradingInitStatus(),
            enabled: this.cryptoAllAutoEnabled,
            dryRun: this.cryptoAllAutoDryRun === true,
            config: this.cryptoAllAutoConfig,
            lastScanAt: this.cryptoAllLastScanAt,
            lastScanSummary: this.cryptoAllLastScanSummary,
            lastError: this.cryptoAllLastError,
            books: {
                atMs: this.cryptoAllBooksSnapshot.atMs,
                tokenCount: Object.keys(this.cryptoAllBooksSnapshot.byTokenId || {}).length,
                lastError: this.cryptoAllBooksSnapshot.lastError,
                lastAttemptAtMs: this.cryptoAllBooksSnapshot.lastAttemptAtMs,
                lastAttemptError: this.cryptoAllBooksSnapshot.lastAttemptError,
            },
            actives: Object.fromEntries(Array.from(this.cryptoAllActivesByKey.entries()).slice(0, 50)),
            trackedCount: this.cryptoAllTrackedByCondition.size,
            addOn: { enabled: this.cryptoAllAutoConfig.addOn.enabled, positions: addOnPositions },
            stoploss: { enabled: this.cryptoAllAutoConfig.stoploss.enabled, positions: stoplossPositions },
            adaptiveDelta,
        };
    }

    getCryptoAllWatchdogStatus() {
        const w = this.cryptoAllWatchdog;
        const now = Date.now();
        const remainingMs = w.running && w.endsAtMs ? Math.max(0, w.endsAtMs - now) : 0;
        return {
            running: w.running,
            pollMs: w.pollMs,
            startedAt: w.startedAtMs ? new Date(w.startedAtMs).toISOString() : null,
            endsAt: w.endsAtMs ? new Date(w.endsAtMs).toISOString() : null,
            remainingMs: w.running ? remainingMs : null,
            lastTickAt: w.lastTickAtMs ? new Date(w.lastTickAtMs).toISOString() : null,
            lastError: w.lastError,
            stopReason: w.stopReason,
            thresholds: w.thresholds,
            counters: w.counters,
            issuesCount: w.issues.length,
            lastIssue: w.issues.length ? w.issues[w.issues.length - 1] : null,
            reportPaths: w.reportPaths,
        };
    }

    startCryptoAllWatchdog(options?: { durationHours?: number; pollMs?: number }) {
        const durationHours = options?.durationHours != null ? Number(options.durationHours) : 12;
        const pollMs = options?.pollMs != null ? Number(options.pollMs) : 30_000;
        const now = Date.now();
        this.cryptoAllWatchdog.running = true;
        this.cryptoAllWatchdog.pollMs = Math.max(5_000, Math.floor(pollMs));
        this.cryptoAllWatchdog.startedAtMs = now;
        this.cryptoAllWatchdog.endsAtMs = now + Math.max(1, durationHours) * 60 * 60_000;
        this.cryptoAllWatchdog.lastTickAtMs = 0;
        this.cryptoAllWatchdog.lastError = null;
        this.cryptoAllWatchdog.stopReason = null;
        this.cryptoAllWatchdog.counters = { consecutiveDataError: 0, redeemFailed: 0, orderFailed: 0 };
        this.cryptoAllWatchdog.issues = [];
        this.cryptoAllWatchdog.reportPaths = {};
        if (this.cryptoAllWatchdogTimer) {
            clearInterval(this.cryptoAllWatchdogTimer);
            this.cryptoAllWatchdogTimer = null;
        }
        const tick = () => {
            this.cryptoAllWatchdogTick().catch((e: any) => {
                this.cryptoAllWatchdog.lastError = e?.message || String(e);
            });
        };
        tick();
        this.cryptoAllWatchdogTimer = setInterval(tick, this.cryptoAllWatchdog.pollMs);
        return this.getCryptoAllWatchdogStatus();
    }

    stopCryptoAllWatchdog(options?: { reason?: string; stopAuto?: boolean }) {
        const reason = options?.reason != null ? String(options.reason) : 'manual_stop';
        const stopAuto = options?.stopAuto !== false;
        if (this.cryptoAllWatchdogTimer) {
            clearInterval(this.cryptoAllWatchdogTimer);
            this.cryptoAllWatchdogTimer = null;
        }
        if (stopAuto) {
            try {
                this.stopCryptoAllAuto();
            } catch {
            }
        }
        this.cryptoAllWatchdog.running = false;
        this.cryptoAllWatchdog.stopReason = reason;
        this.cryptoAllWatchdog.lastTickAtMs = Date.now();
        this.cryptoAllWriteWatchdogReport(reason);
        return this.getCryptoAllWatchdogStatus();
    }

    getCryptoAllWatchdogReportLatest() {
        const jsonPath = this.cryptoAllWatchdog.reportPaths.json;
        const mdPath = this.cryptoAllWatchdog.reportPaths.md;
        let json: any = null;
        let md: string | null = null;
        try {
            if (jsonPath && fs.existsSync(jsonPath)) json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        } catch {
        }
        try {
            if (mdPath && fs.existsSync(mdPath)) md = String(fs.readFileSync(mdPath, 'utf8'));
        } catch {
        }
        return { success: true, jsonPath: jsonPath || null, mdPath: mdPath || null, json, md };
    }

    private async cryptoAllWatchdogTick() {
        const w = this.cryptoAllWatchdog;
        if (!w.running) return;
        const now = Date.now();
        w.lastTickAtMs = now;
        if (w.endsAtMs && now >= w.endsAtMs) {
            this.stopCryptoAllWatchdog({ reason: 'duration_elapsed', stopAuto: true });
            return;
        }

        let candidates: any[] = [];
        let dataError: string | null = null;
        try {
            const limit = Math.max(10, Math.min(40, (this.cryptoAllAutoConfig.symbols.length || 1) * (this.cryptoAllAutoConfig.timeframes.length || 1) * 2));
            candidates = await this.getCryptoAllCandidates({
                symbols: this.cryptoAllAutoConfig.symbols,
                timeframes: this.cryptoAllAutoConfig.timeframes,
                minProb: this.cryptoAllAutoConfig.minProb,
                expiresWithinSec: this.cryptoAllAutoConfig.expiresWithinSec,
                limit,
            });
        } catch (e: any) {
            dataError = e?.message || String(e);
        }

        if (!dataError) {
            const list = Array.isArray(candidates) ? candidates : [];
            const errCount = list.filter((c: any) => c && c.deltaError).length;
            const total = list.length;
            if (total > 0 && errCount / total >= w.thresholds.deltaErrorRateThreshold) {
                dataError = `delta_error_rate=${(errCount / total).toFixed(2)} (${errCount}/${total})`;
            }
        }

        if (dataError) w.counters.consecutiveDataError += 1;
        else w.counters.consecutiveDataError = 0;

        if (w.counters.consecutiveDataError >= w.thresholds.consecutiveDataStops) {
            w.issues.push({ at: new Date().toISOString(), type: 'data_error', message: String(dataError || '-') });
            this.stopCryptoAllWatchdog({ reason: 'data_error', stopAuto: true });
            return;
        }

        await this.refreshHistoryStatuses({ maxEntries: 50, minIntervalMs: 1000 }).catch(() => null);
        const h: any = await this.getCryptoAllHistory({ refresh: false, maxEntries: 50 }).catch(() => null);
        const items = Array.isArray(h?.history) ? h.history : [];

        const anyRedeemFailed = items.find((it: any) => String(it?.redeemStatus || '') === 'failed' || String(it?.state || '') === 'redeem_failed') || null;
        if (anyRedeemFailed) {
            w.counters.redeemFailed += 1;
            w.issues.push({ at: new Date().toISOString(), type: 'redeem_failed', message: `${anyRedeemFailed.slug || anyRedeemFailed.conditionId || ''}`, meta: { conditionId: anyRedeemFailed.conditionId, txHash: anyRedeemFailed.txHash || null } });
            if (w.counters.redeemFailed >= w.thresholds.redeemFailedStops) {
                this.stopCryptoAllWatchdog({ reason: 'redeem_failed', stopAuto: true });
                return;
            }
        } else {
            w.counters.redeemFailed = 0;
        }

        const anyOrderFailed = items.find((it: any) => {
            const st = String(it?.orderStatus || '');
            return st === 'FAILED' || st === 'REJECTED';
        }) || null;
        if (anyOrderFailed) {
            w.counters.orderFailed += 1;
            w.issues.push({ at: new Date().toISOString(), type: 'order_failed', message: `${anyOrderFailed.slug || anyOrderFailed.conditionId || ''}`, meta: { conditionId: anyOrderFailed.conditionId, orderId: anyOrderFailed.orderId || null, orderStatus: anyOrderFailed.orderStatus } });
            if (w.counters.orderFailed >= w.thresholds.orderFailedStops) {
                this.stopCryptoAllWatchdog({ reason: 'order_failed', stopAuto: true });
                return;
            }
        } else {
            w.counters.orderFailed = 0;
        }

        const recent = this.orderHistory
            .filter((e: any) => e && String(e?.action || '') === 'cryptoall_order')
            .filter((e: any) => {
                const ts = Date.parse(String(e?.timestamp || ''));
                return Number.isFinite(ts) ? (now - ts) <= 10 * 60_000 : true;
            });
        const dupCounts = new Map<string, number>();
        for (const e of recent) {
            const res0 = Array.isArray(e?.results) && e.results.length ? e.results[0] : null;
            const orderStatus = String(res0?.orderStatus || '').toLowerCase();
            if (orderStatus.startsWith('skipped:')) continue;
            const ok = res0?.success === true;
            const orderId = res0?.orderId != null ? String(res0.orderId) : '';
            if (!(ok || orderId)) continue;
            const key = String(e?.marketId || e?.slug || '').trim();
            if (!key) continue;
            dupCounts.set(key, (dupCounts.get(key) || 0) + 1);
        }
        const dup = Array.from(dupCounts.entries()).find(([, c]) => c >= 2) || null;
        if (dup) {
            const [key, count] = dup;
            w.issues.push({ at: new Date().toISOString(), type: 'duplicate_order', message: `${key} count=${count} (10m)`, meta: { key, count } });
            this.stopCryptoAllWatchdog({ reason: 'duplicate_order', stopAuto: true });
            return;
        }

        for (const [cid, inflight] of this.redeemInFlight.entries()) {
            if (!inflight || inflight.status !== 'submitted') continue;
            const subAt = Date.parse(String(inflight.submittedAt || ''));
            if (!Number.isFinite(subAt)) continue;
            if (now - subAt <= w.thresholds.redeemSubmittedTimeoutMs) continue;
            w.issues.push({ at: new Date().toISOString(), type: 'redeem_timeout', message: `conditionId=${cid}`, meta: { submittedAt: inflight.submittedAt, transactionId: inflight.transactionId || null } });
            this.stopCryptoAllWatchdog({ reason: 'redeem_timeout', stopAuto: true });
            return;
        }
    }

    private cryptoAllWriteWatchdogReport(stopReason: string) {
        const w = this.cryptoAllWatchdog;
        const baseDir = this.orderHistoryPath ? path.dirname(this.orderHistoryPath) : path.join(os.tmpdir(), 'polymarket-tools');
        const dir = path.join(baseDir, 'cryptoall-watchdog');
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const jsonPath = path.join(dir, `cryptoall_watchdog_report_${stamp}.json`);
        const mdPath = path.join(dir, `cryptoall_watchdog_report_${stamp}.md`);
        const status = this.getCryptoAllStatus();
        const watchdogStatus = this.getCryptoAllWatchdogStatus();
        const autoRedeemStatus = this.getAutoRedeemStatus();
        const report = {
            generatedAt: new Date().toISOString(),
            stopReason: stopReason,
            watchdog: watchdogStatus,
            cryptoAllStatus: status,
            autoRedeemStatus,
            issues: w.issues.slice(-200),
        };
        const md = [
            `# CryptoAll Watchdog Report`,
            ``,
            `- generatedAt: ${report.generatedAt}`,
            `- stopReason: ${stopReason}`,
            `- watchdog: ${watchdogStatus.running ? 'RUNNING' : 'STOPPED'}`,
            `- startedAt: ${watchdogStatus.startedAt || '-'}`,
            `- endsAt: ${watchdogStatus.endsAt || '-'}`,
            `- lastTickAt: ${watchdogStatus.lastTickAt || '-'}`,
            `- lastError: ${watchdogStatus.lastError || '-'}`,
            `- issuesCount: ${watchdogStatus.issuesCount}`,
            ``,
            `## Last Issue`,
            ``,
            '```json',
            JSON.stringify(watchdogStatus.lastIssue || null, null, 2),
            '```',
            ``,
            `## Auto Redeem`,
            ``,
            '```json',
            JSON.stringify(autoRedeemStatus, null, 2),
            '```',
        ].join('\n');
        fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), { encoding: 'utf8', mode: 0o600 });
        fs.writeFileSync(mdPath, md, { encoding: 'utf8', mode: 0o600 });
        w.reportPaths = { json: jsonPath, md: mdPath };
    }

    private async refreshCryptoAllMarketSnapshot(params: { symbols: string[]; timeframes: Array<'5m' | '15m' | '1h' | '4h' | '1d'>; limit: number }) {
        const key = JSON.stringify({ symbols: params.symbols.slice().sort(), timeframes: params.timeframes.slice().sort(), limit: params.limit });
        if (this.cryptoAllMarketInFlight) return this.cryptoAllMarketInFlight;
        if ((this.cryptoAllMarketSnapshot as any).key === key && this.cryptoAllMarketSnapshot.atMs && Date.now() - this.cryptoAllMarketSnapshot.atMs < 5_000) return;
        if (this.cryptoAllMarketNextAllowedAtMs && Date.now() < this.cryptoAllMarketNextAllowedAtMs) return;
        this.cryptoAllMarketInFlight = (async () => {
            this.cryptoAllMarketSnapshot = { ...this.cryptoAllMarketSnapshot, lastAttemptAtMs: Date.now(), lastAttemptError: null };
            try {
                const symbols = params.symbols;
                const timeframes = params.timeframes;
                const limit = params.limit;
                const now = Date.now();
                const effectiveSymbols = symbols.length ? symbols.slice() : ['BTC', 'ETH', 'SOL', 'XRP'];
                const effectiveTimeframes = timeframes.length ? timeframes.slice() : ['15m', '1h', '4h', '1d'];
                const maxMarketsCap = Math.max(1, effectiveSymbols.length * effectiveTimeframes.length);
                const maxSlugsPerTf = Math.max(24, Math.min(120, Math.max(8, maxMarketsCap) * 2));
                const currentGraceMs = 90_000;
                const isCurrentMarket = (tf: '5m' | '15m' | '1h' | '4h' | '1d', endMs: number, nowMs: number) => {
                    const tfSec = this.getCryptoAllTimeframeSec(tf);
                    const windowMs = tfSec * 1000 + currentGraceMs;
                    return Number.isFinite(endMs) && endMs > nowMs && (endMs - nowMs) <= windowMs;
                };
                const marketRefs: Array<{
                    timeframe: '5m' | '15m' | '1h' | '4h' | '1d';
                    timeframeSec: number;
                    slug: string;
                    conditionId: string;
                    symbol: 'BTC' | 'ETH' | 'SOL' | 'XRP';
                    question: string;
                    endMs: number;
                    upTokenId: string;
                    downTokenId: string;
                }> = [];
                const diag: any = { atMs: Date.now(), key, perTf: {} as any };
                const parseStartSecFromSlug = (slug: string): number | null => {
                    const m = String(slug || '').trim().toLowerCase().match(/-(\d{9,12})$/);
                    if (!m) return null;
                    const sec = Number(m[1]);
                    return Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : null;
                };
                const parseEndMsFromMarket = (m: any): number => {
                    const endIso =
                        m?.endDate ?? m?.end_date ?? m?.endDateIso ?? m?.end_date_iso
                        ?? m?.umaEndDate ?? m?.uma_end_date ?? m?.umaEndDateIso ?? m?.uma_end_date_iso
                        ?? null;
                    return endIso ? Date.parse(String(endIso)) : NaN;
                };

                const pickOnePerSymbolFromSlugs = (tf: '5m' | '15m' | '1h' | '4h' | '1d', slugsRaw: any[], wantedSymbols: string[]): string[] => {
                    const out: string[] = [];
                    const seenSym = new Set<string>();
                    const targets = Array.from(new Set((wantedSymbols || []).map((x) => String(x || '').toUpperCase()).filter(Boolean)));
                    for (const raw of slugsRaw || []) {
                        const slug = String(raw || '').trim().toLowerCase();
                        if (!slug) continue;
                        const sym = this.inferCryptoSymbolFromText(slug, '');
                        if (!sym) continue;
                        if (!targets.includes(sym)) continue;
                        if (seenSym.has(sym)) continue;
                        seenSym.add(sym);
                        out.push(slug);
                        if (seenSym.size >= targets.length) break;
                    }
                    return out;
                };

                for (const tf of effectiveTimeframes as Array<'5m' | '15m' | '1h' | '4h' | '1d'>) {
                    const timeframeSec = this.getCryptoAllTimeframeSec(tf);
                    const paths = this.getCryptoAllListPaths(tf);
                    const nowSec = Math.floor(now / 1000);
                    const tfLimit = Math.max(12, Math.min(60, maxSlugsPerTf));
                    const tfDiag: any = { predictedCount: 0, sitePaths: paths, siteSlugsCount: 0, wantedSlugs: [] as string[], addedSite: 0, addedPredicted: 0, currentWindowSec: timeframeSec + Math.floor(currentGraceMs / 1000), foundSymbols: [] as string[], missingSymbols: [] as string[] };
                    const parseAndAppend = async (slugs: string[]) => {
                        const settled = await Promise.allSettled(Array.from(new Set(slugs)).slice(0, tfLimit).map(async (slug) => {
                            const gamma = await this.fetchGammaJson(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}&limit=1`);
                            const list = Array.isArray(gamma) ? gamma : [];
                            return { slug, m: list[0] };
                        }));
                        for (const r of settled) {
                            try {
                                if (r.status !== 'fulfilled') continue;
                                const slug = r.value.slug;
                                const m: any = r.value.m;
                                if (!m) continue;
                                const conditionId = String(m?.conditionId ?? m?.condition_id ?? '').trim();
                                if (!conditionId || !conditionId.startsWith('0x')) continue;
                                const q = String(m?.question ?? m?.title ?? '').trim();
                                const inferredTf = this.inferCryptoTimeframeFromSlug(slug, q);
                                if (!/up\s*or\s*down/i.test(q)) continue;
                                if (inferredTf && inferredTf !== tf) continue;
                                if (!inferredTf && (tf === '5m' || tf === '15m') && !this.matchesCryptoAllTimeframe(tf, slug, q)) continue;
                                const sym = this.inferCryptoSymbolFromText(slug, q);
                                if (!sym) continue;
                                if (symbols.length && !symbols.includes(sym)) continue;

                                const endMs = parseEndMsFromMarket(m);
                                if (!Number.isFinite(endMs)) continue;
                                if (endMs <= now) continue;
                                if (!isCurrentMarket(tf, endMs, now)) continue;

                                const outcomes = this.tryParseJsonArray(m?.outcomes);
                                const tokenIds = this.tryParseJsonArray(m?.clobTokenIds ?? m?.clob_token_ids ?? null);
                                if (!Array.isArray(outcomes) || !Array.isArray(tokenIds) || outcomes.length < 2 || tokenIds.length < 2) continue;
                                const upIdx = outcomes.findIndex((o: any) => String(o || '').toLowerCase().includes('up'));
                                const downIdx = outcomes.findIndex((o: any) => String(o || '').toLowerCase().includes('down'));
                                if (upIdx < 0 || downIdx < 0) continue;
                                const upTokenId = String(tokenIds[upIdx] || '').trim();
                                const downTokenId = String(tokenIds[downIdx] || '').trim();
                                if (!upTokenId || !downTokenId) continue;

                                marketRefs.push({ timeframe: tf, timeframeSec, slug, conditionId, symbol: sym, question: q, endMs, upTokenId, downTokenId });
                                if (marketRefs.length >= limit * 8) return;
                            } catch {
                            }
                        }
                    };
                    const settledPaths = await Promise.allSettled(paths.slice(0, 2).map((p) => this.fetchCryptoSlugsFromSitePath(p, maxSlugsPerTf)));
                    const slugsFromSite = settledPaths.flatMap((r: any) => (r.status === 'fulfilled' && Array.isArray(r.value)) ? r.value : []);
                    tfDiag.siteSlugsCount = Array.isArray(slugsFromSite) ? slugsFromSite.length : 0;
                    const symbolsForTf = effectiveSymbols;
                    const predicted = this.predictCryptoAllSlugs(tf, nowSec, symbolsForTf);
                    tfDiag.predictedCount = predicted.length;
                    const wantedSite = await (async () => {
                        const siteCandidateCap = tf === '1d' ? 80 : tf === '4h' ? 60 : tf === '1h' ? 50 : 40;
                        const out: string[] = [];
                        for (const sym of symbolsForTf) {
                            const symUpper = String(sym || '').toUpperCase();
                            const candidates = (slugsFromSite || [])
                                .map((x: any) => String(x || '').trim().toLowerCase())
                                .filter((s: string) => !!s)
                                .filter((s: string) => this.inferCryptoSymbolFromText(s, '') === symUpper)
                                .slice(0, siteCandidateCap);
                            let best: { slug: string; endMs: number } | null = null;
                            for (const slug of candidates) {
                                const gamma = await this.fetchGammaJson(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}&limit=1`).catch(() => null);
                                const list = Array.isArray(gamma) ? gamma : [];
                                const m = list[0] || null;
                                if (!m) continue;
                                const q = String((m as any)?.question ?? (m as any)?.title ?? '').trim();
                                const inferredTf = this.inferCryptoTimeframeFromSlug(slug, q);
                                if (!/up\s*or\s*down/i.test(q)) continue;
                                if (inferredTf && inferredTf !== tf) continue;
                                if (!inferredTf && (tf === '5m' || tf === '15m') && !this.matchesCryptoAllTimeframe(tf, slug, q)) continue;
                                const endMs = parseEndMsFromMarket(m);
                                if (!Number.isFinite(endMs) || endMs <= now) continue;
                                if (!isCurrentMarket(tf, endMs, now)) continue;
                                if (!best || endMs < best.endMs) best = { slug, endMs };
                            }
                            if (best?.slug) out.push(best.slug);
                        }
                        return out;
                    })();
                    const wantSet = new Set<string>(wantedSite);
                    const wantedPred: string[] = [];
                    if (wantSet.size < symbolsForTf.length) {
                        const seen = new Set<string>();
                        for (const s of wantedSite) {
                            const sym = this.inferCryptoSymbolFromText(s, '');
                            if (sym) seen.add(sym);
                        }
                        const bySym = new Map<string, string[]>();
                        for (const raw of predicted) {
                            const slug = String(raw || '').trim().toLowerCase();
                            const sym = this.inferCryptoSymbolFromText(slug, '');
                            if (!sym) continue;
                            if (!bySym.has(sym)) bySym.set(sym, []);
                            bySym.get(sym)!.push(slug);
                        }
                        for (const sym of symbolsForTf) {
                            const ss = String(sym || '').toUpperCase();
                            if (seen.has(ss)) continue;
                            const arr = bySym.get(ss) || [];
                            const windowMs2 = timeframeSec * 1000 + currentGraceMs;
                            const candidates = arr
                                .map((slug) => {
                                    const startSec = parseStartSecFromSlug(slug);
                                    const endMs = startSec != null ? (startSec + timeframeSec) * 1000 : NaN;
                                    return { slug, startSec, endMs };
                                })
                                .filter((x) => x.startSec != null && Number.isFinite(x.endMs) && x.endMs > now && (x.endMs - now) <= windowMs2)
                                .sort((a, b) => Number(a.endMs) - Number(b.endMs))
                                .slice(0, 10);
                            let picked: string | null = null;
                            for (const c of candidates) {
                                const gamma = await this.fetchGammaJson(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(c.slug)}&limit=1`).catch(() => null);
                                const list = Array.isArray(gamma) ? gamma : [];
                                const m = list[0] || null;
                                if (!m) continue;
                                const q = String((m as any)?.question ?? (m as any)?.title ?? '').trim();
                                const inferredTf = this.inferCryptoTimeframeFromSlug(c.slug, q);
                                if (!/up\s*or\s*down/i.test(q)) continue;
                                if (inferredTf && inferredTf !== tf) continue;
                                if (!inferredTf && (tf === '5m' || tf === '15m') && !this.matchesCryptoAllTimeframe(tf, c.slug, q)) continue;
                                const s2 = this.inferCryptoSymbolFromText(c.slug, q);
                                if (!s2 || s2 !== ss) continue;
                                const endMs = parseEndMsFromMarket(m);
                                if (!Number.isFinite(endMs) || endMs <= now) continue;
                                if (!isCurrentMarket(tf, endMs, now)) continue;
                                picked = c.slug;
                                break;
                            }
                            if (picked) {
                                wantedPred.push(picked);
                                seen.add(ss);
                            }
                        }
                    }
                    const wanted = Array.from(new Set([...wantedSite, ...wantedPred])).slice(0, symbolsForTf.length * 2);
                    tfDiag.wantedSlugs = wanted.slice();
                    const before = marketRefs.length;
                    await parseAndAppend(wanted);
                    const haveSyms = new Set<string>();
                    for (const mr of marketRefs) {
                        if (!mr || String(mr.timeframe) !== tf) continue;
                        haveSyms.add(String(mr.symbol || '').toUpperCase());
                    }
                    const missingSyms = new Set<string>(symbolsForTf.filter((s) => !haveSyms.has(String(s).toUpperCase())));
                    if (missingSyms.size) {
                        const pageSize = 200;
                        const maxPages = 8;
                        for (let page = 0; page < maxPages && missingSyms.size; page++) {
                            const offset = page * pageSize;
                            const url = `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=${pageSize}&offset=${offset}`;
                            const markets = await this.fetchGammaJson(url).catch(() => null);
                            const list = Array.isArray(markets) ? markets : [];
                            if (!list.length) break;
                            for (const m of list) {
                                const slug = String((m as any)?.slug || '').trim();
                                const q = String((m as any)?.question ?? (m as any)?.title ?? '').trim();
                                if (!slug && !q) continue;
                                if (!/up\s*or\s*down/i.test(q)) continue;
                                const inferredTf = this.inferCryptoTimeframeFromSlug(slug, q);
                                if (inferredTf && inferredTf !== tf) continue;
                                if (!inferredTf && (tf === '5m' || tf === '15m') && !this.matchesCryptoAllTimeframe(tf, slug, q)) continue;
                                const sym = this.inferCryptoSymbolFromText(slug, q);
                                if (!sym || !missingSyms.has(sym)) continue;
                                const conditionId = String((m as any)?.conditionId ?? (m as any)?.condition_id ?? '').trim();
                                if (!conditionId || !conditionId.startsWith('0x')) continue;
                                const endMs = parseEndMsFromMarket(m);
                                if (!Number.isFinite(endMs) || endMs <= now) continue;
                                if (!isCurrentMarket(tf, endMs, now)) continue;
                                const outcomes = this.tryParseJsonArray((m as any)?.outcomes);
                                const tokenIds = this.tryParseJsonArray((m as any)?.clobTokenIds ?? (m as any)?.clob_token_ids ?? null);
                                if (!Array.isArray(outcomes) || !Array.isArray(tokenIds) || outcomes.length < 2 || tokenIds.length < 2) continue;
                                const upIdx = outcomes.findIndex((o: any) => String(o || '').toLowerCase().includes('up'));
                                const downIdx = outcomes.findIndex((o: any) => String(o || '').toLowerCase().includes('down'));
                                if (upIdx < 0 || downIdx < 0) continue;
                                const upTokenId = String(tokenIds[upIdx] || '').trim();
                                const downTokenId = String(tokenIds[downIdx] || '').trim();
                                if (!upTokenId || !downTokenId) continue;
                                marketRefs.push({ timeframe: tf, timeframeSec, slug, conditionId, symbol: sym, question: q, endMs, upTokenId, downTokenId });
                                missingSyms.delete(sym);
                                if (!missingSyms.size) break;
                            }
                            if (list.length < pageSize) break;
                        }
                    }
                    if (missingSyms.size) {
                        const tagId = await this.resolveCryptoTagId();
                        if (tagId) {
                            const pageSize = 50;
                            const maxPages = 6;
                            for (let page = 0; page < maxPages && missingSyms.size; page++) {
                                const events = await this.fetchGammaCryptoEvents(tagId, pageSize, page * pageSize).catch(() => []);
                                if (!Array.isArray(events) || !events.length) break;
                                for (const ev of events) {
                                    const evSlug = String((ev as any)?.slug || '').trim();
                                    const evTitle = String((ev as any)?.title || (ev as any)?.question || '').trim();
                                    const evEndIso = (ev as any)?.endDate ?? (ev as any)?.endDateIso ?? (ev as any)?.end_date ?? (ev as any)?.end_date_iso ?? null;
                                    const markets = Array.isArray((ev as any)?.markets) ? (ev as any).markets : [];
                                    for (const m of markets) {
                                        const slug = String((m as any)?.slug || (m as any)?.marketSlug || evSlug || '').trim();
                                        const q = String((m as any)?.question ?? (m as any)?.title ?? evTitle ?? '').trim();
                                        if (!slug && !q) continue;
                                        if (!/up\s*or\s*down/i.test(q)) continue;
                                        const inferredTf = this.inferCryptoTimeframeFromSlug(slug, q);
                                        if (inferredTf && inferredTf !== tf) continue;
                                        if (!inferredTf && (tf === '5m' || tf === '15m') && !this.matchesCryptoAllTimeframe(tf, slug, q)) continue;
                                        const sym = this.inferCryptoSymbolFromText(slug, q);
                                        if (!sym || !missingSyms.has(sym)) continue;
                                        const conditionId = String((m as any)?.conditionId ?? (m as any)?.condition_id ?? '').trim();
                                        if (!conditionId || !conditionId.startsWith('0x')) continue;
                                        const endMs = Number.isFinite(parseEndMsFromMarket(m)) ? parseEndMsFromMarket(m) : (evEndIso ? Date.parse(String(evEndIso)) : NaN);
                                        if (!Number.isFinite(endMs) || endMs <= now) continue;
                                        if (!isCurrentMarket(tf, endMs, now)) continue;
                                        const outcomes = this.tryParseJsonArray((m as any)?.outcomes);
                                        const tokenIds = this.tryParseJsonArray((m as any)?.clobTokenIds ?? (m as any)?.clob_token_ids ?? null);
                                        if (!Array.isArray(outcomes) || !Array.isArray(tokenIds) || outcomes.length < 2 || tokenIds.length < 2) continue;
                                        const upIdx = outcomes.findIndex((o: any) => String(o || '').toLowerCase().includes('up'));
                                        const downIdx = outcomes.findIndex((o: any) => String(o || '').toLowerCase().includes('down'));
                                        if (upIdx < 0 || downIdx < 0) continue;
                                        const upTokenId = String(tokenIds[upIdx] || '').trim();
                                        const downTokenId = String(tokenIds[downIdx] || '').trim();
                                        if (!upTokenId || !downTokenId) continue;
                                        marketRefs.push({ timeframe: tf, timeframeSec, slug, conditionId, symbol: sym, question: q, endMs, upTokenId, downTokenId });
                                        missingSyms.delete(sym);
                                        if (!missingSyms.size) break;
                                    }
                                    if (!missingSyms.size) break;
                                }
                            }
                        }
                    }
                    tfDiag.addedSite = wantedSite.length;
                    tfDiag.addedPredicted = wantedPred.length;
                    tfDiag.foundSymbols = Array.from(haveSyms.values()).sort();
                    tfDiag.missingSymbols = Array.from(missingSyms.values()).sort();
                    (diag.perTf as any)[tf] = tfDiag;
                }

                const nowMs = Date.now();
                const uniqMarketRefsAll = Array.from(new Map(marketRefs.map((m) => [`${m.timeframe}:${m.conditionId}`, m])).values())
                    .filter((m: any) => m && isCurrentMarket(String(m.timeframe) as any, Number(m.endMs), nowMs));
                const perTfSym = new Map<string, any>();
                for (const m of uniqMarketRefsAll) {
                    if (!m) continue;
                    const k = `${String(m.timeframe)}:${String(m.symbol)}`;
                    const prev = perTfSym.get(k);
                    if (!prev || Number(m.endMs) < Number(prev.endMs)) perTfSym.set(k, m);
                }
                const uniqMarketRefs = Array.from(perTfSym.values());
                const prevMarketsAll = Array.isArray(this.cryptoAllMarketSnapshot.markets) ? this.cryptoAllMarketSnapshot.markets : [];
                if (!uniqMarketRefs.length && prevMarketsAll.length) {
                    (this.cryptoAllMarketSnapshot as any).key = key;
                    this.cryptoAllMarketSnapshot = { ...this.cryptoAllMarketSnapshot, lastAttemptError: 'empty_market_snapshot' };
                    (this.cryptoAllMarketSnapshot as any).diag = { ...diag, warning: 'empty_market_snapshot' };
                    return;
                }
                const mergedMap = new Map<string, any>();
                for (const pm of prevMarketsAll) {
                    if (!pm) continue;
                    const endMs = Number((pm as any).endMs || 0);
                    const tf = String((pm as any).timeframe || '') as any;
                    if (!isCurrentMarket(tf, endMs, nowMs)) continue;
                    const k = `${String((pm as any).timeframe || '')}:${String((pm as any).conditionId || '')}`;
                    if (!k.endsWith(':')) mergedMap.set(k, { ...(pm as any), _lastSeenAtMs: Number((pm as any)._lastSeenAtMs || this.cryptoAllMarketSnapshot.atMs || nowMs) });
                }
                for (const m of uniqMarketRefs) {
                    if (!m) continue;
                    const endMs = Number((m as any).endMs || 0);
                    if (!isCurrentMarket(String((m as any).timeframe || '') as any, endMs, nowMs)) continue;
                    const k = `${String((m as any).timeframe || '')}:${String((m as any).conditionId || '')}`;
                    const prev = mergedMap.get(k) || {};
                    mergedMap.set(k, { ...prev, ...(m as any), _lastSeenAtMs: nowMs });
                }
                const mergedAll = Array.from(mergedMap.values()).filter((m: any) => isCurrentMarket(String(m?.timeframe || '') as any, Number(m?.endMs || 0), nowMs));
                const perTfSymMerged = new Map<string, any>();
                for (const m of mergedAll) {
                    if (!m) continue;
                    const tf = String((m as any).timeframe || '').toLowerCase();
                    const sym = String((m as any).symbol || '').toUpperCase();
                    if (!tf || !sym) continue;
                    const k = `${tf}:${sym}`;
                    const prev = perTfSymMerged.get(k);
                    if (!prev || Number((m as any).endMs || 0) < Number((prev as any).endMs || 0)) perTfSymMerged.set(k, m);
                }
                const merged = Array.from(perTfSymMerged.values())
                    .sort((a: any, b: any) => (Number(a?.endMs) || 0) - (Number(b?.endMs) || 0))
                    .slice(0, Math.max(1, Math.min(800, maxMarketsCap)));
                (this.cryptoAllMarketSnapshot as any).key = key;
                this.cryptoAllMarketSnapshot = { ...this.cryptoAllMarketSnapshot, atMs: nowMs, markets: merged, lastError: null, lastAttemptError: null };
                (this.cryptoAllMarketSnapshot as any).diag = diag;
                this.cryptoAllMarketBackoffMs = 0;
                this.cryptoAllMarketNextAllowedAtMs = 0;
            } catch (e: any) {
                const msg = e?.message || String(e);
                const next = this.cryptoAllMarketBackoffMs ? Math.min(30_000, this.cryptoAllMarketBackoffMs * 2) : 1000;
                this.cryptoAllMarketBackoffMs = next;
                this.cryptoAllMarketNextAllowedAtMs = Date.now() + next;
                this.cryptoAllMarketSnapshot = { ...this.cryptoAllMarketSnapshot, lastError: msg, lastAttemptError: msg };
                (this.cryptoAllMarketSnapshot as any).diag = { atMs: Date.now(), key, error: msg };
            } finally {
                this.cryptoAllMarketInFlight = null;
            }
        })();
        return this.cryptoAllMarketInFlight;
    }

    private async refreshCryptoAllBooksSnapshot(params: { symbols: string[]; timeframes: Array<'5m' | '15m' | '1h' | '4h' | '1d'>; limit: number }) {
        const key = JSON.stringify({ symbols: params.symbols.slice().sort(), timeframes: params.timeframes.slice().sort(), limit: params.limit });
        if (this.cryptoAllBooksInFlight) return this.cryptoAllBooksInFlight;
        if ((this.cryptoAllBooksSnapshot as any).key === key && this.cryptoAllBooksSnapshot.atMs && Date.now() - this.cryptoAllBooksSnapshot.atMs < 500) return;
        if (this.cryptoAllBooksNextAllowedAtMs && Date.now() < this.cryptoAllBooksNextAllowedAtMs) return;
        this.cryptoAllBooksInFlight = (async () => {
            this.cryptoAllBooksSnapshot = { ...this.cryptoAllBooksSnapshot, lastAttemptAtMs: Date.now(), lastAttemptError: null };
            try {
                const marketsAll = Array.isArray(this.cryptoAllMarketSnapshot.markets) ? this.cryptoAllMarketSnapshot.markets : [];
                const markets = marketsAll
                    .filter((m: any) => m && (!params.timeframes.length || params.timeframes.includes(String(m?.timeframe || '').toLowerCase() as any)) && (!params.symbols.length || params.symbols.includes(String(m?.symbol || '').toUpperCase())))
                    .sort((a: any, b: any) => (Number(a?.endMs) || 0) - (Number(b?.endMs) || 0))
                    .slice(0, Math.max(1, Math.min(60, Math.floor(Number(params.limit) || 0))));
                const tokenIds: string[] = [];
                const seen = new Set<string>();
                for (const m of markets) {
                    const up = String(m?.upTokenId || '').trim();
                    const down = String(m?.downTokenId || '').trim();
                    if (up && !seen.has(up)) { tokenIds.push(up); seen.add(up); }
                    if (down && !seen.has(down)) { tokenIds.push(down); seen.add(down); }
                    if (tokenIds.length >= Math.max(2, Math.floor(Number(params.limit) || 0) * 2)) break;
                }
                if (!tokenIds.length) {
                    (this.cryptoAllBooksSnapshot as any).key = key;
                    const msg = markets.length ? 'missing_token_ids_in_market_snapshot' : null;
                    this.cryptoAllBooksSnapshot = { ...this.cryptoAllBooksSnapshot, atMs: Date.now(), byTokenId: {}, lastError: msg, lastAttemptError: msg };
                    return;
                }
                let books: any[] = [];
                try {
                    books = await this.fetchClobBooks(tokenIds);
                } catch {
                    const concurrency = 8;
                    const out: any[] = [];
                    for (let i = 0; i < tokenIds.length; i += concurrency) {
                        const chunk = tokenIds.slice(i, i + concurrency);
                        const settled = await Promise.allSettled(chunk.map(async (tid) => {
                            const ob = await this.sdk.clobApi.getOrderbook(tid);
                            return { asset_id: tid, asks: Array.isArray((ob as any)?.asks) ? (ob as any).asks : [], bids: Array.isArray((ob as any)?.bids) ? (ob as any).bids : [], timestamp: (ob as any)?.timestamp ?? null };
                        }));
                        for (const r of settled) {
                            if (r.status === 'fulfilled') out.push((r as any).value);
                        }
                    }
                    books = out;
                }
                if (!Array.isArray(books) || books.length === 0) {
                    throw new Error(`No orderbooks (tokenIds=${tokenIds.length})`);
                }
                const byTokenId: Record<string, any> = {};
                for (const b of books) {
                    const tokenId = String((b as any)?.asset_id || (b as any)?.assetId || '').trim();
                    if (!tokenId) continue;
                    const asks = Array.isArray((b as any)?.asks) ? (b as any).asks : [];
                    const bids = Array.isArray((b as any)?.bids) ? (b as any).bids : [];
                    let bestAsk = NaN;
                    for (const a of asks) {
                        const p = Number(a?.price);
                        if (!Number.isFinite(p) || p <= 0) continue;
                        if (!Number.isFinite(bestAsk) || p < bestAsk) bestAsk = p;
                    }
                    let bestBid = NaN;
                    for (const bb of bids) {
                        const p = Number(bb?.price);
                        if (!Number.isFinite(p) || p <= 0) continue;
                        if (!Number.isFinite(bestBid) || p > bestBid) bestBid = p;
                    }
                    byTokenId[tokenId] = {
                        tokenId,
                        timestamp: (b as any)?.timestamp ?? null,
                        asksCount: asks.length,
                        bidsCount: bids.length,
                        bestAsk: Number.isFinite(bestAsk) ? bestAsk : null,
                        bestBid: Number.isFinite(bestBid) ? bestBid : null,
                    };
                }
                for (const t of tokenIds) {
                    if (!byTokenId[t]) byTokenId[t] = { tokenId: t, timestamp: null, asksCount: 0, bidsCount: 0, bestAsk: null, bestBid: null, error: 'missing' };
                }
                (this.cryptoAllBooksSnapshot as any).key = key;
                this.cryptoAllBooksSnapshot = { ...this.cryptoAllBooksSnapshot, atMs: Date.now(), byTokenId, lastError: null, lastAttemptError: null };
                this.cryptoAllBooksBackoffMs = 0;
                this.cryptoAllBooksNextAllowedAtMs = 0;
            } catch (e: any) {
                const msg = e?.message || String(e);
                const next = this.cryptoAllBooksBackoffMs ? Math.min(30_000, this.cryptoAllBooksBackoffMs * 2) : 1000;
                this.cryptoAllBooksBackoffMs = next;
                this.cryptoAllBooksNextAllowedAtMs = Date.now() + next;
                this.cryptoAllBooksSnapshot = { ...this.cryptoAllBooksSnapshot, lastError: msg, lastAttemptError: msg };
            } finally {
                this.cryptoAllBooksInFlight = null;
            }
        })();
        return this.cryptoAllBooksInFlight;
    }

    private async computeCryptoAllRisk(options: {
        symbol: string;
        timeframeSec: number;
        endMs: number;
        direction: 'Up' | 'Down';
        beat: { priceToBeat: number | null; currentPrice: number | null; deltaAbs: number | null; error: string | null };
        book: { bestAsk: number | null; bestBid: number | null; asksCount?: number; bidsCount?: number } | null;
    }): Promise<{ riskScore: number | null; dojiLikely: boolean | null; wickRatio: number | null; bodyRatio: number | null; retraceRatio: number | null; marginPct: number | null; momentum3m: number | null; spread: number | null; reasons: Array<{ k: string; score: number; v?: any }>; error: string | null }> {
        const symbol = String(options.symbol || '').toUpperCase();
        const tfSec = Number(options.timeframeSec) || 0;
        const endMs = Number(options.endMs) || 0;
        const direction = options.direction;
        const beat = options.beat || { priceToBeat: null, currentPrice: null, deltaAbs: null, error: 'Missing beat' };
        const book = options.book || null;
        if (!symbol || !tfSec || !endMs) return { riskScore: null, dojiLikely: null, wickRatio: null, bodyRatio: null, retraceRatio: null, marginPct: null, momentum3m: null, spread: null, reasons: [], error: 'Missing symbol/timeframe/endMs' };
        const binSymbol = this.getBinanceSymbol(symbol);
        if (!binSymbol) return { riskScore: null, dojiLikely: null, wickRatio: null, bodyRatio: null, retraceRatio: null, marginPct: null, momentum3m: null, spread: null, reasons: [], error: 'Unsupported symbol' };
        const startMsRaw = endMs - Math.floor(tfSec) * 1000;
        const startMs = Math.floor(startMsRaw / 60_000) * 60_000;
        const candle = await this.fetchBinance1mCandleWindow({ binSymbol, startMs, minutes: Math.min(60, Math.max(1, Math.floor(tfSec / 60))) });
        const open = candle.open;
        const high = candle.high;
        const low = candle.low;
        const close = beat.currentPrice != null ? Number(beat.currentPrice) : candle.close;
        const priceToBeat = beat.priceToBeat != null ? Number(beat.priceToBeat) : open;
        const reasons: Array<{ k: string; score: number; v?: any }> = [];

        let spread: number | null = null;
        if (book?.bestAsk != null && book?.bestBid != null) {
            const s = Number(book.bestAsk) - Number(book.bestBid);
            spread = Number.isFinite(s) ? s : null;
        }

        let dojiLikely: boolean | null = null;
        let wickRatio: number | null = null;
        let bodyRatio: number | null = null;
        let retraceRatio: number | null = null;
        if (open != null && high != null && low != null && close != null) {
            const range = Number(high) - Number(low);
            if (Number.isFinite(range) && range > 0) {
                bodyRatio = Math.abs(Number(close) - Number(open)) / range;
                const upperWick = Number(high) - Math.max(Number(open), Number(close));
                const lowerWick = Math.min(Number(open), Number(close)) - Number(low);
                wickRatio = direction === 'Up' ? (upperWick / range) : (lowerWick / range);
                retraceRatio = direction === 'Up' ? ((Number(high) - Number(close)) / range) : ((Number(close) - Number(low)) / range);
                dojiLikely = bodyRatio <= 0.15;
            }
        }

        let marginPct: number | null = null;
        if (priceToBeat != null && close != null && Number.isFinite(priceToBeat) && priceToBeat !== 0) {
            const signed = (Number(close) - Number(priceToBeat)) * (direction === 'Up' ? 1 : -1);
            marginPct = signed / Number(priceToBeat);
        }

        let momentum3m: number | null = null;
        if (Array.isArray(candle.closes1m) && candle.closes1m.length >= 4) {
            const closes = candle.closes1m;
            const cur = closes[closes.length - 1];
            const prev3 = closes[closes.length - 4];
            if (Number.isFinite(cur) && Number.isFinite(prev3) && prev3 !== 0) {
                momentum3m = (cur - prev3) / prev3;
            }
        }

        let score = 0;
        if (dojiLikely === true) {
            reasons.push({ k: 'dojiLikely', score: 30, v: { bodyRatio } });
            score += 30;
        }
        if (wickRatio != null && wickRatio >= 0.5) {
            reasons.push({ k: 'wickPressure', score: 25, v: { wickRatio } });
            score += 25;
        }
        if (retraceRatio != null && retraceRatio >= 0.6) {
            reasons.push({ k: 'retrace', score: 15, v: { retraceRatio } });
            score += 15;
        }
        if (marginPct != null) {
            if (marginPct < 0) {
                reasons.push({ k: 'marginNegative', score: 35, v: { marginPct } });
                score += 35;
            } else if (marginPct < 0.0005) {
                reasons.push({ k: 'marginVeryThin', score: 30, v: { marginPct } });
                score += 30;
            } else if (marginPct < 0.001) {
                reasons.push({ k: 'marginThin', score: 20, v: { marginPct } });
                score += 20;
            }
        }
        if (momentum3m != null) {
            const signedMom = momentum3m * (direction === 'Up' ? 1 : -1);
            if (signedMom < 0) {
                reasons.push({ k: 'momentumOpposite', score: 15, v: { momentum3m } });
                score += 15;
            }
        }
        if (spread != null) {
            if (spread >= 0.02) {
                reasons.push({ k: 'spreadWide', score: 20, v: { spread } });
                score += 20;
            } else if (spread >= 0.01) {
                reasons.push({ k: 'spread', score: 10, v: { spread } });
                score += 10;
            }
        } else if (book) {
            reasons.push({ k: 'spreadMissing', score: 10 });
            score += 10;
        }

        score = Math.max(0, Math.min(100, Math.floor(score)));
        return { riskScore: score, dojiLikely, wickRatio, bodyRatio, retraceRatio, marginPct, momentum3m, spread, reasons, error: candle.error || beat.error || null };
    }

    private async buildCryptoAllCandidatesFromSnapshots(options: { symbols: string[]; timeframes: Array<'5m' | '15m' | '1h' | '4h' | '1d'>; minProb: number; expiresWithinSec: number; expiresWithinSecByTimeframe?: Record<'5m' | '15m' | '1h' | '4h' | '1d', number> | null; limit: number }) {
        const { symbols, timeframes, minProb, expiresWithinSec, expiresWithinSecByTimeframe, limit } = options;
        const precomputeExpiryBufferSec = 10;
        const now = Date.now();
        const marketsAll = Array.isArray(this.cryptoAllMarketSnapshot.markets) ? this.cryptoAllMarketSnapshot.markets : [];
        const markets = marketsAll
            .filter((m: any) => m && (!timeframes.length || timeframes.includes(String(m?.timeframe || '').toLowerCase() as any)) && (!symbols.length || symbols.includes(String(m?.symbol || '').toUpperCase())))
            .sort((a: any, b: any) => (Number(a?.endMs) || 0) - (Number(b?.endMs) || 0))
            .slice(0, Math.max(40, Math.min(220, Math.floor(Number(limit) || 0) * 2)));
        const byTokenId = this.cryptoAllBooksSnapshot.byTokenId || {};
        const candidates: any[] = [];
        for (const m of markets) {
            if (!m) continue;
            const endMs = Number(m?.endMs);
            if (!Number.isFinite(endMs)) continue;
            const secondsToExpire = Math.floor((endMs - now) / 1000);
            if (secondsToExpire <= 0) continue;

            const upBook = byTokenId[String(m?.upTokenId || '').trim()] || null;
            const downBook = byTokenId[String(m?.downTokenId || '').trim()] || null;
            const upPrice = upBook?.bestAsk != null ? Number(upBook.bestAsk) : null;
            const downPrice = downBook?.bestAsk != null ? Number(downBook.bestAsk) : null;
            const chosen =
                upPrice != null && downPrice != null ? (upPrice >= downPrice ? { outcome: 'Up', tokenId: m.upTokenId, price: upPrice } : { outcome: 'Down', tokenId: m.downTokenId, price: downPrice })
                : upPrice != null ? { outcome: 'Up', tokenId: m.upTokenId, price: upPrice }
                : downPrice != null ? { outcome: 'Down', tokenId: m.downTokenId, price: downPrice }
                : null;
            const meetsMinProb = chosen ? chosen.price >= minProb : false;
            const tf = String(m.timeframe || '15m').toLowerCase() as any;
            const expiresForTf = expiresWithinSecByTimeframe && (expiresWithinSecByTimeframe as any)[tf] != null ? Number((expiresWithinSecByTimeframe as any)[tf]) : expiresWithinSec;
            const expiresWithinSecEffective = Math.max(10, Math.floor(Number.isFinite(expiresForTf) ? expiresForTf : expiresWithinSec));
            const eligibleByExpiry = secondsToExpire <= expiresWithinSecEffective;
            const withinComputeWindow = secondsToExpire <= (expiresWithinSecEffective + precomputeExpiryBufferSec);
            const minDeltaRequired = this.getCryptoAllMinDeltaRequired(String(m.symbol || ''), String(m.timeframe || '15m').toLowerCase() as any);
            const beat = withinComputeWindow ? await this.fetchCryptoAllBeatAndCurrentFromBinance({ symbol: m.symbol, endMs: m.endMs, timeframeSec: m.timeframeSec }) : { priceToBeat: null, currentPrice: null, deltaAbs: null, error: null };
            const meetsMinDelta = withinComputeWindow ? (beat.deltaAbs != null && minDeltaRequired > 0 ? beat.deltaAbs >= minDeltaRequired : minDeltaRequired <= 0) : false;
            let risk: any = null;
            if (withinComputeWindow && chosen && chosen.outcome && beat) {
                const chosenBook = byTokenId[String(chosen.tokenId || '').trim()] || null;
                risk = await this.computeCryptoAllRisk({
                    symbol: m.symbol,
                    timeframeSec: m.timeframeSec,
                    endMs: m.endMs,
                    direction: chosen.outcome === 'Down' ? 'Down' : 'Up',
                    beat,
                    book: chosenBook ? { bestAsk: chosenBook.bestAsk ?? null, bestBid: chosenBook.bestBid ?? null, asksCount: chosenBook.asksCount, bidsCount: chosenBook.bidsCount } : null,
                }).catch((e: any) => ({ riskScore: null, dojiLikely: null, wickRatio: null, bodyRatio: null, retraceRatio: null, marginPct: null, momentum3m: null, spread: null, reasons: [], error: e?.message || String(e) }));
                if (!(this as any).cryptoAllRiskDiag) (this as any).cryptoAllRiskDiag = new Map();
                const k = `${String(m.conditionId)}:${String(chosen.tokenId)}`;
                (this as any).cryptoAllRiskDiag.set(k, { at: new Date().toISOString(), symbol: m.symbol, timeframe: m.timeframe, risk });
            }
            candidates.push({
                timeframe: m.timeframe,
                symbol: m.symbol,
                slug: m.slug,
                conditionId: m.conditionId,
                question: m.question,
                endMs: m.endMs,
                endDateIso: new Date(m.endMs).toISOString(),
                secondsToExpire,
                eligibleByExpiry,
                minProb,
                meetsMinProb,
                upPrice,
                downPrice,
                chosen: chosen ? { outcome: chosen.outcome, tokenId: chosen.tokenId, price: chosen.price } : null,
                chosenOutcome: chosen ? chosen.outcome : null,
                chosenPrice: chosen ? chosen.price : null,
                chosenTokenId: chosen ? chosen.tokenId : null,
                chosenIndex: chosen ? (chosen.outcome === 'Down' ? 1 : 0) : null,
                minDeltaRequired,
                priceToBeat: beat.priceToBeat,
                currentPrice: beat.currentPrice,
                deltaAbs: beat.deltaAbs,
                meetsMinDelta,
                deltaError: beat.error,
                riskScore: risk?.riskScore ?? null,
                dojiLikely: risk?.dojiLikely ?? null,
                wickRatio: risk?.wickRatio ?? null,
                bodyRatio: risk?.bodyRatio ?? null,
                retraceRatio: risk?.retraceRatio ?? null,
                marginPct: risk?.marginPct ?? null,
                momentum3m: risk?.momentum3m ?? null,
                spread: risk?.spread ?? null,
                riskReasons: Array.isArray(risk?.reasons) ? risk.reasons : [],
                riskError: risk?.error ?? null,
            });
        }
        candidates.sort((a, b) => {
            const ab = (a.eligibleByExpiry ? 1 : 0) - (b.eligibleByExpiry ? 1 : 0);
            if (ab !== 0) return -ab;
            const ap = (a.meetsMinProb ? 1 : 0) - (b.meetsMinProb ? 1 : 0);
            if (ap !== 0) return -ap;
            const ad = (a.meetsMinDelta ? 1 : 0) - (b.meetsMinDelta ? 1 : 0);
            if (ad !== 0) return -ad;
            const pa = a?.chosen?.price != null ? Number(a.chosen.price) : -Infinity;
            const pb = b?.chosen?.price != null ? Number(b.chosen.price) : -Infinity;
            if (pa !== pb) return pb - pa;
            const sa = a?.secondsToExpire != null ? Number(a.secondsToExpire) : Infinity;
            const sb = b?.secondsToExpire != null ? Number(b.secondsToExpire) : Infinity;
            return sa - sb;
        });
        return candidates.slice(0, limit);
    }

    async getCryptoAllCandidates(options?: { symbols?: string[] | string; timeframes?: Array<'5m' | '15m' | '1h' | '4h' | '1d'> | string; minProb?: number; expiresWithinSec?: number; expiresWithinSecByTimeframe?: any; limit?: number }) {
        const symbolsInput = options?.symbols;
        const symbolsArr =
            Array.isArray(symbolsInput) ? symbolsInput
            : typeof symbolsInput === 'string' ? symbolsInput.split(',').map((x) => x.trim()).filter(Boolean)
            : this.cryptoAllAutoConfig.symbols;
        const symbols = Array.from(new Set(symbolsArr.map((s) => String(s || '').toUpperCase()).filter(Boolean)));

        const tfsInput = options?.timeframes;
        const tfArr =
            Array.isArray(tfsInput) ? tfsInput
            : typeof tfsInput === 'string' ? tfsInput.split(',').map((x) => x.trim()).filter(Boolean) as any
            : this.cryptoAllAutoConfig.timeframes;
        const timeframes = Array.from(new Set(tfArr.map((x: any) => String(x || '').toLowerCase()).filter(Boolean))) as Array<'5m' | '15m' | '1h' | '4h' | '1d'>;

        const minProbRaw = options?.minProb != null ? Number(options.minProb) : this.cryptoAllAutoConfig.minProb;
        const expiresWithinSecRaw = options?.expiresWithinSec != null ? Number(options.expiresWithinSec) : this.cryptoAllAutoConfig.expiresWithinSec;
        const expiresWithinSecByTimeframeRaw =
            options?.expiresWithinSecByTimeframe && typeof options.expiresWithinSecByTimeframe === 'object'
                ? options.expiresWithinSecByTimeframe
                : (this.cryptoAllAutoConfig.expiresWithinSecByTimeframe || null);
        const limitRaw = options?.limit != null ? Number(options.limit) : 20;

        const minProb = Math.max(0, Math.min(1, Number.isFinite(minProbRaw) ? minProbRaw : this.cryptoAllAutoConfig.minProb));
        const expiresWithinSec = Math.max(10, Math.floor(Number.isFinite(expiresWithinSecRaw) ? expiresWithinSecRaw : this.cryptoAllAutoConfig.expiresWithinSec));
        const expiresWithinSecByTimeframe = (['5m', '15m', '1h', '4h', '1d'] as const).reduce((acc: any, tf) => {
            const v = expiresWithinSecByTimeframeRaw && (expiresWithinSecByTimeframeRaw as any)[tf] != null ? Number((expiresWithinSecByTimeframeRaw as any)[tf]) : expiresWithinSec;
            acc[tf] = Math.max(10, Math.floor(Number.isFinite(v) ? v : expiresWithinSec));
            return acc;
        }, {}) as Record<'5m' | '15m' | '1h' | '4h' | '1d', number>;
        const limit = Math.max(1, Math.min(100, Math.floor(Number.isFinite(limitRaw) ? limitRaw : 20)));

        const now = Date.now();
        const marketAt = this.cryptoAllMarketSnapshot.atMs ? Number(this.cryptoAllMarketSnapshot.atMs) : 0;
        const booksAt = this.cryptoAllBooksSnapshot.atMs ? Number(this.cryptoAllBooksSnapshot.atMs) : 0;
        const needMarket = marketAt <= 0;
        const needBooks = booksAt <= 0;
        const marketStale = !needMarket && (now - marketAt) > 5_000;
        const booksStale = !needBooks && (now - booksAt) > 1_500;

        if (needMarket) await this.refreshCryptoAllMarketSnapshot({ symbols, timeframes, limit }).catch(() => {});
        else if (marketStale) this.refreshCryptoAllMarketSnapshot({ symbols, timeframes, limit }).catch(() => {});

        if (needBooks) await this.refreshCryptoAllBooksSnapshot({ symbols, timeframes, limit }).catch(() => {});
        else if (booksStale) this.refreshCryptoAllBooksSnapshot({ symbols, timeframes, limit }).catch(() => {});
        return await this.buildCryptoAllCandidatesFromSnapshots({ symbols, timeframes, minProb, expiresWithinSec, expiresWithinSecByTimeframe, limit });
    }

    startCryptoAllAuto(config?: {
        dryRun?: boolean;
        pollMs?: number;
        expiresWithinSec?: number;
        minProb?: number;
        amountUsd?: number;
        symbols?: string[];
        timeframes?: Array<'5m' | '15m' | '1h' | '4h' | '1d'>;
        dojiGuardEnabled?: boolean;
        riskSkipScore?: number;
        riskAddOnBlockScore?: number;
        addOnEnabled?: boolean;
        addOnMultiplierA?: number;
        addOnMultiplierB?: number;
        addOnMultiplierC?: number;
        addOnAccelEnabled?: boolean;
        addOnTrendEnabled?: boolean;
        addOnTrendMinutesA?: number;
        addOnTrendMinutesB?: number;
        addOnTrendMinutesC?: number;
        addOnMaxTotalStakeUsdPerPosition?: number;
        stoplossEnabled?: boolean;
        stoplossCut1DropCents?: number;
        stoplossCut1SellPct?: number;
        stoplossCut2DropCents?: number;
        stoplossCut2SellPct?: number;
        stoplossSpreadGuardCents?: number;
        stoplossMinSecToExit?: number;
        splitBuyEnabled?: boolean;
        splitBuyPct3m?: number;
        splitBuyPct2m?: number;
        splitBuyPct1m?: number;
        splitBuyTrendEnabled?: boolean;
        splitBuyTrendMinutes3m?: number;
        splitBuyTrendMinutes2m?: number;
        splitBuyTrendMinutes1m?: number;
        adaptiveDeltaEnabled?: boolean;
        adaptiveDeltaBigMoveMultiplier?: number;
        adaptiveDeltaRevertNoBuyCount?: number;
    }) {
        if (this.autoRedeemConfig.enabled !== true) {
            this.setAutoRedeemConfig({ enabled: true, persist: true });
        }
        if (config?.dryRun != null) this.cryptoAllAutoDryRun = config.dryRun === true;
        this.updateCryptoAllConfig(config);
        this.ensureCryptoAllSplitBuyLoop();

        this.cryptoAllAutoEnabled = true;
        this.recordAutoConfigEvent('cryptoall', 'start', { enabled: true, dryRun: this.cryptoAllAutoDryRun === true, ...this.cryptoAllAutoConfig });
        this.startCryptoAllStoplossLoop();
        if (this.cryptoAllAutoTimer) {
            clearInterval(this.cryptoAllAutoTimer);
            this.cryptoAllAutoTimer = null;
        }
        const tick = async () => {
            await this.cryptoAllTryAutoOnce().catch(() => {});
        };
        setTimeout(() => tick().catch(() => null), 250);
        this.cryptoAllAutoTimer = setInterval(() => setTimeout(() => tick().catch(() => null), 250), this.cryptoAllAutoConfig.pollMs);
        return this.getCryptoAllStatus();
    }


    stopCryptoAllAuto() {
        this.cryptoAllAutoEnabled = false;
        this.recordAutoConfigEvent('cryptoall', 'stop', { enabled: false, ...this.cryptoAllAutoConfig });
        if (this.cryptoAllAutoTimer) {
            clearInterval(this.cryptoAllAutoTimer);
            this.cryptoAllAutoTimer = null;
        }
        if (this.cryptoAllStoplossTimer) {
            clearInterval(this.cryptoAllStoplossTimer);
            this.cryptoAllStoplossTimer = null;
        }
        return this.getCryptoAllStatus();
    }

    async runCryptoAllAutoOnce(options?: { dryRun?: boolean; minProb?: number; expiresWithinSec?: number; amountUsd?: number; symbols?: string[]; timeframes?: Array<'5m' | '15m' | '1h' | '4h' | '1d'> | string[] }) {
        const prevEnabled = this.cryptoAllAutoEnabled;
        const prevDryRun = this.cryptoAllAutoDryRun;
        const prevConfig = JSON.parse(JSON.stringify(this.cryptoAllAutoConfig || {}));
        try {
            this.cryptoAllAutoEnabled = true;
            if (options?.dryRun != null) this.cryptoAllAutoDryRun = options.dryRun === true;
            if (options?.minProb != null || options?.expiresWithinSec != null || options?.amountUsd != null || options?.symbols != null || options?.timeframes != null) {
                const minProbRaw = options?.minProb != null ? Number(options.minProb) : this.cryptoAllAutoConfig.minProb;
                const expiresWithinSecRaw = options?.expiresWithinSec != null ? Number(options.expiresWithinSec) : this.cryptoAllAutoConfig.expiresWithinSec;
                const amountUsdRaw = options?.amountUsd != null ? Number(options.amountUsd) : this.cryptoAllAutoConfig.amountUsd;
                const symbolsRaw = Array.isArray(options?.symbols) ? options?.symbols : this.cryptoAllAutoConfig.symbols;
                const timeframesRaw = Array.isArray(options?.timeframes) ? options?.timeframes : this.cryptoAllAutoConfig.timeframes;
                const symbols = Array.from(new Set((symbolsRaw || []).map((x: any) => String(x || '').toUpperCase()).filter(Boolean)));
                const timeframes = Array.from(new Set((timeframesRaw || []).map((x: any) => String(x || '').toLowerCase()).filter(Boolean))) as any;
                this.cryptoAllAutoConfig = {
                    ...this.cryptoAllAutoConfig,
                    minProb: Math.max(0, Math.min(1, Number.isFinite(minProbRaw) ? minProbRaw : this.cryptoAllAutoConfig.minProb)),
                    expiresWithinSec: Math.max(10, Math.floor(Number.isFinite(expiresWithinSecRaw) ? expiresWithinSecRaw : this.cryptoAllAutoConfig.expiresWithinSec)),
                    amountUsd: Math.max(1, Number.isFinite(amountUsdRaw) ? amountUsdRaw : this.cryptoAllAutoConfig.amountUsd),
                    symbols: symbols.length ? symbols : this.cryptoAllAutoConfig.symbols,
                    timeframes: timeframes.length ? timeframes : this.cryptoAllAutoConfig.timeframes,
                };
            }
            await this.cryptoAllTryAutoOnce();
            return { success: true, status: this.getCryptoAllStatus() };
        } catch (e: any) {
            return { success: false, error: e?.message || String(e), status: this.getCryptoAllStatus() };
        } finally {
            this.cryptoAllAutoEnabled = prevEnabled;
            this.cryptoAllAutoDryRun = prevDryRun;
            this.cryptoAllAutoConfig = prevConfig;
        }
    }

    private ensureCryptoAllSplitBuyLoop() {
        if (this.cryptoAllSplitBuyTimer) return;
        this.cryptoAllSplitBuyTimer = setInterval(() => {
            this.tickCryptoAllSplitBuyOnce().catch(() => {});
        }, 750);
    }

    private async tickCryptoAllSplitBuyOnce() {
        if (!this.cryptoAllSplitBuyState.size) {
            if (this.cryptoAllSplitBuyTimer) {
                clearInterval(this.cryptoAllSplitBuyTimer);
                this.cryptoAllSplitBuyTimer = null;
            }
            return;
        }
        const now = Date.now();
        for (const [k, v] of Array.from(this.cryptoAllSplitBuyState.entries())) {
            if (!v) { this.cryptoAllSplitBuyState.delete(k); continue; }
            const expiresAtMs = Number(v.expiresAtMs || 0);
            const remainingSec = Math.floor((expiresAtMs - now) / 1000);
            if (!(remainingSec > 0)) { this.cryptoAllSplitBuyState.delete(k); continue; }
            const lastAttemptAtMs = Number(v.lastAttemptAtMs || 0);
            if (now - lastAttemptAtMs < 2000) continue;
            const due3m = remainingSec <= 180 && remainingSec > 120;
            const due2m = remainingSec <= 120 && remainingSec > 60;
            const due1m = remainingSec <= 60;
            const nextLeg =
                !v.done3m && due3m ? '3m'
                : !v.done2m && due2m ? '2m'
                : !v.done1m && due1m ? '1m'
                : null;
            if (!nextLeg) continue;
            const amt = nextLeg === '3m' ? Number(v.amount3mUsd) : nextLeg === '2m' ? Number(v.amount2mUsd) : Number(v.amount1mUsd);
            if (!(amt > 0)) {
                if (nextLeg === '3m') v.done3m = true;
                if (nextLeg === '2m') v.done2m = true;
                if (nextLeg === '1m') v.done1m = true;
                v.lastAttemptAtMs = now;
                this.cryptoAllSplitBuyState.set(k, v);
                continue;
            }
            v.lastAttemptAtMs = now;
            this.cryptoAllSplitBuyState.set(k, v);
            if (this.cryptoAllAutoConfig.splitBuyTrendEnabled !== false) {
                const needUpMin =
                    nextLeg === '3m' ? this.cryptoAllAutoConfig.splitBuyTrendMinutes3m
                    : nextLeg === '2m' ? this.cryptoAllAutoConfig.splitBuyTrendMinutes2m
                    : this.cryptoAllAutoConfig.splitBuyTrendMinutes1m;
                const up = await this.isBinanceTrendOkWithSpot({ symbol: String(v.symbol || ''), minutes: needUpMin, direction: v.direction === 'Down' ? 'Down' : 'Up', allowEqual: nextLeg === '2m' || nextLeg === '1m' }).catch(() => ({ ok: false, closes: [], lastClose: null, spot: null, error: 'binance_error' }));
                if (!up.ok) continue;
            }
            const r: any = await this.placeCryptoAllOrder({
                conditionId: String(v.conditionId),
                outcomeIndex: Number(v.outcomeIndex),
                amountUsd: amt,
                minPrice: Number(v.minPrice),
                force: true,
                source: 'addon',
                symbol: v.symbol,
                timeframe: '15m',
                endDate: v.endDate,
                secondsToExpire: remainingSec,
            }).catch((e: any) => ({ success: false, error: e?.message || String(e) }));
            if (r?.success === true) {
                if (nextLeg === '3m') v.done3m = true;
                if (nextLeg === '2m') v.done2m = true;
                if (nextLeg === '1m') v.done1m = true;
                this.cryptoAllSplitBuyState.set(k, v);
            }
            if (v.done3m && v.done2m && v.done1m) {
                this.cryptoAllSplitBuyState.delete(k);
            }
        }
    }

    private async cryptoAllTryAutoOnce() {
        if (!this.cryptoAllAutoEnabled) return;
        if (Date.now() < this.cryptoAllNextScanAllowedAtMs) return;
        if (this.cryptoAllAutoInFlight) return;
        this.cryptoAllAutoInFlight = true;
        if (!this.cryptoAllAutoDryRun && !this.hasValidKey) {
            this.cryptoAllLastError = 'Missing private key';
            this.cryptoAllAutoInFlight = false;
            return;
        }
        const cleanupLocks = () => {
            const now = Date.now();
            for (const [k, v] of this.cryptoAllOrderLocks.entries()) {
                if (!v) { this.cryptoAllOrderLocks.delete(k); continue; }
                if (now > Number(v.expiresAtMs || 0) + 10 * 60_000) this.cryptoAllOrderLocks.delete(k);
                else if (now - Number(v.atMs || 0) > 60 * 60_000) this.cryptoAllOrderLocks.delete(k);
            }
        };
        try {
            cleanupLocks();
            const candidates = await this.getCryptoAllCandidates({
                minProb: this.cryptoAllAutoConfig.minProb,
                expiresWithinSec: this.cryptoAllAutoConfig.expiresWithinSec,
                limit: 5,
                symbols: this.cryptoAllAutoConfig.symbols,
            }).catch(() => []);
            this.cryptoAllLastScanAt = new Date().toISOString();
            if (!Array.isArray(candidates)) {
                this.cryptoAllAutoInFlight = false;
                return;
            }
            this.cryptoAllLastError = null;
            const decisions: any[] = [];
            for (const c of candidates) {
                const sym = String(c?.symbol || '');
                const tf = String(c?.timeframe || '');
                if (!c.meetsMinProb) { decisions.push({ symbol: sym, timeframe: tf, action: 'skip', reason: 'min_prob' }); continue; }
                if (!c.meetsMinDelta) { decisions.push({ symbol: sym, timeframe: tf, action: 'skip', reason: 'min_delta' }); continue; }
                if (!c.chosen) { decisions.push({ symbol: sym, timeframe: tf, action: 'skip', reason: 'no_chosen' }); continue; }
                if (c.riskScore >= this.cryptoAllAutoConfig.riskSkipScore) { decisions.push({ symbol: sym, timeframe: tf, action: 'skip', reason: 'risk', riskScore: c.riskScore }); continue; }
                if (this.cryptoAllAutoConfig.dojiGuardEnabled && c.dojiLikely) { decisions.push({ symbol: sym, timeframe: tf, action: 'skip', reason: 'doji' }); continue; }
                if (this.cryptoAllAutoConfig.adaptiveDeltaEnabled) {
                    const adKey = `${String(c.symbol || '').toUpperCase()}:${String(c.timeframe || '15m').toLowerCase()}`;
                    const st = this.cryptoAllAdaptiveDeltaBySymbol.get(adKey) || { overrideDelta: null, noBuyCount: 0, lastBigMoveAt: null, lastBigMoveDelta: null };
                    if (st.overrideDelta != null && Number(st.overrideDelta) > Number(c.deltaAbs)) { decisions.push({ symbol: sym, timeframe: tf, action: 'skip', reason: 'adaptive_delta', overrideDelta: st.overrideDelta, deltaAbs: c.deltaAbs }); continue; }
                }
                const lockKey = `${c.conditionId}:${c.chosen.outcome}`;
                if (this.cryptoAllOrderLocks.has(lockKey)) { decisions.push({ symbol: sym, timeframe: tf, action: 'skip', reason: 'locked', conditionId: c.conditionId }); continue; }
                this.cryptoAllOrderLocks.set(lockKey, { atMs: Date.now(), symbol: c.symbol, expiresAtMs: Date.now() + 60000, conditionId: c.conditionId, status: 'placing' });
                const orderParams: any = {
                    conditionId: c.conditionId,
                    outcomeIndex: c.chosenIndex,
                    amountUsd: this.cryptoAllAutoConfig.amountUsd,
                    minPrice: this.cryptoAllAutoConfig.minProb,
                    force: false,
                    source: 'auto',
                    symbol: c.symbol,
                    timeframe: c.timeframe,
                    endDate: c.endDateIso,
                    secondsToExpire: c.secondsToExpire,
                };
                const r: any = this.cryptoAllAutoDryRun
                    ? { success: true, dryRun: true, wouldPlaceOrder: true, params: orderParams }
                    : await this.placeCryptoAllOrder(orderParams).catch((e: any) => ({ success: false, error: e?.message || String(e) }));
                decisions.push({ symbol: sym, timeframe: tf, action: this.cryptoAllAutoDryRun ? 'would_place' : r?.success ? 'placed' : 'failed', conditionId: c.conditionId, outcome: c.chosen?.outcome ?? null, price: c.chosen?.price ?? null, dryRun: this.cryptoAllAutoDryRun === true, error: r?.error ?? null });
                if (this.cryptoAllAutoDryRun) this.cryptoAllLastScanSummary = { at: new Date().toISOString(), dryRun: true, candidatesCount: candidates.length, decisions };
                if (r?.success) {
                    this.cryptoAllOrderLocks.set(lockKey, { atMs: Date.now(), symbol: c.symbol, expiresAtMs: Date.now() + 300000, conditionId: c.conditionId, status: 'ordered' });
                    if (this.cryptoAllAutoConfig.adaptiveDeltaEnabled) {
                        const adKey = `${String(c.symbol || '').toUpperCase()}:${String(c.timeframe || '15m').toLowerCase()}`;
                        const st = this.cryptoAllAdaptiveDeltaBySymbol.get(adKey) || { overrideDelta: null, noBuyCount: 0, lastBigMoveAt: null, lastBigMoveDelta: null };
                        const baseMinDelta = this.getCryptoAllMinDeltaRequired(String(c.symbol || ''), String(c.timeframe || '15m').toLowerCase() as any);
                        if (Number(c.deltaAbs) >= baseMinDelta * this.cryptoAllAutoConfig.adaptiveDeltaBigMoveMultiplier) {
                            st.lastBigMoveAt = new Date().toISOString();
                            st.lastBigMoveDelta = Number(c.deltaAbs);
                            st.overrideDelta = Number(c.deltaAbs) * 0.8; 
                            st.noBuyCount = this.cryptoAllAutoConfig.adaptiveDeltaRevertNoBuyCount;
                            this.cryptoAllAdaptiveDeltaBySymbol.set(adKey, st);
                        } else if (st.noBuyCount > 0) {
                            st.noBuyCount--;
                            if (st.noBuyCount <= 0) st.overrideDelta = null;
                            this.cryptoAllAdaptiveDeltaBySymbol.set(adKey, st);
                        }
                    }
                    if (this.cryptoAllAutoConfig.splitBuyEnabled) {
                        const baseAmt = this.cryptoAllAutoConfig.amountUsd;
                        const amt3m = Math.floor(baseAmt * (this.cryptoAllAutoConfig.splitBuyPct3m / 100));
                        const amt2m = Math.floor(baseAmt * (this.cryptoAllAutoConfig.splitBuyPct2m / 100));
                        const amt1m = Math.floor(baseAmt * (this.cryptoAllAutoConfig.splitBuyPct1m / 100));
                        if (amt3m > 0 || amt2m > 0 || amt1m > 0) {
                            const splitKey = `${c.conditionId}:${c.chosenIndex}`;
                            this.cryptoAllSplitBuyState.set(splitKey, {
                                conditionId: c.conditionId,
                                outcomeIndex: c.chosenIndex,
                                symbol: c.symbol,
                                endDate: c.endDateIso,
                                expiresAtMs: Date.now() + c.secondsToExpire * 1000,
                                amount3mUsd: amt3m,
                                amount2mUsd: amt2m,
                                amount1mUsd: amt1m,
                                done3m: false,
                                done2m: false,
                                done1m: false,
                                lastAttemptAtMs: 0,
                                direction: c.chosenOutcome,
                                minPrice: this.cryptoAllAutoConfig.minProb,
                                stoplossConfig: this.cryptoAllAutoConfig.stoplossEnabled ? {
                                    enabled: true,
                                    cut1DropCents: this.cryptoAllAutoConfig.stoplossCut1DropCents,
                                    cut1SellPct: this.cryptoAllAutoConfig.stoplossCut1SellPct,
                                    cut2DropCents: this.cryptoAllAutoConfig.stoplossCut2DropCents,
                                    cut2SellPct: this.cryptoAllAutoConfig.stoplossCut2SellPct,
                                    minSecToExit: this.cryptoAllAutoConfig.stoplossMinSecToExit,
                                } : undefined,
                            });
                            this.ensureCryptoAllSplitBuyLoop();
                        }
                    }
                } else {
                    this.cryptoAllOrderLocks.delete(lockKey);
                }
            }
            if (this.cryptoAllAutoDryRun && !this.cryptoAllLastScanSummary) {
                this.cryptoAllLastScanSummary = { at: new Date().toISOString(), dryRun: true, candidatesCount: candidates.length, decisions };
            }
        } catch (e: any) {
            this.cryptoAllLastError = e?.message || String(e);
        } finally {
            this.cryptoAllAutoInFlight = false;
            this.cryptoAllNextScanAllowedAtMs = Date.now() + 2000;
        }
    }

    private getCryptoAllAddOnWindow(secondsToExpire: number): 'A' | 'B' | 'C' | null {
        const s = Math.floor(Number(secondsToExpire) || 0);
        const a = this.cryptoAllAutoConfig.addOn.windowA;
        const b = this.cryptoAllAutoConfig.addOn.windowB;
        const c = this.cryptoAllAutoConfig.addOn.windowC;
        if (s >= a.minSec && s <= a.maxSec) return 'A';
        if (s >= b.minSec && s <= b.maxSec) return 'B';
        if (s >= c.minSec && s <= c.maxSec) return 'C';
        return null;
    }

    private startCryptoAllStoplossLoop() {
        if (this.cryptoAllStoplossTimer) return;
        const tick = async () => {
            await this.tickCryptoAllStoploss().catch(() => {});
            if (!this.cryptoAllStoplossState.size && this.cryptoAllStoplossTimer) {
                clearInterval(this.cryptoAllStoplossTimer);
                this.cryptoAllStoplossTimer = null;
            }
        };
        this.cryptoAllStoplossTimer = setInterval(tick, 250);
        setTimeout(() => tick().catch(() => {}), 50);
    }

    private registerCryptoAllStoplossPosition(params: { strategy: 'crypto15m' | 'cryptoall2' | 'cryptoall'; conditionId: string; tokenId: string; symbol: string; timeframe: '5m' | '15m' | '1h' | '4h' | '1d'; endMs: number; entryPrice: number; sizeEstimate: number; stoploss: { cut1DropCents: number; cut1SellPct: number; cut2DropCents: number; cut2SellPct: number; minSecToExit: number } }) {
        const positionKey = `${String(params.conditionId)}:${String(params.tokenId)}`;
        const prev = this.cryptoAllStoplossState.get(positionKey);
        const entryPrice = Number(params.entryPrice);
        const size = Math.max(0, Number(params.sizeEstimate) || 0);
        if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(size) || size <= 0) return;
        const stoploss = {
            cut1DropCents: Math.max(0, Math.min(50, Math.floor(Number(params.stoploss?.cut1DropCents) || 0))),
            cut1SellPct: Math.max(0, Math.min(100, Math.floor(Number(params.stoploss?.cut1SellPct) || 0))),
            cut2DropCents: Math.max(0, Math.min(50, Math.floor(Number(params.stoploss?.cut2DropCents) || 0))),
            cut2SellPct: Math.max(0, Math.min(100, Math.floor(Number(params.stoploss?.cut2SellPct) || 0))),
            minSecToExit: Math.max(0, Math.min(600, Math.floor(Number(params.stoploss?.minSecToExit) || 0))),
        };
        if (!prev) {
            this.cryptoAllStoplossState.set(positionKey, {
                positionKey,
                strategy: params.strategy,
                conditionId: String(params.conditionId),
                tokenId: String(params.tokenId),
                symbol: String(params.symbol || '').toUpperCase(),
                timeframe: params.timeframe,
                endMs: Number(params.endMs) || Date.now() + 10_000,
                entryPrice,
                totalSize: size,
                soldSize: 0,
                soldCut1: false,
                soldCut2: false,
                lastAttemptAtMs: 0,
                lastCancelAtMs: 0,
                openOrderIds: [],
                openOrderPlacedAtMs: 0,
                lastBestBid: 0,
                stoploss,
            });
            return;
        }
        const totalSize = Number(prev.totalSize) + size;
        const avgEntry = ((Number(prev.entryPrice) * Number(prev.totalSize)) + (entryPrice * size)) / totalSize;
        this.cryptoAllStoplossState.set(positionKey, { ...prev, endMs: Math.max(Number(prev.endMs), Number(params.endMs) || 0), entryPrice: avgEntry, totalSize, stoploss });
    }

    private async tickCryptoAllStoploss(): Promise<void> {
        if (!this.cryptoAllStoplossState.size) return;
        const now = Date.now();
        const minAttemptGap = 250;

        for (const [positionKey, pos] of Array.from(this.cryptoAllStoplossState.entries())) {
            const cut1Drop = Math.max(0, Math.floor(Number(pos?.stoploss?.cut1DropCents) || 0)) / 100;
            const cut2Drop = Math.max(0, Math.floor(Number(pos?.stoploss?.cut2DropCents) || 0)) / 100;
            const cut1Pct = Math.max(0, Math.min(100, Math.floor(Number(pos?.stoploss?.cut1SellPct) || 0)));
            const cut2Pct = Math.max(0, Math.min(100, Math.floor(Number(pos?.stoploss?.cut2SellPct) || 0)));
            const minSecToExit = Math.max(0, Math.floor(Number(pos?.stoploss?.minSecToExit) || 0));
            if (!cut1Drop && !cut2Drop) {
                this.cryptoAllStoplossState.delete(positionKey);
                continue;
            }
            const remainingSec = Math.floor((Number(pos.endMs) - now) / 1000);
            if (remainingSec <= 0) {
                this.cryptoAllStoplossState.delete(positionKey);
                continue;
            }
            if (minSecToExit > 0 && remainingSec < minSecToExit) continue;
            if (pos.lastAttemptAtMs && now - pos.lastAttemptAtMs < minAttemptGap) continue;
            if (pos.soldCut2 || (cut2Pct > 0 && (Number(pos.soldSize) / Math.max(1e-9, Number(pos.totalSize))) * 100 >= cut2Pct)) continue;

            let bestBid = 0;
            let bestAsk = 0;
            let bestBidStr = '';
            let depthTop = 0;
            try {
                const ob = await this.sdk.clobApi.getOrderbook(pos.tokenId);
                const bids = Array.isArray(ob?.bids) ? ob.bids : [];
                bestBidStr = String(bids?.[0]?.price || '');
                bestBid = Number(bestBidStr) || 0;
                depthTop = bids
                    .slice(0, 5)
                    .map((b: any) => Number(b?.size) || 0)
                    .reduce((s: number, x: number) => s + x, 0);
                bestAsk = Number(ob?.asks?.[0]?.price) || 0;
            } catch {
                continue;
            }
            const current = bestBid > 0 ? bestBid : (bestAsk > 0 ? bestAsk : 0);
            if (!(current > 0)) continue;

            const entry = Number(pos.entryPrice) || 0;
            const cut1Price = entry - cut1Drop;
            const cut2Price = entry - cut2Drop;
            const soldPct = (Number(pos.soldSize) / Math.max(1e-9, Number(pos.totalSize))) * 100;

            let targetPct: number | null = null;
            let reason: string | null = null;
            if (cut2Drop > 0 && current <= cut2Price && soldPct < cut2Pct) {
                targetPct = cut2Pct;
                reason = 'cut2';
            } else if (cut1Drop > 0 && current <= cut1Price && soldPct < cut1Pct) {
                targetPct = cut1Pct;
                reason = 'cut1';
            }
            if (targetPct == null || !reason) continue;

            const sizeToHaveSold = (Math.max(0, Math.min(100, targetPct)) / 100) * Number(pos.totalSize);
            const remainingToSellTarget = Math.max(0, sizeToHaveSold - Number(pos.soldSize));
            if (!(remainingToSellTarget > 0)) continue;
            const remainingPos = Math.max(0, Number(pos.totalSize) - Number(pos.soldSize));
            const minSellSize = 1;
            let sellAmount = remainingToSellTarget;
            if (sellAmount < minSellSize) {
                if (remainingPos >= minSellSize) {
                    sellAmount = minSellSize;
                } else if (reason === 'cut1' && cut2Pct > 0 && remainingPos > 0) {
                    targetPct = cut2Pct;
                    reason = 'cut2';
                    sellAmount = remainingPos;
                } else {
                    const action =
                        pos.strategy === 'crypto15m' ? 'crypto15m_stoploss_sell'
                        : pos.strategy === 'cryptoall2' ? 'cryptoall2_stoploss_sell'
                        : 'cryptoall_stoploss_sell';
                    this.orderHistory.unshift({
                        id: Date.now(),
                        timestamp: new Date().toISOString(),
                        mode: 'stoploss',
                        action,
                        marketId: pos.conditionId,
                        symbol: pos.symbol,
                        timeframe: pos.timeframe,
                        tokenId: pos.tokenId,
                        entryPrice: pos.entryPrice,
                        currentBid: bestBid || null,
                        currentAsk: bestAsk || null,
                        secondsToExpire: remainingSec,
                        reason: `${reason}_dust`,
                        targetPct,
                        remainingToSellTarget,
                        sellAmount,
                        result: { success: false, skipped: true, error: `dust_size:${sellAmount}` },
                    });
                    if (this.orderHistory.length > 300) this.orderHistory.pop();
                    this.schedulePersistOrderHistory();
                    continue;
                }
            }
            if (!(sellAmount > 0)) continue;

            const decimals = bestBidStr.includes('.') ? bestBidStr.split('.')[1].length : 2;
            const tickApprox = Math.max(1e-6, Math.min(0.1, Math.pow(10, -Math.max(0, Math.min(6, decimals)))));
            const prevBestBid = Number((pos as any).lastBestBid) || 0;
            const bidMoved = prevBestBid > 0 && bestBid > 0 && Math.abs(bestBid - prevBestBid) >= tickApprox * 0.5;

            const prevOpenOrderIds = Array.isArray((pos as any).openOrderIds) ? (pos as any).openOrderIds.map((x: any) => String(x)).filter(Boolean) : [];
            const prevCancelAt = Number((pos as any).lastCancelAtMs) || 0;
            const prevOpenPlacedAt = Number((pos as any).openOrderPlacedAtMs) || 0;
            const openAgeMs = prevOpenPlacedAt > 0 ? now - prevOpenPlacedAt : 0;
            const shouldCancelOpen = prevOpenOrderIds.length > 0 && (bidMoved || openAgeMs >= 1_500) && now - prevCancelAt >= 600;

            if (shouldCancelOpen) {
                for (const oid of prevOpenOrderIds) {
                    try { await this.tradingClient.cancelOrder(oid); } catch { }
                }
                this.cryptoAllStoplossState.set(positionKey, { ...(pos as any), lastAttemptAtMs: now, lastCancelAtMs: now, openOrderIds: [], openOrderPlacedAtMs: 0, lastBestBid: bestBid });
            } else {
                this.cryptoAllStoplossState.set(positionKey, { ...(pos as any), lastAttemptAtMs: now, lastCancelAtMs: prevCancelAt, openOrderIds: prevOpenOrderIds, openOrderPlacedAtMs: prevOpenPlacedAt, lastBestBid: bestBid });
            }
            let sellResult: any = null;
            try {
                const p1 = bestBid > 0 ? bestBid : undefined;
                const p2 = bestBid > 0 ? Math.max(tickApprox, bestBid - tickApprox) : undefined;
                const p3 = bestBid > 0 ? Math.max(tickApprox, bestBid - 2 * tickApprox) : undefined;

                const depthSafe = Number.isFinite(depthTop) && depthTop > 0 ? depthTop : 0;
                const depthBased = depthSafe > 0 ? depthSafe * 0.6 : 0;
                const maxChunk = Math.max(1, Math.min(200, depthSafe > 0 ? depthSafe : 1));
                const chunk = depthBased > 0 ? Math.min(maxChunk, depthBased) : (sellAmount >= 3 ? 1 : sellAmount);
                const sellChunk = Math.max(minSellSize, Math.min(sellAmount, Math.min(remainingPos, chunk)));

                const attempt1 = await this.tradingClient.createMarketOrder({ tokenId: pos.tokenId, side: 'SELL', amount: sellChunk, price: p1, orderType: 'FAK' });
                const attempt2 = attempt1?.success ? null : await this.tradingClient.createMarketOrder({ tokenId: pos.tokenId, side: 'SELL', amount: sellChunk, price: p2, orderType: 'FAK' });
                const attempt3 = (attempt2?.success || attempt1?.success) ? null : await this.tradingClient.createMarketOrder({ tokenId: pos.tokenId, side: 'SELL', amount: sellChunk, price: p3, orderType: 'FAK' });
                const sell = attempt3 || attempt2 || attempt1;
                const fallbackLimit = sell?.success || !(bestBid > 0) ? null : await this.tradingClient.createOrder({ tokenId: pos.tokenId, side: 'SELL', price: bestBid, size: sellChunk, orderType: 'GTC' });
                sellResult = fallbackLimit?.success ? { ...fallbackLimit, method: 'limit_best_bid' } : { ...sell, method: 'market_fak', fallbackLimit };

                const next = this.cryptoAllStoplossState.get(positionKey);
                if (fallbackLimit?.success && (fallbackLimit?.orderId || fallbackLimit?.id)) {
                    const oid = String(fallbackLimit?.orderId || fallbackLimit?.id);
                    this.cryptoAllStoplossState.set(positionKey, { ...(next as any), openOrderIds: [oid], openOrderPlacedAtMs: now, lastCancelAtMs: Number((next as any)?.lastCancelAtMs) || 0, lastBestBid: bestBid });
                }
                if (sell?.success && (sell?.orderId || sell?.id)) {
                    let filled = 0;
                    const oid = String(sell?.orderId || sell?.id);
                    try {
                        const o = await this.tradingClient.getOrder(oid);
                        filled = Math.max(0, Math.min(sellChunk, Number(o?.filledSize) || 0));
                    } catch {
                        filled = sellChunk;
                    }
                    if (filled > 0) {
                        const soldSize = (Number((next as any)?.soldSize) || 0) + filled;
                        const soldCut1 = ((next as any)?.soldCut1 || false) || reason === 'cut1';
                        const soldCut2 = ((next as any)?.soldCut2 || false) || reason === 'cut2' || (cut2Pct > 0 && (soldSize / Math.max(1e-9, Number((next as any)?.totalSize) || 0)) * 100 >= cut2Pct);
                        this.cryptoAllStoplossState.set(positionKey, { ...(next as any), soldSize, soldCut1, soldCut2 });
                    }
                }
            } catch (e: any) {
                sellResult = { success: false, error: e?.message || String(e) };
            }
            const action =
                pos.strategy === 'crypto15m' ? 'crypto15m_stoploss_sell'
                : pos.strategy === 'cryptoall2' ? 'cryptoall2_stoploss_sell'
                : 'cryptoall_stoploss_sell';
            this.orderHistory.unshift({
                id: Date.now(),
                timestamp: new Date().toISOString(),
                mode: 'stoploss',
                action,
                marketId: pos.conditionId,
                symbol: pos.symbol,
                timeframe: pos.timeframe,
                tokenId: pos.tokenId,
                entryPrice: pos.entryPrice,
                currentBid: bestBid || null,
                currentAsk: bestAsk || null,
                secondsToExpire: remainingSec,
                reason,
                targetPct,
                remainingToSellTarget,
                sellAmount,
                result: sellResult,
            });
            if (this.orderHistory.length > 300) this.orderHistory.pop();
            this.schedulePersistOrderHistory();
        }
    }

    private async computeCryptoAllAccelOk(options: { symbol: string; timeframeSec: number; endMs: number; direction: 'Up' | 'Down' }): Promise<boolean> {
        const symbol = String(options.symbol || '').toUpperCase();
        const tfSec = Number(options.timeframeSec) || 0;
        const endMs = Number(options.endMs) || 0;
        const direction = options.direction;
        const binSymbol = this.getBinanceSymbol(symbol);
        if (!binSymbol || !tfSec || !endMs) return false;
        const startMsRaw = endMs - Math.floor(tfSec) * 1000;
        const startMs = Math.floor(startMsRaw / 60_000) * 60_000;
        const candle = await this.fetchBinance1mCandleWindow({ binSymbol, startMs, minutes: Math.min(60, Math.max(1, Math.floor(tfSec / 60))) });
        const closes = Array.isArray(candle.closes1m) ? candle.closes1m : [];
        if (closes.length < 4) return false;
        const c0 = closes[closes.length - 4];
        const c1 = closes[closes.length - 3];
        const c2 = closes[closes.length - 2];
        const c3 = closes[closes.length - 1];
        if (![c0, c1, c2, c3].every((x) => Number.isFinite(x) && x > 0)) return false;
        const r1 = (c1 - c0) / c0;
        const r2 = (c2 - c1) / c1;
        const r3 = (c3 - c2) / c2;
        const s1 = r1 * (direction === 'Up' ? 1 : -1);
        const s2 = r2 * (direction === 'Up' ? 1 : -1);
        const s3 = r3 * (direction === 'Up' ? 1 : -1);
        if (!(s1 > 0 && s2 > 0 && s3 > 0)) return false;
        return Math.abs(s1) <= Math.abs(s2) && Math.abs(s2) <= Math.abs(s3);
    }

    private registerCryptoAllAddOnPosition(params: { conditionId: string; tokenId: string; direction: 'Up' | 'Down'; outcomeIndex: number; symbol: string; timeframe: '5m' | '15m' | '1h' | '4h' | '1d'; endMs: number; stakeUsd: number }) {
        const positionKey = `${String(params.conditionId)}:${String(params.tokenId)}`;
        const prev = this.cryptoAllAddOnState.get(positionKey);
        const next = {
            positionKey,
            conditionId: String(params.conditionId),
            tokenId: String(params.tokenId),
            direction: params.direction,
            outcomeIndex: Math.max(0, Math.floor(Number(params.outcomeIndex) || 0)),
            symbol: String(params.symbol || '').toUpperCase(),
            timeframe: params.timeframe,
            endMs: Number(params.endMs) || Date.now() + 10_000,
            placedA: prev?.placedA || false,
            placedB: prev?.placedB || false,
            placedC: prev?.placedC || false,
            totalStakeUsd: (Number(prev?.totalStakeUsd) || 0) + (Number(params.stakeUsd) || 0),
            lastAttemptAtMs: Number(prev?.lastAttemptAtMs) || 0,
        };
        this.cryptoAllAddOnState.set(positionKey, next);
    }

    private async tickCryptoAllAddOn(): Promise<void> {
        if (!this.cryptoAllAutoConfig.addOn.enabled) return;
        const now = Date.now();
        const minAttemptIntervalMs = Math.max(200, Math.floor(Number(this.cryptoAllAutoConfig.addOn.minAttemptIntervalMs) || 1200));
        const maxTotal = Math.max(1, Number(this.cryptoAllAutoConfig.addOn.maxTotalStakeUsdPerPosition) || 50);
        const blockScore = Math.max(0, Math.min(100, Math.floor(Number(this.cryptoAllAutoConfig.dojiGuard.riskAddOnBlockScore) || 50)));
        for (const [positionKey, st] of Array.from(this.cryptoAllAddOnState.entries())) {
            const remainingSec = Math.floor((Number(st.endMs) - now) / 1000);
            if (remainingSec <= 0) {
                this.cryptoAllAddOnState.delete(positionKey);
                continue;
            }
            if (st.timeframe !== '15m') continue;
            const win = this.getCryptoAllAddOnWindow(remainingSec);
            if (!win) continue;
            if (win === 'A' && st.placedA) continue;
            if (win === 'B' && st.placedB) continue;
            if (win === 'C' && st.placedC) continue;
            if (Number(st.totalStakeUsd) >= maxTotal) continue;
            if (st.lastAttemptAtMs && now - st.lastAttemptAtMs < minAttemptIntervalMs) continue;
            this.cryptoAllAddOnState.set(positionKey, { ...st, lastAttemptAtMs: now });

            if (this.cryptoAllAutoConfig.addOn.trendEnabled !== false) {
                const needUpMin =
                    win === 'A' ? this.cryptoAllAutoConfig.addOn.trendMinutesA
                    : win === 'B' ? this.cryptoAllAutoConfig.addOn.trendMinutesB
                    : this.cryptoAllAutoConfig.addOn.trendMinutesC;
                const up = await this.isBinanceUpPerMinute(st.symbol, needUpMin, st.direction).catch(() => ({ ok: false, closes: [], error: 'binance_error' }));
                if (!up.ok) continue;
            }

            const tfSec = this.getCryptoAllTimeframeSec(st.timeframe);
            const beat = await this.fetchCryptoAllBeatAndCurrentFromBinance({ symbol: st.symbol, endMs: st.endMs, timeframeSec: tfSec }).catch((e: any) => ({ priceToBeat: null, currentPrice: null, deltaAbs: null, error: e?.message || String(e) }));
            const books = await this.fetchClobBooks([st.tokenId]).catch(() => []);
            const b0: any = Array.isArray(books) && books.length ? books[0] : null;
            const asks = Array.isArray(b0?.asks) ? b0.asks : [];
            const bids = Array.isArray(b0?.bids) ? b0.bids : [];
            const bestAsk = asks.length ? Number(asks[0]?.price) : NaN;
            const bestBid = bids.length ? Number(bids[0]?.price) : NaN;
            const book = {
                bestAsk: Number.isFinite(bestAsk) ? bestAsk : null,
                bestBid: Number.isFinite(bestBid) ? bestBid : null,
                asksCount: asks.length,
                bidsCount: bids.length,
            };
            const risk = await this.computeCryptoAllRisk({ symbol: st.symbol, timeframeSec: tfSec, endMs: st.endMs, direction: st.direction, beat, book }).catch(() => null);
            const riskScore = risk?.riskScore != null ? Number(risk.riskScore) : null;
            if (riskScore == null || riskScore >= blockScore) continue;

            const accelOk = this.cryptoAllAutoConfig.addOn.accelEnabled ? await this.computeCryptoAllAccelOk({ symbol: st.symbol, timeframeSec: tfSec, endMs: st.endMs, direction: st.direction }).catch(() => false) : false;
            const mult =
                accelOk
                    ? (win === 'A' ? this.cryptoAllAutoConfig.addOn.multiplierA : win === 'B' ? this.cryptoAllAutoConfig.addOn.multiplierB : this.cryptoAllAutoConfig.addOn.multiplierC)
                    : 1.0;
            const amountUsd = Math.max(1, (Number(this.cryptoAllAutoConfig.amountUsd) || 1) * (Number(mult) || 1));
            const res: any = await this.placeCryptoAllOrder({
                conditionId: st.conditionId,
                outcomeIndex: st.outcomeIndex,
                amountUsd,
                minPrice: this.cryptoAllAutoConfig.minProb,
                force: false,
                source: 'addon',
                symbol: st.symbol,
                timeframe: st.timeframe,
                endDate: new Date(st.endMs).toISOString(),
                secondsToExpire: remainingSec,
                addonWindow: win,
                addonRiskScore: riskScore,
            } as any).catch(() => null);
            if (res && res.success) {
                const cur = this.cryptoAllAddOnState.get(positionKey);
                if (!cur) continue;
                const next = { ...cur };
                next.totalStakeUsd = (Number(next.totalStakeUsd) || 0) + (Number(amountUsd) || 0);
                if (win === 'A') next.placedA = true;
                if (win === 'B') next.placedB = true;
                if (win === 'C') next.placedC = true;
                this.cryptoAllAddOnState.set(positionKey, next);
            }
        }
    }

    async placeCryptoAllOrder(params: { conditionId: string; outcomeIndex?: number; amountUsd?: number; minPrice?: number; force?: boolean; source?: 'auto' | 'semi' | 'addon'; symbol?: string; timeframe?: '15m' | '1h' | '4h' | '1d'; endDate?: string; secondsToExpire?: number; addonWindow?: 'A' | 'B' | 'C'; addonRiskScore?: number; stoplossEnabled?: boolean; stoplossCut1DropCents?: number; stoplossCut1SellPct?: number; stoplossCut2DropCents?: number; stoplossCut2SellPct?: number; stoplossMinSecToExit?: number }) {
        if (!this.hasValidKey) throw new Error('Missing private key');
        const conditionId = String(params.conditionId || '').trim();
        if (!conditionId) throw new Error('Missing conditionId');
        const requestedAmountUsd = params.amountUsd != null ? Number(params.amountUsd) : NaN;
        const amountUsd = Math.max(1, Number.isFinite(requestedAmountUsd) ? requestedAmountUsd : this.cryptoAllAutoConfig.amountUsd);
        const source = params.source || 'semi';
        const force = params.force === true;
        const requestedMinPrice = params.minPrice != null ? Number(params.minPrice) : NaN;
        const effectiveMinPrice = Math.max(0, this.cryptoAllAutoConfig.minProb, Number.isFinite(requestedMinPrice) ? requestedMinPrice : -Infinity);
        const stoplossEnabled = params.stoplossEnabled != null ? !!params.stoplossEnabled : (this.cryptoAllAutoConfig.stoploss?.enabled ?? this.cryptoAllAutoConfig.stoplossEnabled);
        const stoplossCut1DropCents = params.stoplossCut1DropCents != null ? Number(params.stoplossCut1DropCents) : (this.cryptoAllAutoConfig.stoploss?.cut1DropCents ?? this.cryptoAllAutoConfig.stoplossCut1DropCents);
        const stoplossCut1SellPct = params.stoplossCut1SellPct != null ? Number(params.stoplossCut1SellPct) : (this.cryptoAllAutoConfig.stoploss?.cut1SellPct ?? this.cryptoAllAutoConfig.stoplossCut1SellPct);
        const stoplossCut2DropCents = params.stoplossCut2DropCents != null ? Number(params.stoplossCut2DropCents) : (this.cryptoAllAutoConfig.stoploss?.cut2DropCents ?? this.cryptoAllAutoConfig.stoplossCut2DropCents);
        const stoplossCut2SellPct = params.stoplossCut2SellPct != null ? Number(params.stoplossCut2SellPct) : (this.cryptoAllAutoConfig.stoploss?.cut2SellPct ?? this.cryptoAllAutoConfig.stoplossCut2SellPct);
        const stoplossMinSecToExit = params.stoplossMinSecToExit != null ? Number(params.stoplossMinSecToExit) : (this.cryptoAllAutoConfig.stoploss?.minSecToExit ?? this.cryptoAllAutoConfig.stoplossMinSecToExit);
        const recordSkipEarly = (reason: string, errorMsg?: any) => {
            try {
                const orderStatus = `skipped:${reason}`;
                const last = this.orderHistory[0];
                if (last && String(last?.action || '') === 'cryptoall_order' && String(last?.marketId || '') === conditionId) {
                    const lastStatus = Array.isArray(last?.results) && last.results.length ? String(last.results[0]?.orderStatus || '') : '';
                    const lastTs = last?.timestamp ? Date.parse(String(last.timestamp)) : NaN;
                    if (lastStatus === orderStatus && Number.isFinite(lastTs) && (Date.now() - lastTs) < 5000) return;
                }
                const tf0 = (params.timeframe || '15m') as any;
                const sym0 = String(params.symbol || 'UNKNOWN').toUpperCase();
                this.orderHistory.unshift({
                    id: Date.now(),
                    timestamp: new Date().toISOString(),
                    mode: source,
                    action: 'cryptoall_order',
                    marketId: conditionId,
                    symbol: sym0,
                    timeframe: tf0,
                    slug: null,
                    marketQuestion: null,
                    outcome: null,
                    outcomeIndex: params.outcomeIndex != null ? Number(params.outcomeIndex) : null,
                    tokenId: null,
                    amountUsd,
                    results: [{ success: false, orderId: null, tokenId: null, outcome: null, conditionId, orderStatus, errorMsg: errorMsg != null ? String(errorMsg) : '' }],
                });
                this.schedulePersistOrderHistory();
            } catch {}
        };

        if (source !== 'addon' && this.cryptoAllTrackedByCondition.has(conditionId)) {
            const tracked = this.cryptoAllTrackedByCondition.get(conditionId) || null;
            const status = String(tracked?.status || '').toLowerCase();
            const retryAfterMs = tracked?.retryAfterMs != null ? Number(tracked.retryAfterMs) : NaN;
            if (status === 'failed' && Number.isFinite(retryAfterMs) && Date.now() >= retryAfterMs) {
                const tid = tracked?.tokenId != null ? String(tracked.tokenId).trim() : '';
                const oid = tracked?.orderId != null ? String(tracked.orderId).trim() : '';
                if (tid) {
                    const probe = await this.probeRecentBuyState({ conditionId, tokenId: tid, orderId: oid || null, maxWaitMs: 0 }).catch(() => null as any);
                    const has = probe && ((probe.filledUsd != null && Number(probe.filledUsd) > 0) || probe.hasOpen === true || probe.orderFetched === true);
                    if (has) {
                        this.cryptoAllTrackedByCondition.set(conditionId, { ...tracked, status: 'ordered', verifiedAt: new Date().toISOString(), orderId: (probe?.orderId ?? tracked?.orderId ?? null) });
                        recordSkipEarly('already_ordered_tracked');
                        return { success: false, skipped: true, reason: 'already_ordered_tracked', conditionId };
                    }
                }
                this.cryptoAllTrackedByCondition.delete(conditionId);
            } else if (status === 'failed' && Number.isFinite(retryAfterMs)) {
                recordSkipEarly('retry_cooldown', `retryAfterMs=${retryAfterMs}`);
                return { success: false, skipped: true, reason: 'retry_cooldown', conditionId, retryAfterMs };
            } else {
                recordSkipEarly('already_ordered_tracked');
                return { success: false, skipped: true, reason: 'already_ordered_tracked', conditionId };
            }
        }
        const alreadyInHistory = this.orderHistory.some((e: any) => {
            if (!e) return false;
            if (String(e?.action || '') !== 'cryptoall_order') return false;
            const mid = String(e?.marketId || '').trim().toLowerCase();
            if (!(mid && mid === conditionId.toLowerCase())) return false;
            const res0 = Array.isArray(e?.results) && e.results.length ? e.results[0] : null;
            const orderStatus = String(res0?.orderStatus || '').toLowerCase();
            if (orderStatus.startsWith('skipped:')) return false;
            const ok = res0?.success === true;
            const orderId = res0?.orderId != null ? String(res0.orderId) : '';
            return ok || !!orderId;
        });
        if (source !== 'addon' && alreadyInHistory) {
            recordSkipEarly('already_ordered_history');
            return { success: false, skipped: true, reason: 'already_ordered_history', conditionId };
        }

        const market = await withRetry(() => this.sdk.clobApi.getMarket(conditionId), { maxRetries: 2 });
        const marketAny: any = market as any;
        const marketSlug = String(marketAny?.marketSlug ?? marketAny?.market_slug ?? '');
        const q = String(marketAny?.question || '');
        const symbol = String(params.symbol || this.inferCryptoSymbolFromText(marketSlug, q) || 'UNKNOWN');
        const tf = (params.timeframe || '15m') as any;
        const timeframeSec = this.getCryptoAllTimeframeSec(tf);

        let endDate: string | null = params.endDate != null ? String(params.endDate) : null;
        if (!endDate) {
            const endIso = marketAny?.endDateIso ?? marketAny?.end_date_iso ?? null;
            const ms = endIso ? Date.parse(String(endIso)) : NaN;
            if (Number.isFinite(ms)) endDate = new Date(ms).toISOString();
        }
        let expiresAtMs = endDate ? Date.parse(endDate) : NaN;
        if (!Number.isFinite(expiresAtMs)) {
            expiresAtMs = Date.now() + 20 * 60_000;
            endDate = new Date(expiresAtMs).toISOString();
        }

        const upperSymbol = String(symbol || '').toUpperCase();
        const orderLockKey = upperSymbol && upperSymbol !== 'UNKNOWN' ? `${tf}:${upperSymbol}:${expiresAtMs}` : null;
        const recordSkip = (reason: string, fields?: Record<string, any>) => {
            try {
                const orderStatus = `skipped:${reason}`;
                const last = this.orderHistory[0];
                if (last && String(last?.action || '') === 'cryptoall_order' && String(last?.marketId || '') === conditionId) {
                    const lastStatus = Array.isArray(last?.results) && last.results.length ? String(last.results[0]?.orderStatus || '') : '';
                    const lastTs = last?.timestamp ? Date.parse(String(last.timestamp)) : NaN;
                    if (lastStatus === orderStatus && Number.isFinite(lastTs) && (Date.now() - lastTs) < 5000) return;
                }
                this.orderHistory.unshift({
                    id: Date.now(),
                    timestamp: new Date().toISOString(),
                    mode: source,
                    action: 'cryptoall_order',
                    marketId: conditionId,
                    symbol: upperSymbol,
                    timeframe: tf,
                    slug: marketSlug || null,
                    marketQuestion: q || null,
                    outcome: fields?.outcome ?? null,
                    outcomeIndex: fields?.outcomeIndex ?? null,
                    tokenId: fields?.tokenId ?? null,
                    amountUsd,
                    price: fields?.bestAsk ?? null,
                    bestAsk: fields?.bestAsk ?? null,
                    limitPrice: fields?.limitPrice ?? null,
                    replay: fields?.replay ?? null,
                    results: [{ success: false, orderId: null, tokenId: fields?.tokenId ?? null, outcome: fields?.outcome ?? null, conditionId, orderStatus, errorMsg: fields?.errorMsg != null ? String(fields.errorMsg) : '' }],
                });
                this.schedulePersistOrderHistory();
            } catch {}
        };
        let orderLockPlaced = false;
        if (!force && orderLockKey) {
            const key = `${tf}:${upperSymbol}`;
            if (source !== 'addon' && this.cryptoAllActivesByKey.has(key)) {
                recordSkip('already_active', { expiresAtMs });
                return { success: false, skipped: true, reason: 'already_active', symbol: upperSymbol, timeframe: tf, slug: marketSlug || null, expiresAtMs };
            }
            const locked = this.cryptoAllOrderLocks.get(orderLockKey);
            if (locked && locked.status === 'placing') {
                recordSkip('duplicate_inflight', { expiresAtMs });
                return { success: false, skipped: true, reason: 'duplicate_inflight', symbol: upperSymbol, timeframe: tf, slug: marketSlug || null, expiresAtMs };
            }
        }

        const tokens: any[] = Array.isArray(marketAny?.tokens) ? marketAny.tokens : [];
        if (tokens.length < 2) throw new Error('Invalid market tokens');
        const requestedIdxRaw = params.outcomeIndex != null ? Math.floor(Number(params.outcomeIndex)) : NaN;
        let idx = Number.isFinite(requestedIdxRaw) ? Math.max(0, Math.min(tokens.length - 1, requestedIdxRaw)) : 0;
        const tokenOutcomeLc = String(tokens[idx]?.outcome || '').toLowerCase();
        if (!tokenOutcomeLc.includes('up') && !tokenOutcomeLc.includes('down')) {
            const upIdx = tokens.findIndex((t: any) => String(t?.outcome || '').toLowerCase().includes('up'));
            const downIdx = tokens.findIndex((t: any) => String(t?.outcome || '').toLowerCase().includes('down'));
            if (upIdx < 0 || downIdx < 0) throw new Error('Missing Up/Down outcomes');
            idx = Number.isFinite(requestedIdxRaw) && requestedIdxRaw === downIdx ? downIdx : upIdx;
        }
        const tok: any = tokens[idx];
        const tokenId = String(tok?.tokenId ?? tok?.token_id ?? tok?.id ?? '').trim();
        if (!tokenId) throw new Error('Missing tokenId');
        const outcome = String(tok?.outcome ?? '').trim() || `idx_${idx}`;

        if (!force && symbol && symbol !== 'UNKNOWN') {
            const minDeltaRequired = this.getCryptoAllMinDeltaRequired(upperSymbol, tf);
            if (minDeltaRequired > 0) {
                const beat = await this.fetchCryptoAllBeatAndCurrentFromBinance({ symbol: upperSymbol, endMs: expiresAtMs, timeframeSec });
                if (beat.deltaAbs == null) {
                    recordSkip('delta_unavailable', { tokenId, outcome, outcomeIndex: idx, errorMsg: beat.error || 'Failed to compute delta' });
                    return { success: false, skipped: true, reason: 'delta_unavailable', symbol: upperSymbol, timeframe: tf, slug: marketSlug || null, minDeltaRequired, error: beat.error || 'Failed to compute delta' };
                }
                if (beat.deltaAbs < minDeltaRequired) {
                    recordSkip('delta_too_small', { tokenId, outcome, outcomeIndex: idx, errorMsg: `${beat.deltaAbs} < ${minDeltaRequired}` });
                    return { success: false, skipped: true, reason: 'delta_too_small', symbol: upperSymbol, timeframe: tf, slug: marketSlug || null, minDeltaRequired, deltaAbs: beat.deltaAbs, priceToBeat: beat.priceToBeat, currentPrice: beat.currentPrice };
                }
            }
        }

        if (!force && orderLockKey) {
            this.cryptoAllOrderLocks.set(orderLockKey, { atMs: Date.now(), key: `${tf}:${upperSymbol}`, expiresAtMs, conditionId, status: 'placing' });
            orderLockPlaced = true;
        }
        let replay: any = null;
        try {
            const booksFetchedAtMs = Date.now();
            const books = await this.fetchClobBooks([tokenId]);
            const b0: any = Array.isArray(books) && books.length ? books[0] : null;
            const asks = Array.isArray(b0?.asks) ? b0.asks : [];
            const bids = Array.isArray(b0?.bids) ? b0.bids : [];
            const bestAsk = asks.length ? Number(asks[0]?.price) : NaN;
            const bestBid = bids.length ? Number(bids[0]?.price) : NaN;
            const chosenPrice = Number.isFinite(bestAsk) ? bestAsk : null;
            if (chosenPrice == null) {
                recordSkip('missing_book', { tokenId, outcome, outcomeIndex: idx });
                return { success: false, skipped: true, reason: 'missing_book', symbol: upperSymbol, timeframe: tf, slug: marketSlug || null };
            }
            const bidPrice = Number.isFinite(bestBid) ? bestBid : null;
            const booksCache = (this as any).clobBooksCache as Map<string, { atMs: number; data: any[] }> | undefined;
            const booksCacheAtMs = booksCache?.get(String(tokenId))?.atMs ?? null;
            const booksStaleMs = booksCacheAtMs != null ? Math.max(0, booksFetchedAtMs - Number(booksCacheAtMs)) : null;
            const limitPrice = Math.min(0.999, chosenPrice + 0.02);
            replay = {
                meta: {
                    strategy: 'cryptoall',
                    tokenId,
                    conditionId,
                    symbol: upperSymbol,
                    timeframe: tf,
                    outcome,
                    outcomeIndex: idx,
                    expiresAtMs,
                    secondsToExpire: params.secondsToExpire != null ? Number(params.secondsToExpire) : Math.max(0, Math.floor((Number(expiresAtMs) - Date.now()) / 1000)),
                    bestAsk: chosenPrice,
                    bestBid: bidPrice,
                    limitPrice,
                    requestedAmountUsd,
                    amountUsd,
                    booksStaleMs,
                },
                before: buildOrderbookSnapshot({ book: { asks, bids }, fetchedAtMs: Number(booksCacheAtMs) || booksFetchedAtMs, topN: 25 }),
                after: null,
            };
            if (!force && this.cryptoAllAutoConfig.stoploss?.spreadGuardCents != null && bidPrice != null) {
                const spread = chosenPrice - bidPrice;
                const guard = Math.max(0, Math.floor(Number(this.cryptoAllAutoConfig.stoploss.spreadGuardCents) || 0)) / 100;
                if (guard > 0 && spread >= guard) {
                    recordSkip('spread_guard', { tokenId, outcome, outcomeIndex: idx, bestAsk: chosenPrice, bestBid: bidPrice, limitPrice, replay, errorMsg: `spread=${spread}` });
                    return { success: false, skipped: true, reason: 'spread_guard', symbol: upperSymbol, timeframe: tf, slug: marketSlug || null, bestAsk: chosenPrice, bestBid: bidPrice, spread, guard };
                }
            }
            if (!force && chosenPrice < effectiveMinPrice) {
                recordSkip('min_prob', { tokenId, outcome, outcomeIndex: idx, bestAsk: chosenPrice, limitPrice, replay, errorMsg: `bestAsk=${chosenPrice} min=${effectiveMinPrice}` });
                return { success: false, skipped: true, reason: 'min_prob', symbol: upperSymbol, timeframe: tf, slug: marketSlug || null, bestAsk: chosenPrice, minPrice: effectiveMinPrice };
            }

            const globalKey = `cryptoall:${conditionId}`.toLowerCase();
            if (!force) {
                if (!this.tryAcquireGlobalOrderLock(globalKey, 'cryptoall')) {
                    recordSkip('global_locked', { tokenId, outcome, outcomeIndex: idx, bestAsk: chosenPrice, limitPrice, replay, expiresAtMs });
                    return { success: false, skipped: true, reason: 'global_locked', symbol: upperSymbol, timeframe: tf, slug: marketSlug || null, expiresAtMs };
                }
                if (this.globalOrderPlaceInFlight) {
                    this.markGlobalOrderLockDone(globalKey, false);
                    recordSkip('global_inflight', { tokenId, outcome, outcomeIndex: idx, bestAsk: chosenPrice, limitPrice, replay, expiresAtMs });
                    return { success: false, skipped: true, reason: 'global_inflight', symbol: upperSymbol, timeframe: tf, slug: marketSlug || null, expiresAtMs };
                }
                this.globalOrderPlaceInFlight = true;
            }
            let ok = false;
            let orderId: string | null = null;
            let orderErrorMsg: string | null = null;
            try {
                const result = await this.tradingClient.createMarketOrder({ tokenId, amountUsd, limitPrice, side: 'BUY' });
                ok = !!(result as any)?.success;
                orderId = (result as any)?.orderId || null;
                orderErrorMsg = (result as any)?.errorMsg != null ? String((result as any).errorMsg) : ((result as any)?.error != null ? String((result as any).error) : null);
                if (!ok) {
                    const probe = await this.probeRecentBuyState({ conditionId, tokenId, orderId: orderId || null, maxWaitMs: 900 }).catch(() => null as any);
                    const has = probe && ((probe.filledUsd != null && Number(probe.filledUsd) > 0) || probe.hasOpen === true || probe.orderFetched === true);
                    if (has) {
                        ok = true;
                        if (!orderId && probe?.orderId) orderId = String(probe.orderId);
                        orderErrorMsg = null;
                    }
                }
            } finally {
                if (!force) {
                    this.globalOrderPlaceInFlight = false;
                    this.markGlobalOrderLockDone(globalKey, ok);
                }
            }

            try {
                await new Promise((r) => setTimeout(r, 300));
                const afterFetchedAtMs = Date.now();
                const afterBooks = await this.fetchClobBooks([tokenId]).catch(() => []);
                const afterBook = Array.isArray(afterBooks) && afterBooks.length ? afterBooks[0] : null;
                const afterAsks = Array.isArray((afterBook as any)?.asks) ? (afterBook as any).asks : [];
                const afterBids = Array.isArray((afterBook as any)?.bids) ? (afterBook as any).bids : [];
                if (replay) replay.after = buildOrderbookSnapshot({ book: { asks: afterAsks, bids: afterBids }, fetchedAtMs: afterFetchedAtMs, topN: 25 });
            } catch {
            }

            const historyEntry: any = {
                id: Date.now(),
                timestamp: new Date().toISOString(),
                mode: source,
                action: 'cryptoall_order',
                marketId: conditionId,
                symbol: upperSymbol,
                timeframe: tf,
                slug: marketSlug || null,
                marketQuestion: q || null,
                outcome,
                outcomeIndex: idx,
                tokenId,
                price: chosenPrice,
                bestAsk: chosenPrice,
                limitPrice,
                amountUsd,
                addonWindow: params.addonWindow || null,
                addonRiskScore: params.addonRiskScore != null ? Number(params.addonRiskScore) : null,
                replay,
                results: [{ success: ok, orderId, tokenId, outcome, conditionId, errorMsg: ok ? '' : (orderErrorMsg || '') }],
            };
            this.orderHistory.unshift(historyEntry);
            this.schedulePersistOrderHistory();

            if (source !== 'addon') {
                if (ok) {
                    this.cryptoAllTrackedByCondition.set(conditionId, { orderedAt: new Date().toISOString(), symbol: upperSymbol, timeframe: tf, orderId, tokenId, outcome, status: 'ordered' });
                } else {
                    this.cryptoAllTrackedByCondition.set(conditionId, { orderedAt: new Date().toISOString(), symbol: upperSymbol, timeframe: tf, orderId, tokenId, outcome, status: 'failed', retryAfterMs: Date.now() + 20000 });
                }
            }
            if (!force && orderLockKey) {
                this.cryptoAllOrderLocks.set(orderLockKey, { atMs: Date.now(), key: `${tf}:${upperSymbol}`, expiresAtMs, conditionId, status: ok ? 'ordered' : 'failed' });
            }
            if (ok) {
                if (source !== 'addon') {
                    this.cryptoAllActivesByKey.set(`${tf}:${upperSymbol}`, { conditionId, orderId, tokenId, outcome, expiresAtMs, slug: marketSlug || null, placedAt: new Date().toISOString() });
                }
                const direction = String(outcome || '').toLowerCase().includes('down') ? 'Down' : 'Up';
                if (source !== 'addon') {
                    this.registerCryptoAllAddOnPosition({ conditionId, tokenId, direction: direction as any, outcomeIndex: idx, symbol: upperSymbol, timeframe: tf, endMs: expiresAtMs, stakeUsd: amountUsd });
                } else {
                    const positionKey = `${conditionId}:${tokenId}`;
                    const cur = this.cryptoAllAddOnState.get(positionKey);
                    const placedA = cur?.placedA || params.addonWindow === 'A';
                    const placedB = cur?.placedB || params.addonWindow === 'B';
                    const placedC = cur?.placedC || params.addonWindow === 'C';
                    const next = cur || { positionKey, conditionId, tokenId, direction: direction as any, outcomeIndex: idx, symbol: upperSymbol, timeframe: tf, endMs: expiresAtMs, placedA: false, placedB: false, placedC: false, totalStakeUsd: 0, lastAttemptAtMs: 0 };
                    this.cryptoAllAddOnState.set(positionKey, { ...next, placedA, placedB, placedC, totalStakeUsd: (Number(next.totalStakeUsd) || 0) + (Number(amountUsd) || 0) });
                }
                if (stoplossEnabled) {
                    const sizeEstimate = chosenPrice > 0 ? amountUsd / chosenPrice : 0;
                    this.registerCryptoAllStoplossPosition({
                        strategy: 'cryptoall',
                        conditionId,
                        tokenId,
                        symbol: upperSymbol,
                        timeframe: tf,
                        endMs: expiresAtMs,
                        entryPrice: chosenPrice,
                        sizeEstimate,
                        stoploss: {
                            cut1DropCents: Math.max(0, Math.min(50, Math.floor(Number(stoplossCut1DropCents) || 0))),
                            cut1SellPct: Math.max(0, Math.min(100, Math.floor(Number(stoplossCut1SellPct) || 0))),
                            cut2DropCents: Math.max(0, Math.min(50, Math.floor(Number(stoplossCut2DropCents) || 0))),
                            cut2SellPct: Math.max(0, Math.min(100, Math.floor(Number(stoplossCut2SellPct) || 0))),
                            minSecToExit: Math.max(0, Math.min(600, Math.floor(Number(stoplossMinSecToExit) || 0))),
                        }
                    });
                }
            }
            return { success: ok, orderId, slug: marketSlug || null, conditionId, symbol: upperSymbol, timeframe: tf, bestAsk: chosenPrice, minPrice: effectiveMinPrice, tokenId, outcomeIndex: idx, outcome };
        } catch (e: any) {
            const errMsg = e?.message || String(e);
            try {
                const historyEntry: any = {
                    id: Date.now(),
                    timestamp: new Date().toISOString(),
                    mode: source,
                    action: 'cryptoall_order',
                    marketId: conditionId,
                    symbol: upperSymbol,
                    timeframe: tf,
                    slug: marketSlug || null,
                    marketQuestion: q || null,
                    outcome,
                    outcomeIndex: idx,
                    tokenId,
                    amountUsd,
                    addonWindow: params.addonWindow || null,
                    addonRiskScore: params.addonRiskScore != null ? Number(params.addonRiskScore) : null,
                    replay,
                    results: [{ success: false, orderId: null, tokenId, outcome, conditionId, errorMsg: errMsg }],
                };
                this.orderHistory.unshift(historyEntry);
                this.schedulePersistOrderHistory();
            } catch {}
            if (!force && orderLockKey) {
                this.cryptoAllOrderLocks.set(orderLockKey, { atMs: Date.now(), key: `${tf}:${upperSymbol}`, expiresAtMs, conditionId, status: 'failed' });
            }
            return { success: false, error: e?.message || String(e) };
        } finally {
            if (!force && orderLockKey && orderLockPlaced) {
                const locked = this.cryptoAllOrderLocks.get(orderLockKey);
                if (locked && locked.status === 'placing') {
                    this.cryptoAllOrderLocks.set(orderLockKey, { ...locked, atMs: Date.now(), status: 'failed' });
                }
            }
        }
    }

    async refreshHistoryStatuses(options?: { maxEntries?: number; minIntervalMs?: number }): Promise<any[]> {
        const maxEntries = Number(options?.maxEntries ?? 20);
        const minIntervalMs = Number(options?.minIntervalMs ?? 1000);

        const slice = this.orderHistory.slice(0, maxEntries);
        const now = Date.now();

        for (const entry of slice) {
            if (!entry || !Array.isArray(entry.results)) continue;
            for (const r of entry.results) {
                const orderId = r?.orderId;
                if (!orderId) continue;

                const cached = this.orderStatusCache.get(orderId);
                if (cached && now - cached.updatedAtMs < minIntervalMs) {
                    r.orderStatus = cached.data?.status ?? r.orderStatus;
                    r.filledSize = cached.data?.filledSize ?? r.filledSize;
                    r.orderUpdatedAt = cached.data?.orderUpdatedAt ?? r.orderUpdatedAt;
                    continue;
                }

                try {
                    const o = await this.tradingClient.getOrder(orderId);
                    const status = String(o?.status ?? '').toUpperCase();
                    const filledSize = Number(o?.filledSize ?? 0);
                    const updated = {
                        status,
                        filledSize: Number.isFinite(filledSize) ? filledSize : 0,
                        orderUpdatedAt: new Date().toISOString(),
                    };
                    this.orderStatusCache.set(orderId, { updatedAtMs: now, data: updated });

                    r.orderStatus = updated.status;
                    r.filledSize = updated.filledSize;
                    r.orderUpdatedAt = updated.orderUpdatedAt;

                    if (updated.status === 'CANCELED' && !this.systemCanceledOrderIds.has(orderId)) {
                        r.canceledBy = r.canceledBy || 'external';
                    }
                } catch {
                }
            }
        }

        const relayerClient = this.relayerSafe || this.relayerProxy || null;
        if (relayerClient) {
            const candidates: Array<{ conditionId: string; transactionId: string }> = [];
            for (const entry of slice) {
                if (!entry || !Array.isArray(entry.results)) continue;
                for (const r of entry.results) {
                    const redeemStatus = String(r?.redeemStatus || '').toLowerCase();
                    if (redeemStatus !== 'submitted') continue;
                    const txHash = String(r?.txHash || '').trim();
                    if (txHash && txHash.startsWith('0x')) continue;
                    const transactionId = String(r?.transactionId || '').trim();
                    const conditionId = String(r?.conditionId || entry?.marketId || '').trim();
                    if (!transactionId || !conditionId) continue;
                    candidates.push({ conditionId, transactionId });
                }
            }
            for (const c of candidates.slice(0, 10)) {
                try {
                    const txs: any[] = await this.withTimeout((relayerClient as any).getTransaction(c.transactionId), 6_000, 'Relayer getTransaction');
                    const tx = Array.isArray(txs) ? txs[0] : null;
                    const state = String(tx?.state || '').toUpperCase();
                    const txHash = String(tx?.transactionHash || '').trim();
                    if (!txHash || !txHash.startsWith('0x')) continue;
                    const submittedAt = new Date().toISOString();
                    const inflight = this.redeemInFlight.get(c.conditionId) || { conditionId: c.conditionId, submittedAt, method: 'relayer_unknown', status: 'submitted' as const };
                    inflight.txHash = txHash;
                    inflight.transactionId = inflight.transactionId || c.transactionId;
                    if (state === 'STATE_CONFIRMED') inflight.status = 'confirmed';
                    if (state === 'STATE_FAILED' || state === 'STATE_INVALID') inflight.status = 'failed';
                    this.redeemInFlight.set(c.conditionId, inflight as any);
                    if (inflight.status === 'confirmed') {
                        try {
                            const funder = this.getFunderAddress();
                            const signer = this.tradingClient.getSignerAddress();
                            const proxy = String(process.env.POLY_PROXY_ADDRESS || '').trim();
                            const baseRecipients = Array.isArray((inflight as any)?.payoutRecipients)
                                ? (inflight as any).payoutRecipients.map((x: any) => String(x || '').trim())
                                : [];
                            const recipients: string[] = Array.from(new Set<string>(baseRecipients
                                .concat([funder, signer, proxy])
                                .map((x: any) => String(x || '').trim())
                                .filter((s: string) => s.startsWith('0x') && s.length >= 42)
                            ));
                            const payout = await this.computeUsdcTransfersFromTxHash(txHash, { recipients });
                            (inflight as any).txStatus = payout.txStatus;
                            (inflight as any).payoutUsdc = payout.netUsdc;
                            (inflight as any).payoutReceivedUsdc = payout.receivedUsdc;
                            (inflight as any).payoutSentUsdc = payout.sentUsdc;
                            (inflight as any).payoutNetUsdc = payout.netUsdc;
                            (inflight as any).payoutRecipients = payout.recipients;
                            (inflight as any).usdcTransfers = payout.transfers;
                            (inflight as any).paid = payout.txStatus === 0 ? false : Number(payout.receivedUsdc) > 0;
                            (inflight as any).payoutComputedAt = new Date().toISOString();
                        } catch {
                        }
                    }
                    this.crypto15mSyncFromRedeemInFlight(c.conditionId);
                    this.upsertRedeemInfoToOrderHistory(c.conditionId);
                } catch {
                }
            }
        }

        this.refreshRedeemHistoryFromInFlight({ maxEntries });
        this.schedulePersistOrderHistory();
        return this.orderHistory;
    }

    async exitNow(marketId: string): Promise<any> {
        const pos = this.monitoredPositions.get(marketId);
        if (!pos) {
            return { success: false, error: 'No monitored position for this marketId' };
        }

        const cancelIfPresent = (orderId?: string) => {
            if (!orderId) return Promise.resolve({ skipped: true });
            this.systemCanceledOrderIds.add(orderId);
            return this.tradingClient.cancelOrder(orderId).catch((e: any) => ({ error: e?.message || String(e) }));
        };

        const updateLeg = async (leg: MonitoredLeg) => {
            try {
                if (!leg.orderId) return;
                const o = await this.tradingClient.getOrder(leg.orderId);
                const filled = Number(o?.filledSize ?? o?.sizeMatched ?? 0);
                leg.filledSize = Number.isFinite(filled) ? filled : leg.filledSize;
                const status = String(o?.status ?? '').toUpperCase();
                if (status === 'LIVE') leg.status = 'live';
                else if (leg.filledSize > 0) leg.status = 'filled';
                else leg.status = 'closed';
            } catch {
            }
        };

        await Promise.all([updateLeg(pos.legs.yes), updateLeg(pos.legs.no)]);

        const yesFilled = pos.legs.yes.filledSize > 0;
        const noFilled = pos.legs.no.filledSize > 0;
        const filledLeg = yesFilled ? pos.legs.yes : (noFilled ? pos.legs.no : null);

        const cancelResults = await Promise.allSettled([
            cancelIfPresent(pos.legs.yes.orderId),
            cancelIfPresent(pos.legs.no.orderId),
        ]);

        if (!filledLeg) {
            this.orderHistory.unshift({
                id: Date.now(),
                timestamp: new Date().toISOString(),
                marketId,
                mode: 'auto',
                originMode: pos.mode,
                action: 'manual_exit',
                result: { success: false, error: 'No filled leg detected', cancelResults }
            });
            if (this.orderHistory.length > 100) this.orderHistory.pop();
            this.schedulePersistOrderHistory();
            return { success: false, error: 'No filled leg detected', cancelResults };
        }

        try {
            const ob = await this.sdk.clobApi.getOrderbook(filledLeg.tokenId);
            const bestBid = Number(ob?.bids?.[0]?.price) || 0;
            const bestAsk = Number(ob?.asks?.[0]?.price) || 0;
            const mid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : (bestBid || bestAsk);
            const sizeToSell = Math.min(filledLeg.filledSize || filledLeg.size, filledLeg.size);

            const attempt1 = await this.tradingClient.createMarketOrder({
                tokenId: filledLeg.tokenId,
                side: 'SELL',
                amount: sizeToSell,
                orderType: 'FAK',
            });

            const attempt2 = attempt1?.success ? null : await this.tradingClient.createMarketOrder({
                tokenId: filledLeg.tokenId,
                side: 'SELL',
                amount: sizeToSell,
                price: bestBid > 0 ? bestBid : undefined,
                orderType: 'FAK',
            });

            const sell = attempt2 || attempt1;
            const fallbackLimit = sell?.success || !(bestBid > 0) ? null : await this.tradingClient.createOrder({
                tokenId: filledLeg.tokenId,
                side: 'SELL',
                price: bestBid,
                size: sizeToSell,
                orderType: 'GTC',
            });

            this.orderHistory.unshift({
                id: Date.now(),
                timestamp: new Date().toISOString(),
                marketId,
                mode: 'auto',
                originMode: pos.mode,
                action: 'manual_exit',
                remark: 'risk_exit_aggressive_market',
                leg: filledLeg.outcome,
                mid,
                result: fallbackLimit?.success ? { ...fallbackLimit, method: 'limit_best_bid' } : { ...sell, method: attempt1?.success ? 'market_fak' : 'market_fak_with_price', fallbackLimit }
            });
            if (this.orderHistory.length > 50) this.orderHistory.pop();
            this.schedulePersistOrderHistory();

            if (sell?.success || fallbackLimit?.success) pos.status = 'exited';

            return { success: !!(sell?.success || fallbackLimit?.success), sell: fallbackLimit?.success ? fallbackLimit : sell, cancelResults };
        } catch (e: any) {
            return { success: false, error: e?.message || String(e), cancelResults };
        }
    }

    private extractMarketSlug(identifier: string): string | null {
        if (!identifier) return null;
        const trimmed = identifier.trim();
        if (!trimmed) return null;
        if (trimmed.startsWith('0x')) return null;
        try {
            if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
                const u = new URL(trimmed);
                const parts = u.pathname.split('/').filter(Boolean);
                if (parts.length === 0) return null;
                return parts[parts.length - 1];
            }
        } catch {
        }
        const parts = trimmed.split('/').filter(Boolean);
        return parts.length ? parts[parts.length - 1] : trimmed;
    }

    async resolveIdentifier(identifier: string): Promise<{ marketId: string; slug?: string; question?: string; gammaId?: string }> {
        const trimmed = (identifier || '').trim();
        if (!trimmed) throw new Error('Missing identifier');
        if (trimmed.startsWith('0x')) {
            const gamma = await withRetry(() => this.sdk.gammaApi.getMarketByConditionId(trimmed), { maxRetries: 2 });
            return { marketId: trimmed, slug: gamma?.slug, question: gamma?.question, gammaId: gamma?.id };
        }
        const slug = this.extractMarketSlug(trimmed);
        if (!slug) throw new Error('Could not extract market slug');
        const gamma = await withRetry(() => this.sdk.gammaApi.getMarketBySlug(slug), { maxRetries: 2 });
        if (!gamma?.conditionId) throw new Error('Market not found for slug');
        return { marketId: gamma.conditionId, slug: gamma.slug, question: gamma.question, gammaId: gamma.id };
    }

    async getOrderbookLadder(identifier: string, depth = 5): Promise<any> {
        const resolved = await this.resolveIdentifier(identifier);
        const market = await withRetry(() => this.sdk.clobApi.getMarket(resolved.marketId), { maxRetries: 2 });
        const tokens: any[] = Array.isArray((market as any)?.tokens) ? (market as any).tokens : [];
        const yesToken = tokens.find((t: any) => String(t?.outcome ?? '').toLowerCase() === 'yes') || tokens[0];
        const noToken = tokens.find((t: any) => String(t?.outcome ?? '').toLowerCase() === 'no') || tokens[1];

        const yesTokenId = yesToken?.tokenId ?? yesToken?.token_id ?? yesToken?.id;
        const noTokenId = noToken?.tokenId ?? noToken?.token_id ?? noToken?.id;
        if (!yesTokenId || !noTokenId) throw new Error('Missing token ids');

        const [yesOb, noOb] = await Promise.all([
            this.sdk.clobApi.getOrderbook(yesTokenId),
            this.sdk.clobApi.getOrderbook(noTokenId),
        ]);

        const pick = (rows: any[]) => (Array.isArray(rows) ? rows.slice(0, depth).map((r: any) => ({ price: Number(r.price), size: Number(r.size) })) : []);

        return {
            identifier,
            marketId: resolved.marketId,
            slug: resolved.slug,
            question: market.question,
            tokenIds: { yesTokenId, noTokenId },
            yes: { bids: pick(yesOb?.bids), asks: pick(yesOb?.asks) },
            no: { bids: pick(noOb?.bids), asks: pick(noOb?.asks) },
        };
    }

    async executeManual(params: { identifier: string; yesPrice: number; noPrice: number; size: number; orderType?: 'GTC' | 'GTD' }): Promise<any> {
        if (!this.hasValidKey) {
            const error = "❌ Error: Missing Private Key. Please set POLY_PRIVKEY in .env. API Key provided is not enough for trading.";
            console.error(error);
            return { success: false, error };
        }

        const { identifier, yesPrice, noPrice, size } = params;
        const orderType = params.orderType || 'GTC';
        const resolved = await this.resolveIdentifier(identifier);
        const market = await withRetry(() => this.sdk.clobApi.getMarket(resolved.marketId), { maxRetries: 2 });
        const tokens: any[] = Array.isArray((market as any)?.tokens) ? (market as any).tokens : [];
        const yesToken = tokens.find((t: any) => String(t?.outcome ?? '').toLowerCase() === 'yes') || tokens[0];
        const noToken = tokens.find((t: any) => String(t?.outcome ?? '').toLowerCase() === 'no') || tokens[1];

        const yesTokenId = yesToken?.tokenId ?? yesToken?.token_id ?? yesToken?.id;
        const noTokenId = noToken?.tokenId ?? noToken?.token_id ?? noToken?.id;
        if (!yesTokenId || !noTokenId) throw new Error('Missing token ids');

        const results: any[] = [];

        const place = async (tokenId: string, outcome: string, price: number) => {
            const order = await this.tradingClient.createOrder({
                tokenId,
                price,
                side: 'BUY',
                size,
                orderType,
            });
            results.push({
                tokenId,
                outcome,
                success: !!order.success,
                orderId: order.orderId,
                tx: order.transactionHashes?.[0],
                error: order.success ? undefined : (order.errorMsg || order.rawStatus || 'Order rejected'),
                price,
                size
            });
        };

        await place(yesTokenId, 'Yes', Number(yesPrice));
        await place(noTokenId, 'No', Number(noPrice));

        const openOrders = await this.tradingClient.getOpenOrders(resolved.marketId).catch(() => []);

        const historyEntry = {
            id: Date.now(),
            timestamp: new Date().toISOString(),
            marketId: resolved.marketId,
            marketQuestion: market.question,
            mode: 'manual',
            identifier,
            params: { yesPrice, noPrice, size, orderType },
            results,
            openOrdersCount: openOrders.length
        };

        this.orderHistory.unshift(historyEntry);
        if (this.orderHistory.length > 100) this.orderHistory.pop();
        this.schedulePersistOrderHistory();
        this.schedulePersistOrderHistory();

        return { success: true, marketId: resolved.marketId, question: market.question, results, openOrders };
    }

    async preview(marketId: string, amount: number): Promise<any> {
        const market = await withRetry(() => this.sdk.clobApi.getMarket(marketId), { maxRetries: 2 });
        const tokens = market.tokens;

        if (!tokens || tokens.length < 2) {
            throw new Error("Invalid market tokens");
        }

        const orderbooksMap = new Map();
        let totalAskSum = 0;
        let canCalculate = true;
        const getTokenId = (t: any): string | undefined => t?.token_id ?? t?.tokenId ?? t?.id;

        for (const token of tokens) {
            try {
                const tokenId = getTokenId(token);
                if (!tokenId) {
                    canCalculate = false;
                    continue;
                }
                const ob = await this.sdk.clobApi.getOrderbook(tokenId);
                orderbooksMap.set(tokenId, ob);
                const bestAsk = Number(ob.asks[0]?.price);
                if (!bestAsk) {
                    canCalculate = false;
                } else {
                    totalAskSum += bestAsk;
                }
            } catch (e) {
                canCalculate = false;
            }
        }

        let targetDiscountFactor = 0.90;
        let effectiveDiscountPercent = 10;
        let plannedTotalBidCost = totalAskSum * targetDiscountFactor;

        if (canCalculate) {
            const TARGET_TOTAL_COST = 0.90;
            let scalingFactor = TARGET_TOTAL_COST / totalAskSum;
            if (scalingFactor > 0.99) scalingFactor = 0.99;
            targetDiscountFactor = scalingFactor;
            effectiveDiscountPercent = (1 - targetDiscountFactor) * 100;
            plannedTotalBidCost = totalAskSum * targetDiscountFactor;
        }

        const setsToBuy = plannedTotalBidCost > 0 ? Number((amount / plannedTotalBidCost).toFixed(2)) : 0;

        const legs = tokens.slice(0, 2).map((token: any) => {
            const tokenId = getTokenId(token);
            const ob = tokenId ? orderbooksMap.get(tokenId) : undefined;
            const bestAsk = Number(ob?.asks?.[0]?.price);
            const targetPrice = Number((bestAsk * targetDiscountFactor).toFixed(3));
            let finalPrice = targetPrice;
            if (finalPrice >= bestAsk) finalPrice = bestAsk - 0.001;
            if (finalPrice <= 0) finalPrice = 0.01;
            return {
                outcome: token.outcome,
                tokenId: tokenId,
                currentAsk: bestAsk,
                targetBid: finalPrice,
                size: setsToBuy
            };
        });

        return {
            marketId,
            question: market.question,
            amount,
            totalAsk: totalAskSum,
            targetTotal: plannedTotalBidCost,
            discountFactor: targetDiscountFactor,
            discountPercent: effectiveDiscountPercent,
            setsToBuy,
            legs
        };
    }

    async execute(marketId: string, amount: number): Promise<any> {
        console.log(`🚀 Executing Group Arb for Market: ${marketId}, Amount: $${amount}`);
        
        if (!this.hasValidKey) {
            const error = "❌ Error: Missing Private Key. Please set POLY_PRIVKEY in .env. API Key provided is not enough for trading.";
            console.error(error);
            return { success: false, error };
        }

        const market = await withRetry(() => this.sdk.clobApi.getMarket(marketId), { maxRetries: 2 });
        const tokens = market.tokens;

        if (!tokens || tokens.length < 2) {
            throw new Error("Invalid market tokens");
        }

        const results = [];
        const tokenIds: string[] = [];
        
        // --- STEP 1: Fetch ALL Orderbooks First to Calculate Total Cost ---
        console.log(`   🔍 Fetching orderbooks to calculate spread...`);
        const orderbooksMap = new Map();
        let totalAskSum = 0;
        let canCalculate = true;

        for (const token of tokens as any[]) {
            try {
                const tokenId = token.tokenId ?? token.token_id ?? token.id;
                if (!tokenId) {
                    canCalculate = false;
                    continue;
                }
                const ob = await this.sdk.clobApi.getOrderbook(tokenId);
                orderbooksMap.set(tokenId, ob);
                tokenIds.push(tokenId);
                
                const bestAsk = Number(ob.asks[0]?.price);
                if (!bestAsk) {
                    canCalculate = false; // Missing liquidity on one side
                } else {
                    totalAskSum += bestAsk;
                }
            } catch (e) {
                canCalculate = false;
            }
        }

        // --- STEP 2: Determine Discount Logic (Dynamic Target Cost) ---
        // Goal: Total Bid Cost must be <= $0.90 to guarantee 10% profit.
        // Formula: DiscountFactor = 0.90 / TotalAskSum
        
        let targetDiscountFactor = 0.90; // Default to 10% discount if TotalAsk is 1.00
        let effectiveDiscountPercent = 10;
        let plannedTotalBidCost = totalAskSum * targetDiscountFactor;

        if (canCalculate) {
            const TARGET_TOTAL_COST = 0.90;
            
            // Calculate the scaling factor needed to bring TotalAskSum down to 0.90
            let scalingFactor = TARGET_TOTAL_COST / totalAskSum;
            
            // Safety: Never bid at/above ask
            if (scalingFactor > 0.99) scalingFactor = 0.99;
            
            targetDiscountFactor = scalingFactor;
            effectiveDiscountPercent = (1 - targetDiscountFactor) * 100;
            plannedTotalBidCost = totalAskSum * targetDiscountFactor;

            console.log(`   💰 Total Ask Cost: $${totalAskSum.toFixed(3)}`);
            console.log(`   🎯 Target Cost: $${TARGET_TOTAL_COST.toFixed(2)} (10% Profit Target)`);
            console.log(`   📉 Applied Scaling Factor: ${targetDiscountFactor.toFixed(4)} (${effectiveDiscountPercent.toFixed(1)}% Discount)`);
            
        } else {
            console.warn(`   ⚠️ Could not calculate total spread (missing liquidity). Defaulting to 10% discount.`);
        }

        const setsToBuy = plannedTotalBidCost > 0 ? Number((amount / plannedTotalBidCost).toFixed(2)) : 0;

        // --- STEP 3: Place Orders ---
        for (const token of tokens as any[]) {
            try {
                const tokenId = token.tokenId ?? token.token_id ?? token.id;
                const ob = tokenId ? orderbooksMap.get(tokenId) : undefined;
                if (!ob) continue; // Should have been fetched above

                const bestAsk = Number(ob.asks[0]?.price);
                
                if (!bestAsk) {
                    results.push({ tokenId: tokenId, success: false, error: "No liquidity" });
                    continue;
                }

                if (!tokenId) {
                    results.push({ tokenId: null, success: false, error: "Missing token_id", outcome: token.outcome });
                    continue;
                }

                // Apply the calculated scaling factor
                const targetPrice = Number((bestAsk * targetDiscountFactor).toFixed(3)); 
                
                let finalPrice = targetPrice;
                if (finalPrice >= bestAsk) finalPrice = bestAsk - 0.001;
                if (finalPrice <= 0) finalPrice = 0.01; // Minimum price

                const sharesToBuy = setsToBuy;

                console.log(`   Buying ${token.outcome} (ID: ${token.token_id})`);
                console.log(`      Current Ask: ${bestAsk}`);
                console.log(`      Target Bid: ${finalPrice} (${effectiveDiscountPercent.toFixed(1)}% discount)`);
                console.log(`      Size: ${sharesToBuy} shares`);
                
                const order = await this.tradingClient.createOrder({
                    tokenId: tokenId, 
                    price: finalPrice,
                    side: 'BUY',
                    size: sharesToBuy,
                    orderType: 'GTC', 
                });

                results.push({ 
                    tokenId: tokenId, 
                    success: !!order.success, 
                    orderId: order.orderId, 
                    tx: order.transactionHashes?.[0], 
                    outcome: token.outcome,
                    price: finalPrice,
                    size: sharesToBuy,
                    error: order.success ? undefined : (order.errorMsg || order.rawStatus || 'Order rejected')
                });

            } catch (e: any) {
                console.error(`   Failed to buy ${token.outcome}: ${e.message}`);
                results.push({ tokenId: token.token_id ?? token.tokenId ?? token.id, success: false, error: e.message, outcome: token.outcome });
            }
        }
        
        console.log(`   ⚠️ Orders placed as GTC (Maker). Auto-merge skipped until filled.`);

        const yesAny = results.find((r: any) => String(r?.outcome ?? '').toLowerCase() === 'yes');
        const noAny = results.find((r: any) => String(r?.outcome ?? '').toLowerCase() === 'no');
        const yes = results.find((r: any) => String(r?.outcome ?? '').toLowerCase() === 'yes' && r.orderId) || yesAny;
        const no = results.find((r: any) => String(r?.outcome ?? '').toLowerCase() === 'no' && r.orderId) || noAny;
        if (canCalculate && yes?.orderId && no?.orderId) {
            const settings: StrategySettings = {
                targetProfitPercent: 10,
                cutLossPercent: 25,
                trailingStopPercent: 10,
                oneLegTimeoutMinutes: 10,
                wideSpreadCents: 5,
                forceMarketExitFromPeakPercent: 15,
            };
            this.monitoredPositions.set(marketId, {
                marketId,
                createdAt: Date.now(),
                mode: 'semi',
                settings,
                status: 'orders_live',
                legs: {
                    yes: { outcome: 'Yes', tokenId: yes.tokenId, orderId: yes.orderId, entryPrice: Number(yes.price ?? 0), size: Number(yes.size ?? 0), filledSize: 0, peakMid: Number(yes.price ?? 0), status: 'live' },
                    no: { outcome: 'No', tokenId: no.tokenId, orderId: no.orderId, entryPrice: Number(no.price ?? 0), size: Number(no.size ?? 0), filledSize: 0, peakMid: Number(no.price ?? 0), status: 'live' },
                }
            });
        }

        console.log(`   ⏳ Waiting 1s for order propagation...`);
        await new Promise(r => setTimeout(r, 1000));
        
        let openOrders = [];
        try {
            console.log(`   🔍 Tracking: Fetching Open Orders for Market ${marketId}...`);
            openOrders = await this.tradingClient.getOpenOrders(marketId);
        } catch (e: any) {
            console.error(`   Failed to track orders: ${e.message}`);
        }

        // Store in history
        const historyEntry = {
            id: Date.now(),
            timestamp: new Date().toISOString(),
            marketId,
            marketQuestion: market.question, 
            mode: 'semi',
            amount,
            results,
            openOrdersCount: openOrders.length
        };
        
        // Add to history (limit to 50)
        this.orderHistory.unshift(historyEntry);
        if (this.orderHistory.length > 100) this.orderHistory.pop();
        this.schedulePersistOrderHistory();

        return { success: true, results, openOrders };
    }

    async executeByShares(marketId: string, shares: number, options?: Partial<StrategySettings>): Promise<any> {
        console.log(`🚀 Executing Group Arb (By Shares) for Market: ${marketId}, Shares: ${shares}`);

        if (!this.hasValidKey) {
            const error = "❌ Error: Missing Private Key. Please set POLY_PRIVKEY in .env. API Key provided is not enough for trading.";
            console.error(error);
            return { success: false, error };
        }

        const metaSlug = (options as any)?.slug;
        const metaQuestion = (options as any)?.question;

        const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

        const settings: StrategySettings = {
            targetProfitPercent: Number(options?.targetProfitPercent ?? 10),
            cutLossPercent: Number(options?.cutLossPercent ?? 25),
            trailingStopPercent: Number(options?.trailingStopPercent ?? 10),
            enableOneLegTimeout: (options as any)?.enableOneLegTimeout ?? true,
            oneLegTimeoutMinutes: clamp(Number(options?.oneLegTimeoutMinutes ?? 10), 1, 120),
            autoCancelUnfilledOnTimeout: (options as any)?.autoCancelUnfilledOnTimeout ?? true,
            wideSpreadCents: Number(options?.wideSpreadCents ?? 5),
            forceMarketExitFromPeakPercent: Number(options?.forceMarketExitFromPeakPercent ?? 15),
            enableHedgeComplete: (options as any)?.enableHedgeComplete ?? false,
            oneLegTimeoutAction: (options?.oneLegTimeoutAction as any) || 'UNWIND_EXIT',
            maxSpreadCentsForHedge: Number(options?.maxSpreadCentsForHedge ?? 5),
            maxSlippageCents: Number(options?.maxSlippageCents ?? 2),
        };
        if (!settings.enableHedgeComplete) settings.oneLegTimeoutAction = 'UNWIND_EXIT';

        const market = await withRetry(() => this.sdk.clobApi.getMarket(marketId), { maxRetries: 2 });
        const tokens = market.tokens;
        if (!tokens || tokens.length < 2) throw new Error("Invalid market tokens");

        const getTokenId = (t: any): string | undefined => t?.token_id ?? t?.tokenId ?? t?.id;

        const orderbooksMap = new Map<string, any>();
        let totalAskSum = 0;
        let canCalculate = true;

        for (const token of tokens) {
            try {
                const tokenId = getTokenId(token);
                if (!tokenId) { canCalculate = false; continue; }
                const ob = await this.sdk.clobApi.getOrderbook(tokenId);
                orderbooksMap.set(tokenId, ob);
                const bestAsk = Number(ob.asks[0]?.price);
                if (!bestAsk) canCalculate = false;
                else totalAskSum += bestAsk;
            } catch {
                canCalculate = false;
            }
        }

        if (!canCalculate || totalAskSum <= 0) throw new Error('Cannot calculate order prices (missing liquidity).');

        const targetTotalCost = Math.max(0.01, 1 - (settings.targetProfitPercent / 100));
        let scalingFactor = targetTotalCost / totalAskSum;
        if (scalingFactor > 0.99) scalingFactor = 0.99;

        const results: any[] = [];
        for (const token of tokens) {
            const tokenId = getTokenId(token);
            if (!tokenId) continue;
            const ob = orderbooksMap.get(tokenId);
            const bestAsk = Number(ob?.asks?.[0]?.price);
            if (!bestAsk) {
                results.push({ tokenId, success: false, error: "No liquidity", outcome: token.outcome });
                continue;
            }

            const targetPrice = Number((bestAsk * scalingFactor).toFixed(4));
            let finalPrice = targetPrice;
            if (finalPrice >= bestAsk) finalPrice = bestAsk - 0.0001;
            if (finalPrice <= 0) finalPrice = 0.01;

            const order = await this.tradingClient.createOrder({
                tokenId,
                price: finalPrice,
                side: 'BUY',
                size: shares,
                orderType: 'GTC',
            });

            results.push({
                tokenId,
                outcome: token.outcome,
                success: !!order.success,
                orderId: order.orderId,
                tx: order.transactionHashes?.[0],
                error: order.success ? undefined : (order.errorMsg || order.rawStatus || 'Order rejected'),
                price: finalPrice,
                size: shares
            });
        }

        await new Promise(r => setTimeout(r, 1000));
        const openOrders = await this.tradingClient.getOpenOrders(marketId).catch(() => []);

        const historyEntry = {
            id: Date.now(),
            timestamp: new Date().toISOString(),
            marketId,
            marketQuestion: metaQuestion || market.question,
            slug: metaSlug || undefined,
            mode: 'semi',
            shares,
            settings,
            results,
            openOrdersCount: openOrders.length
        };

        this.orderHistory.unshift(historyEntry);
        if (this.orderHistory.length > 100) this.orderHistory.pop();

        const yes = results.find((r: any) => String(r?.outcome ?? '').toLowerCase() === 'yes' && r.orderId);
        const no = results.find((r: any) => String(r?.outcome ?? '').toLowerCase() === 'no' && r.orderId);
        if (yes?.orderId || no?.orderId) {
            this.monitoredPositions.set(marketId, {
                marketId,
                createdAt: Date.now(),
                mode: 'semi',
                settings,
                status: 'orders_live',
                legs: {
                    yes: { outcome: 'Yes', tokenId: yes?.tokenId, orderId: yes?.orderId, entryPrice: Number(yes?.price ?? 0), size: shares, filledSize: 0, peakMid: Number(yes?.price ?? 0), status: yes?.orderId ? 'live' : 'closed' },
                    no: { outcome: 'No', tokenId: no?.tokenId, orderId: no?.orderId, entryPrice: Number(no?.price ?? 0), size: shares, filledSize: 0, peakMid: Number(no?.price ?? 0), status: no?.orderId ? 'live' : 'closed' },
                }
            });
        }

        return { success: true, results, openOrders };
    }

    // Monitoring Loop for Cut Loss / Trailing Stop
    private async startMonitoring() {
        setInterval(async () => {
            if (this.monitoredPositions.size === 0) return;

            for (const [marketId, pos] of this.monitoredPositions) {
                if (pos.status === 'exited') {
                    this.monitoredPositions.delete(marketId);
                    continue;
                }

                const elapsedMinutes = (Date.now() - pos.createdAt) / (1000 * 60);

                const updateLeg = async (leg: MonitoredLeg) => {
                    try {
                        if (!leg.orderId) return;
                        const o = await this.tradingClient.getOrder(leg.orderId);
                        const filled = Number(o?.filledSize ?? o?.sizeMatched ?? 0);
                        leg.filledSize = Number.isFinite(filled) ? filled : leg.filledSize;
                        const status = String(o?.status ?? '').toUpperCase();
                        if (status === 'LIVE') leg.status = 'live';
                        else if (leg.filledSize > 0) leg.status = 'filled';
                        else leg.status = 'closed';
                    } catch {
                    }
                };

                await Promise.all([updateLeg(pos.legs.yes), updateLeg(pos.legs.no)]);

                const yesFilled = pos.legs.yes.filledSize > 0;
                const noFilled = pos.legs.no.filledSize > 0;

                if (yesFilled && noFilled) {
                    pos.status = 'both_legs_filled';
                    continue;
                }

                if (!yesFilled && !noFilled) {
                    pos.status = 'orders_live';
                    if (pos.settings.enableOneLegTimeout && elapsedMinutes >= pos.settings.oneLegTimeoutMinutes && pos.settings.autoCancelUnfilledOnTimeout) {
                        await Promise.allSettled([
                            pos.legs.yes.orderId ? this.tradingClient.cancelOrder(pos.legs.yes.orderId) : Promise.resolve(),
                            pos.legs.no.orderId ? this.tradingClient.cancelOrder(pos.legs.no.orderId) : Promise.resolve(),
                        ]);
                        pos.status = 'exited';
                        this.orderHistory.unshift({
                            id: Date.now(),
                            timestamp: new Date().toISOString(),
                            marketId,
                            mode: 'auto',
                            originMode: pos.mode,
                            action: 'timeout_cancel',
                            details: { oneLegTimeoutMinutes: pos.settings.oneLegTimeoutMinutes }
                        });
                        if (this.orderHistory.length > 100) this.orderHistory.pop();
                        this.schedulePersistOrderHistory();
                    }
                    continue;
                }

                pos.status = 'one_leg_filled';
                const filledLeg = yesFilled ? pos.legs.yes : pos.legs.no;
                const otherLeg = yesFilled ? pos.legs.no : pos.legs.yes;

                if (pos.settings.enableOneLegTimeout && elapsedMinutes >= pos.settings.oneLegTimeoutMinutes) {
                    if (pos.settings.enableHedgeComplete && pos.settings.oneLegTimeoutAction === 'HEDGE_COMPLETE') {
                        try {
                            if (otherLeg.tokenId) {
                                const ob = await this.sdk.clobApi.getOrderbook(otherLeg.tokenId);
                                const bestAsk = Number(ob?.asks?.[0]?.price) || 0;
                                const bestBid = Number(ob?.bids?.[0]?.price) || 0;
                                const spreadCents = bestAsk > 0 && bestBid > 0 ? (bestAsk - bestBid) * 100 : 0;
                                const slippageCents = otherLeg.entryPrice > 0 && bestAsk > 0 ? (bestAsk - otherLeg.entryPrice) * 100 : 0;

                                if (bestAsk > 0 && spreadCents <= Number(pos.settings.maxSpreadCentsForHedge ?? 5) && slippageCents <= Number(pos.settings.maxSlippageCents ?? 2)) {
                                    if (otherLeg.orderId) {
                                        this.systemCanceledOrderIds.add(otherLeg.orderId);
                                        await Promise.allSettled([this.tradingClient.cancelOrder(otherLeg.orderId)]);
                                    }

                                    const remainingShares = Math.max(0, Number(filledLeg.filledSize || filledLeg.size));
                                    const amountDollars = Math.max(0.01, remainingShares * bestAsk);
                                    const hedge = await this.tradingClient.createMarketOrder({
                                        tokenId: otherLeg.tokenId,
                                        side: 'BUY',
                                        amount: amountDollars,
                                        orderType: 'FAK',
                                    });

                                    this.orderHistory.unshift({
                                        id: Date.now(),
                                        timestamp: new Date().toISOString(),
                                        marketId,
                                        mode: 'auto',
                                        originMode: pos.mode,
                                        action: 'hedge_complete',
                                        leg: otherLeg.outcome,
                                        result: hedge
                                    });
                                    if (this.orderHistory.length > 100) this.orderHistory.pop();
                                    this.schedulePersistOrderHistory();
                                }
                            }
                        } catch {
                        }
                    } else if (pos.settings.autoCancelUnfilledOnTimeout) {
                        if (otherLeg.status === 'live' && otherLeg.orderId) {
                            this.systemCanceledOrderIds.add(otherLeg.orderId);
                            await Promise.allSettled([this.tradingClient.cancelOrder(otherLeg.orderId)]);
                            otherLeg.status = 'closed';
                        }
                    }
                }

                try {
                    const ob = await this.sdk.clobApi.getOrderbook(filledLeg.tokenId);
                    const bestBid = Number(ob?.bids?.[0]?.price) || 0;
                    const bestAsk = Number(ob?.asks?.[0]?.price) || 0;
                    const mid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : (bestBid || bestAsk);
                    if (!mid) continue;

                    filledLeg.peakMid = Math.max(filledLeg.peakMid || mid, mid);

                    const entry = filledLeg.entryPrice || mid;
                    const cutLossTrigger = entry * (1 - pos.settings.cutLossPercent / 100);
                    const trailingTrigger = filledLeg.peakMid * (1 - pos.settings.trailingStopPercent / 100);
                    const forceTrigger = filledLeg.peakMid * (1 - pos.settings.forceMarketExitFromPeakPercent / 100);

                    const spreadCents = bestBid > 0 && bestAsk > 0 ? (bestAsk - bestBid) * 100 : 0;

                    const sellNow = async (reason: string) => {
                        const cancelIfPresent = (orderId?: string) => {
                            if (!orderId) return Promise.resolve();
                            this.systemCanceledOrderIds.add(orderId);
                            return this.tradingClient.cancelOrder(orderId);
                        };

                        await Promise.allSettled([
                            cancelIfPresent(pos.legs.yes.orderId),
                            cancelIfPresent(pos.legs.no.orderId),
                        ]);

                        const sizeToSell = Math.min(filledLeg.filledSize || filledLeg.size, filledLeg.size);
                        const attempt1 = await this.tradingClient.createMarketOrder({
                            tokenId: filledLeg.tokenId,
                            side: 'SELL',
                            amount: sizeToSell,
                            orderType: 'FAK',
                        });

                        const attempt2 = attempt1?.success ? null : await this.tradingClient.createMarketOrder({
                            tokenId: filledLeg.tokenId,
                            side: 'SELL',
                            amount: sizeToSell,
                            price: bestBid > 0 ? bestBid : undefined,
                            orderType: 'FAK',
                        });

                        const sell = attempt2 || attempt1;
                        const fallbackLimit = sell?.success || !(bestBid > 0) ? null : await this.tradingClient.createOrder({
                            tokenId: filledLeg.tokenId,
                            side: 'SELL',
                            price: bestBid,
                            size: sizeToSell,
                            orderType: 'GTC',
                        });

                        this.orderHistory.unshift({
                            id: Date.now(),
                            timestamp: new Date().toISOString(),
                            marketId,
                            mode: 'auto',
                            originMode: pos.mode,
                            action: 'exit_one_leg',
                            reason,
                            remark: 'risk_exit_aggressive_market',
                            leg: filledLeg.outcome,
                            entryPrice: entry,
                            mid,
                            peakMid: filledLeg.peakMid,
                            spreadCents,
                            result: fallbackLimit?.success ? { ...fallbackLimit, method: 'limit_best_bid' } : { ...sell, method: attempt1?.success ? 'market_fak' : 'market_fak_with_price', fallbackLimit }
                        });
                        if (this.orderHistory.length > 100) this.orderHistory.pop();
                        this.schedulePersistOrderHistory();
                        if (sell?.success || fallbackLimit?.success) {
                            pos.status = 'exited';
                        } else {
                            pos.status = 'one_leg_filled';
                        }
                    };

                    if (mid <= cutLossTrigger) {
                        await sellNow('cut_loss');
                    } else if (mid <= forceTrigger) {
                        await sellNow('force_market_from_peak');
                    } else if (mid <= trailingTrigger) {
                        if (spreadCents > pos.settings.wideSpreadCents) {
                            await sellNow('trailing_wide_spread');
                        } else {
                            await sellNow('trailing_stop');
                        }
                    }
                } catch {
                }
            }
        }, 15000);
    }
}
