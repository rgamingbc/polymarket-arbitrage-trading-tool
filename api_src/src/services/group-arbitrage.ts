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
    private pnlSnapshots: Array<{ ts: number; equity: number; cash: number; positionsValue: number }> = [];
    private pnlTimer: any = null;
    private pnlPersistencePath: string;
    private pnlWriteTimer: any = null;
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
    private crypto15mAutoTimer: any = null;
    private crypto15mAutoInFlight = false;
    private crypto15mAutoConfig: { pollMs: number; expiresWithinSec: number; minProb: number; amountUsd: number; staleMsThreshold: number } = { pollMs: 2_000, expiresWithinSec: 180, minProb: 0.9, amountUsd: 1, staleMsThreshold: 2500 };
    private crypto15mLastScanAt: string | null = null;
    private crypto15mLastError: string | null = null;
    private crypto15mOrderLocks: Map<string, { atMs: number; symbol: string; expiresAtMs: number; conditionId: string; status: 'placing' | 'ordered' | 'failed' }> = new Map();
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
    private crypto15mActivesBySymbol: Map<string, any> = new Map();
    private crypto15mTrackedByCondition: Map<string, any> = new Map();
    private crypto15mCooldownUntilBySymbol: Map<string, number> = new Map();
    private crypto15mBeatCache: Map<string, { atMs: number; priceToBeat: number | null; currentPrice: number | null; deltaAbs: number | null; error: string | null }> = new Map();
    private crypto15mCryptoTagId: string | null = null;
    private crypto15mNextScanAllowedAtMs = 0;
    private crypto15mMarketSnapshot: { atMs: number; markets: any[]; lastError: string | null } = { atMs: 0, markets: [], lastError: null };
    private crypto15mBooksSnapshot: { atMs: number; byTokenId: Record<string, any>; lastError: string | null; lastAttemptAtMs: number; lastAttemptError: string | null } = { atMs: 0, byTokenId: {}, lastError: null, lastAttemptAtMs: 0, lastAttemptError: null };
    private crypto15mMarketInFlight: Promise<void> | null = null;
    private crypto15mBooksInFlight: Promise<void> | null = null;
    private crypto15mMarketBackoffMs = 0;
    private crypto15mMarketNextAllowedAtMs = 0;
    private crypto15mBooksBackoffMs = 0;
    private crypto15mBooksNextAllowedAtMs = 0;
    private crypto15mWsClients: Map<any, { minProb: number; expiresWithinSec: number; limit: number }> = new Map();
    private crypto15mWsTimer: any = null;
    private cryptoAllAutoEnabled = false;
    private cryptoAllAutoTimer: any = null;
    private cryptoAllAutoInFlight = false;
    private cryptoAllStoplossTimer: any = null;
    private cryptoAllLastScanSummary: any = null;
    private cryptoAllAutoConfig: {
        pollMs: number;
        expiresWithinSec: number;
        minProb: number;
        amountUsd: number;
        symbols: string[];
        timeframes: Array<'15m' | '1h' | '4h' | '1d'>;
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
    } = {
        pollMs: 2_000,
        expiresWithinSec: 180,
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
    };
    private cryptoAllLastScanAt: string | null = null;
    private cryptoAllLastError: string | null = null;
    private cryptoAllOrderLocks: Map<string, { atMs: number; key: string; expiresAtMs: number; conditionId: string; status: 'placing' | 'ordered' | 'failed' }> = new Map();
    private cryptoAllDeltaThresholdsPath: string | null = null;
    private cryptoAllDeltaThresholds: { btcMinDelta: number; ethMinDelta: number; solMinDelta: number; xrpMinDelta: number; updatedAt: string | null; loadedAt: string | null; persistLastError: string | null } = {
        btcMinDelta: 600,
        ethMinDelta: 30,
        solMinDelta: 0.8,
        xrpMinDelta: 0.0065,
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
    private cryptoAllAddOnState: Map<string, { positionKey: string; conditionId: string; tokenId: string; direction: 'Up' | 'Down'; outcomeIndex: number; symbol: string; timeframe: '15m' | '1h' | '4h' | '1d'; endMs: number; placedA: boolean; placedB: boolean; placedC: boolean; totalStakeUsd: number; lastAttemptAtMs: number }> = new Map();
    private cryptoAllStoplossState: Map<string, { positionKey: string; conditionId: string; tokenId: string; symbol: string; timeframe: '15m' | '1h' | '4h' | '1d'; endMs: number; entryPrice: number; totalSize: number; soldSize: number; soldCut1: boolean; soldCut2: boolean; lastAttemptAtMs: number }> = new Map();
    private cryptoAllBeatCache: Map<string, { atMs: number; priceToBeat: number | null; currentPrice: number | null; deltaAbs: number | null; error: string | null }> = new Map();
    private cryptoAllBinanceCandleCache: Map<string, { atMs: number; startMs: number; open: number | null; high: number | null; low: number | null; close: number | null; closes1m: number[]; error: string | null }> = new Map();
    private cryptoAllMarketSnapshot: { atMs: number; markets: any[]; lastError: string | null; lastAttemptAtMs: number; lastAttemptError: string | null } = { atMs: 0, markets: [], lastError: null, lastAttemptAtMs: 0, lastAttemptError: null };
    private cryptoAllBooksSnapshot: { atMs: number; byTokenId: Record<string, any>; lastError: string | null; lastAttemptAtMs: number; lastAttemptError: string | null } = { atMs: 0, byTokenId: {}, lastError: null, lastAttemptAtMs: 0, lastAttemptError: null };
    private cryptoAllMarketInFlight: Promise<void> | null = null;
    private cryptoAllBooksInFlight: Promise<void> | null = null;
    private cryptoAllMarketBackoffMs = 0;
    private cryptoAllMarketNextAllowedAtMs = 0;
    private cryptoAllBooksBackoffMs = 0;
    private cryptoAllBooksNextAllowedAtMs = 0;
    private cryptoAllWsClients: Map<any, { symbols: string[]; timeframes: Array<'15m' | '1h' | '4h' | '1d'>; minProb: number; expiresWithinSec: number; limit: number; includeCandidates: boolean }> = new Map();
    private cryptoAllWsTimer: any = null;
    private cryptoAllSnapshotTimer: any = null;
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

    constructor(privateKey?: string) {
        this.sdk = new PolymarketSDK({
            privateKey,
        } as any);

        this.hasValidKey = !!privateKey && privateKey.length > 50; // Simple check
        const effectiveKey = this.hasValidKey ? privateKey! : '0x0000000000000000000000000000000000000000000000000000000000000001';
        this.rpcPrivateKey = effectiveKey;

        // Initialize Trading Client manually since SDK doesn't expose it publically
        const rateLimiter = new RateLimiter(); 
        
        const proxyAddress = process.env.POLY_PROXY_ADDRESS;

        this.tradingClient = new TradingClient(rateLimiter, {
            privateKey: effectiveKey,
            chainId: 137,
            proxyAddress: proxyAddress
        });

        if (this.hasValidKey) {
            this.relayerConfigPath = process.env.POLY_RELAYER_CONFIG_PATH
                ? String(process.env.POLY_RELAYER_CONFIG_PATH)
                : path.join(os.tmpdir(), 'polymarket-tools', 'relayer.json');
            this.autoRedeemConfigPath = process.env.POLY_AUTO_REDEEM_CONFIG_PATH
                ? String(process.env.POLY_AUTO_REDEEM_CONFIG_PATH)
                : path.join(os.tmpdir(), 'polymarket-tools', 'auto-redeem.json');
            this.orderHistoryPath = process.env.POLY_ORDER_HISTORY_PATH
                ? String(process.env.POLY_ORDER_HISTORY_PATH)
                : path.join(os.tmpdir(), 'polymarket-tools', 'history.json');
            this.crypto15mDeltaThresholdsPath = process.env.POLY_CRYPTO15M_DELTA_THRESHOLDS_PATH
                ? String(process.env.POLY_CRYPTO15M_DELTA_THRESHOLDS_PATH)
                : path.join(os.tmpdir(), 'polymarket-tools', 'crypto15m-delta-thresholds.json');
            this.cryptoAllDeltaThresholdsPath = process.env.POLY_CRYPTOALL_DELTA_THRESHOLDS_PATH
                ? String(process.env.POLY_CRYPTOALL_DELTA_THRESHOLDS_PATH)
                : path.join(os.tmpdir(), 'polymarket-tools', 'cryptoall-delta-thresholds.json');
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
            this.loadCryptoAllDeltaThresholdsFromFile();
        }

        this.pnlPersistencePath = process.env.POLY_PNL_SNAPSHOT_PATH
            ? String(process.env.POLY_PNL_SNAPSHOT_PATH)
            : path.join(os.tmpdir(), 'polymarket-tools', 'pnl-snapshots.json');
        
        // Initialize async
        this.tradingClient.initialize().catch((e: any) => console.error('Failed to init trading client:', e));
        
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
            marketSnapshot: {
                atMs: this.crypto15mMarketSnapshot.atMs,
                at: this.crypto15mMarketSnapshot.atMs ? new Date(this.crypto15mMarketSnapshot.atMs).toISOString() : null,
                lastError: this.crypto15mMarketSnapshot.lastError,
                backoffMs: this.crypto15mMarketBackoffMs || 0,
                nextAllowedAtMs: this.crypto15mMarketNextAllowedAtMs || 0,
                nextAllowedAt: this.crypto15mMarketNextAllowedAtMs ? new Date(this.crypto15mMarketNextAllowedAtMs).toISOString() : null,
                marketCount: Array.isArray(this.crypto15mMarketSnapshot.markets) ? this.crypto15mMarketSnapshot.markets.length : 0,
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
        const positions = await this.fetchDataApiPositions(funder).catch(() => []);
        const byCondition = new Map(
            (Array.isArray(positions) ? positions : [])
                .map((p: any) => [String(p?.conditionId || '').trim().toLowerCase(), p] as const)
                .filter(([k]) => !!k)
        );

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
                const stakeUsd = Number(e?.amountUsd) || 0;
                const realizedPnlUsdc =
                    redeemConfirmed
                        ? (payoutNetUsdc != null ? Number(payoutNetUsdc) - stakeUsd : (paid === false ? 0 - stakeUsd : null))
                        : null;
                return {
                    id: e?.id,
                    timestamp: e?.timestamp,
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

    async getCryptoAllHistory(options?: { refresh?: boolean; intervalMs?: number; maxEntries?: number }) {
        const refresh = options?.refresh === true;
        const intervalMs = options?.intervalMs != null ? Number(options.intervalMs) : 1000;
        const maxEntries = options?.maxEntries != null ? Math.max(1, Math.floor(Number(options.maxEntries))) : 50;
        if (refresh) {
            await this.refreshHistoryStatuses({ minIntervalMs: intervalMs, maxEntries: Math.max(50, maxEntries) });
        }
        const funder = this.getFunderAddress();
        const positions = await this.fetchDataApiPositions(funder).catch(() => []);
        const byCondition = new Map(
            (Array.isArray(positions) ? positions : [])
                .map((p: any) => [String(p?.conditionId || '').trim().toLowerCase(), p] as const)
                .filter(([k]) => !!k)
        );

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
        try {
            return await this.withTimeout(tryOnce(), 2_500, 'Data API positions');
        } catch {
            await new Promise(r => setTimeout(r, 300));
            try {
                return await this.withTimeout(tryOnce(), 2_500, 'Data API positions retry');
            } catch {
                return [];
            }
        }
    }

    private async fetchDataApiPositionsValue(user: string): Promise<number> {
        const u = String(user || '').trim();
        if (!u) return 0;
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
            return await this.withTimeout(tryOnce(), 2_500, 'Data API value');
        } catch {
            await new Promise(r => setTimeout(r, 300));
            try {
                return await this.withTimeout(tryOnce(), 2_500, 'Data API value retry');
            } catch {
                return 0;
            }
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

    getCryptoAllDeltaThresholds() {
        return {
            btcMinDelta: this.cryptoAllDeltaThresholds.btcMinDelta,
            ethMinDelta: this.cryptoAllDeltaThresholds.ethMinDelta,
            solMinDelta: this.cryptoAllDeltaThresholds.solMinDelta,
            xrpMinDelta: this.cryptoAllDeltaThresholds.xrpMinDelta,
            updatedAt: this.cryptoAllDeltaThresholds.updatedAt,
            loadedAt: this.cryptoAllDeltaThresholds.loadedAt,
            persistLastError: this.cryptoAllDeltaThresholds.persistLastError,
            configPath: this.cryptoAllDeltaThresholdsPath,
            configFilePresent: this.cryptoAllDeltaThresholdsPath ? fs.existsSync(this.cryptoAllDeltaThresholdsPath) : false,
        };
    }

    setCryptoAllDeltaThresholds(input: { btcMinDelta?: number; ethMinDelta?: number; solMinDelta?: number; xrpMinDelta?: number; persist?: boolean }) {
        const btc = input.btcMinDelta != null ? Number(input.btcMinDelta) : this.cryptoAllDeltaThresholds.btcMinDelta;
        const eth = input.ethMinDelta != null ? Number(input.ethMinDelta) : this.cryptoAllDeltaThresholds.ethMinDelta;
        const sol = input.solMinDelta != null ? Number(input.solMinDelta) : this.cryptoAllDeltaThresholds.solMinDelta;
        const xrp = input.xrpMinDelta != null ? Number(input.xrpMinDelta) : this.cryptoAllDeltaThresholds.xrpMinDelta;
        this.cryptoAllDeltaThresholds = {
            ...this.cryptoAllDeltaThresholds,
            btcMinDelta: Math.max(0, btc),
            ethMinDelta: Math.max(0, eth),
            solMinDelta: Math.max(0, sol),
            xrpMinDelta: Math.max(0, xrp),
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
            const btcMinDelta = parsed?.btcMinDelta != null ? Number(parsed.btcMinDelta) : this.cryptoAllDeltaThresholds.btcMinDelta;
            const ethMinDelta = parsed?.ethMinDelta != null ? Number(parsed.ethMinDelta) : this.cryptoAllDeltaThresholds.ethMinDelta;
            const solMinDelta = parsed?.solMinDelta != null ? Number(parsed.solMinDelta) : this.cryptoAllDeltaThresholds.solMinDelta;
            const xrpMinDelta = parsed?.xrpMinDelta != null ? Number(parsed.xrpMinDelta) : this.cryptoAllDeltaThresholds.xrpMinDelta;
            this.cryptoAllDeltaThresholds = {
                ...this.cryptoAllDeltaThresholds,
                btcMinDelta: Number.isFinite(btcMinDelta) ? Math.max(0, btcMinDelta) : this.cryptoAllDeltaThresholds.btcMinDelta,
                ethMinDelta: Number.isFinite(ethMinDelta) ? Math.max(0, ethMinDelta) : this.cryptoAllDeltaThresholds.ethMinDelta,
                solMinDelta: Number.isFinite(solMinDelta) ? Math.max(0, solMinDelta) : this.cryptoAllDeltaThresholds.solMinDelta,
                xrpMinDelta: Number.isFinite(xrpMinDelta) ? Math.max(0, xrpMinDelta) : this.cryptoAllDeltaThresholds.xrpMinDelta,
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
                JSON.stringify({
                    btcMinDelta: this.cryptoAllDeltaThresholds.btcMinDelta,
                    ethMinDelta: this.cryptoAllDeltaThresholds.ethMinDelta,
                    solMinDelta: this.cryptoAllDeltaThresholds.solMinDelta,
                    xrpMinDelta: this.cryptoAllDeltaThresholds.xrpMinDelta,
                }),
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
                    if (this.orderHistory.length > 50) this.orderHistory.pop();
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
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 3_000);
        const res = await this.withTimeout(
            fetch(url, { headers, signal: controller.signal }).finally(() => clearTimeout(t)),
            3_500,
            `Gamma fetch ${url}`
        );
        if (!res.ok) {
            const retryAfter = res.headers?.get ? res.headers.get('retry-after') : null;
            const err: any = new Error(`Gamma API failed (${res.status})`);
            if (res.status === 429) {
                const sec = retryAfter != null && retryAfter !== '' ? Number(retryAfter) : NaN;
                err.retryAfterMs = Number.isFinite(sec) ? Math.max(1, sec) * 1000 : 60_000;
            }
            throw err;
        }
        return await this.withTimeout(res.json(), 5_000, `Gamma json ${url}`);
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
            const tags = await this.fetchGammaJson('https://gamma-api.polymarket.com/tags?limit=200');
            const list = Array.isArray(tags) ? tags : [];
            const t = list.find((x: any) => String(x?.slug || '').toLowerCase() === 'crypto' || String(x?.label || '').toLowerCase() === 'crypto');
            const id = t?.id != null ? String(t.id) : null;
            if (id) this.crypto15mCryptoTagId = id;
            return id;
        } catch {
            return null;
        }
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
        return { success: true, sources, config: this.cryptoAllAutoConfig, risk };
    }

    private inferCryptoTimeframeFromSlug(slug: string, title: string): '15m' | '1h' | '4h' | '1d' | null {
        const s = String(slug || '').toLowerCase();
        const t = String(title || '').toLowerCase();
        const hay = `${s} ${t}`;
        if (hay.includes('15m') || hay.includes('15-min') || hay.includes('15min')) return '15m';
        if (hay.includes('1h') || hay.includes('1-hr') || hay.includes('1hr') || hay.includes('hourly')) return '1h';
        if (hay.includes('4h') || hay.includes('4-hr') || hay.includes('4hr') || hay.includes('4-hour') || hay.includes('4hour')) return '4h';
        if (hay.includes('1d') || hay.includes('1-day') || hay.includes('1day') || hay.includes('daily')) return '1d';
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

    private getCryptoAllTimeframeSec(tf: '15m' | '1h' | '4h' | '1d'): number {
        if (tf === '1h') return 60 * 60;
        if (tf === '4h') return 4 * 60 * 60;
        if (tf === '1d') return 24 * 60 * 60;
        return 15 * 60;
    }

    private getCryptoAllListPaths(tf: '15m' | '1h' | '4h' | '1d'): string[] {
        if (tf === '15m') return ['/crypto/15M'];
        if (tf === '1h') return ['/crypto/hourly'];
        if (tf === '4h') return ['/crypto/4H', '/crypto/4-hour', '/crypto/4hour', '/crypto/4-hours'];
        return ['/crypto/daily', '/crypto/1D', '/crypto/1d'];
    }

    private predictCryptoAllSlugs(tf: '15m' | '1h' | '4h' | '1d', nowSec: number, symbols: string[]): string[] {
        const tfSec = this.getCryptoAllTimeframeSec(tf);
        const baseStart = Math.floor(nowSec / tfSec) * tfSec;
        const starts = [baseStart - tfSec, baseStart, baseStart + tfSec, baseStart + 2 * tfSec];
        const symList = symbols.length ? symbols : ['BTC', 'ETH', 'SOL', 'XRP'];
        const tfTokens =
            tf === '15m' ? ['15m', '15M', '15min', '15mins']
            : tf === '1h' ? ['1h', '1H', '1hr', 'hourly']
            : tf === '4h' ? ['4h', '4H', '4hr', '4hour', '4-hour']
            : ['1d', '1D', 'daily', '1day', '1-day'];
        const slugs: string[] = [];
        for (const sym of symList) {
            const s = String(sym || '').toLowerCase();
            for (const token of tfTokens) {
                const t = String(token || '').toLowerCase();
                const prefix = `${s}-updown-${t}`;
                for (const st of starts) {
                    slugs.push(`${prefix}-${Math.floor(st)}`);
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

    private async fetchClobBooks(tokenIds: string[]): Promise<any[]> {
        const ids = Array.from(new Set((tokenIds || []).map((t) => String(t || '').trim()).filter((t) => t)));
        if (!ids.length) return [];
        const sortedKey = ids.slice().sort().join(',');
        const cache = (this as any).clobBooksCache as Map<string, { atMs: number; data: any[] }> | undefined;
        const cached = cache?.get(sortedKey);
        if (cached && Date.now() - cached.atMs < 1200) return cached.data;
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
                            },
                            body: JSON.stringify(chunkIds.map((token_id) => ({ token_id }))),
                            signal: controller.signal,
                        }).finally(() => clearTimeout(t)),
                        timeoutMs + 500,
                        'CLOB /books'
                    );
                    if (!res.ok) {
                        let detail: any = null;
                        try { detail = await res.json(); } catch {}
                        throw new Error(`CLOB /books failed (${res.status}): ${detail?.error || detail?.message || 'unknown'}`);
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
            (this as any).clobBooksCache.set(sortedKey, { atMs: Date.now(), data: out });
            return out;
        } finally {
        }
    }

    private async refreshCrypto15mMarketSnapshot(): Promise<void> {
        if (this.crypto15mMarketInFlight) return this.crypto15mMarketInFlight;
        if (this.crypto15mMarketNextAllowedAtMs && Date.now() < this.crypto15mMarketNextAllowedAtMs) return;
        this.crypto15mMarketInFlight = (async () => {
            try {
                const now = Date.now();
                const nowSec = Math.floor(now / 1000);
                const is15m = (m: any) => {
                    const title = String(m?.question || m?.title || '').toLowerCase();
                    const slug = String(m?.slug || '').toLowerCase();
                    const has15m = /\b15\s*(m|min|mins|minute|minutes)\b/.test(title) || slug.includes('15m') || slug.includes('15-min') || slug.includes('-15m-');
                    const hasUpDown = title.includes('up or down') || title.includes('up/down') || title.includes('updown') || slug.includes('updown');
                    return has15m && hasUpDown;
                };
                const priorityPrefixes = ['btc-updown-15m', 'eth-updown-15m', 'sol-updown-15m', 'xrp-updown-15m'];
                const getSymbolFromSlug = (slug: string): string | null => {
                    const s = String(slug || '').toLowerCase();
                    if (s.startsWith('btc-')) return 'BTC';
                    if (s.startsWith('eth-')) return 'ETH';
                    if (s.startsWith('sol-')) return 'SOL';
                    if (s.startsWith('xrp-')) return 'XRP';
                    return null;
                };
                const parseStartSecFromSlug = (slug: string): number | null => {
                    const parts = String(slug || '').split('-');
                    const last = parts[parts.length - 1];
                    const n = Number(last);
                    if (!Number.isFinite(n)) return null;
                    if (n < 1_500_000_000) return null;
                    return Math.floor(n);
                };
                const baseStart = Math.floor(nowSec / (15 * 60)) * (15 * 60);
                const starts = [baseStart - 15 * 60, baseStart, baseStart + 15 * 60, baseStart + 30 * 60];
                const predictedSlugs = Array.from(new Set(priorityPrefixes.flatMap((p) => starts.map((s) => `${p}-${s}`))));
                const orderedSlugs = predictedSlugs.slice(0, 12);
                const settled = await Promise.allSettled(orderedSlugs.map(async (slug) => {
                    const url = `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`;
                    const data = await this.withTimeout(this.fetchGammaJson(url), 2_000, `Gamma slug ${slug}`);
                    const list = Array.isArray(data) ? data : [];
                    return list[0] || null;
                }));
                const markets: any[] = [];
                for (const r of settled) {
                    if (r.status !== 'fulfilled') continue;
                    if (r.value) markets.push(r.value);
                }
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
                    const tokenIds = this.tryParseJsonArray(m?.clobTokenIds);
                    if (outcomes.length < 2 || tokenIds.length < 2) continue;
                    const outsLower = outcomes.map((x) => String(x).toLowerCase());
                    const upIdx = outsLower.findIndex((x) => x.includes('up'));
                    const downIdx = outsLower.findIndex((x) => x.includes('down'));
                    if (upIdx < 0 || downIdx < 0) continue;
                    baseMarkets.push({
                        symbol: getSymbolFromSlug(String(m?.slug || '')),
                        conditionId,
                        slug: m?.slug,
                        title: m?.question || m?.title,
                        endMs,
                        endDate: new Date(endMs).toISOString(),
                        endMsSource,
                        outcomes: outcomes.slice(0, 2),
                        tokenIds: tokenIds.slice(0, 2),
                        upIdx,
                        downIdx,
                    });
                }
                this.crypto15mMarketSnapshot = { atMs: Date.now(), markets: baseMarkets.slice(0, 30), lastError: null };
                this.crypto15mMarketBackoffMs = 0;
                this.crypto15mMarketNextAllowedAtMs = 0;
            } catch (e: any) {
                const msg = e?.message || String(e);
                const next = this.crypto15mMarketBackoffMs ? Math.min(30_000, this.crypto15mMarketBackoffMs * 2) : 1000;
                this.crypto15mMarketBackoffMs = next;
                this.crypto15mMarketNextAllowedAtMs = Date.now() + next;
                this.crypto15mMarketSnapshot = { ...this.crypto15mMarketSnapshot, atMs: Date.now(), lastError: msg };
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
                const markets = Array.isArray(this.crypto15mMarketSnapshot.markets) ? this.crypto15mMarketSnapshot.markets : [];
                const tokenIds = Array.from(new Set(markets.flatMap((m: any) => Array.isArray(m?.tokenIds) ? m.tokenIds : []).map((t: any) => String(t || '').trim()).filter((t: any) => !!t)));
                if (!tokenIds.length) {
                    this.crypto15mBooksSnapshot = { ...this.crypto15mBooksSnapshot, atMs: Date.now(), byTokenId: {}, lastError: null, lastAttemptError: null };
                    return;
                }
                const books = await this.fetchClobBooks(tokenIds);
                const byTokenId: Record<string, any> = {};
                for (const b of books) {
                    const tokenId = String(b?.asset_id || b?.assetId || '').trim();
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
                    byTokenId[tokenId] = {
                        tokenId,
                        timestamp: b?.timestamp ?? null,
                        asksCount: asks.length,
                        bidsCount: bids.length,
                        bestAsk: Number.isFinite(bestAsk) ? bestAsk : null,
                        bestBid: Number.isFinite(bestBid) ? bestBid : null,
                    };
                }
                for (const t of tokenIds) {
                    if (!byTokenId[t]) {
                        byTokenId[t] = { tokenId: t, timestamp: null, asksCount: 0, bidsCount: 0, bestAsk: null, bestBid: null, error: 'missing' };
                    }
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

    private buildCrypto15mCandidatesFromSnapshots(options?: { minProb?: number; expiresWithinSec?: number; limit?: number }) {
        const minProb = Math.max(0, Math.min(1, Number(options?.minProb ?? this.crypto15mAutoConfig.minProb)));
        const expiresWithinSec = Math.max(5, Math.floor(Number(options?.expiresWithinSec ?? this.crypto15mAutoConfig.expiresWithinSec)));
        const limit = Math.max(1, Math.floor(Number(options?.limit ?? 20)));
        const staleMsThreshold = Number.isFinite(Number(this.crypto15mAutoConfig.staleMsThreshold)) ? Number(this.crypto15mAutoConfig.staleMsThreshold) : 1500;
        const now = Date.now();
        const markets = Array.isArray(this.crypto15mMarketSnapshot.markets) ? this.crypto15mMarketSnapshot.markets : [];
        const byTokenId = this.crypto15mBooksSnapshot.byTokenId || {};
        const snapshotAt = this.crypto15mBooksSnapshot.atMs ? new Date(this.crypto15mBooksSnapshot.atMs).toISOString() : null;
        const staleMs = this.crypto15mBooksSnapshot.atMs ? Math.max(0, now - this.crypto15mBooksSnapshot.atMs) : null;
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
            const chosenPrice = Number(prices[chosenIndex]);
            const eligibleByExpiry = secondsToExpire <= expiresWithinSec;
            const meetsMinProb = Number.isFinite(chosenPrice) ? chosenPrice >= minProb : false;
            const chosenHasAsk = hasAsk[chosenIndex] === true;
        let reason: string | null = null;
        if (this.crypto15mBooksSnapshot.lastError) reason = 'books_error';
        else if (this.crypto15mMarketSnapshot.lastError) reason = 'market_error';
        else if (staleMs != null && staleMs > staleMsThreshold) reason = 'stale';
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
                chosenOutcome: String(outcomes[chosenIndex]),
                chosenPrice: Number.isFinite(chosenPrice) ? chosenPrice : null,
                chosenTokenId: String(tokenIds[chosenIndex]),
                snapshotAt,
                staleMs,
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
            staleMs,
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
                const key = JSON.stringify({ symbols: cfg.symbols.slice().sort(), timeframes: cfg.timeframes.slice().sort(), minProb: cfg.minProb, expiresWithinSec: cfg.expiresWithinSec, limit: cfg.limit });
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
            const timeframes = Array.from(new Set(Array.from(this.cryptoAllWsClients.values()).flatMap((c: any) => c.timeframes || []))) as Array<'15m' | '1h' | '4h' | '1d'>;
            const limit = Math.max(10, Math.min(100, Math.max(...Array.from(this.cryptoAllWsClients.values()).map((c: any) => Number(c.limit) || 0), 0)));
            await this.refreshCryptoAllMarketSnapshot({ symbols, timeframes, limit }).catch(() => {});
            await this.refreshCryptoAllBooksSnapshot({ symbols, timeframes, limit }).catch(() => {});
        };
        this.cryptoAllSnapshotTimer = setInterval(() => tick().catch(() => {}), 1000);
        tick().catch(() => {});
    }

    public addCryptoAllWsClient(socket: any, options: { symbols?: string[] | string; timeframes?: Array<'15m' | '1h' | '4h' | '1d'> | string; minProb?: number; expiresWithinSec?: number; limit?: number; includeCandidates?: boolean | string }) {
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
        const timeframes = Array.from(new Set(tfArr.map((x: any) => String(x || '').toLowerCase()).filter(Boolean))) as Array<'15m' | '1h' | '4h' | '1d'>;

        const minProb = Math.max(0, Math.min(1, Number(options?.minProb ?? this.cryptoAllAutoConfig.minProb)));
        const expiresWithinSec = Math.max(10, Math.floor(Number(options?.expiresWithinSec ?? this.cryptoAllAutoConfig.expiresWithinSec)));
        const limit = Math.max(1, Math.min(100, Math.floor(Number(options?.limit ?? 40))));
        const includeCandidates = options?.includeCandidates == null ? true : (String(options?.includeCandidates || '').toLowerCase() === '1' || String(options?.includeCandidates || '').toLowerCase() === 'true');
        this.cryptoAllWsClients.set(socket, { symbols, timeframes, minProb, expiresWithinSec, limit, includeCandidates });
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
        if (!this.crypto15mMarketSnapshot.atMs || now - this.crypto15mMarketSnapshot.atMs > 5_000) {
            await this.refreshCrypto15mMarketSnapshot();
        }
        if (!this.crypto15mBooksSnapshot.atMs || now - this.crypto15mBooksSnapshot.atMs > 500) {
            await this.refreshCrypto15mBooksSnapshot();
        }
        return this.buildCrypto15mCandidatesFromSnapshots(options);
    }

    getCrypto15mStatus() {
        this.crypto15mUpdateTracking(Date.now());
        const actives: any = {};
        for (const [symbol, a] of this.crypto15mActivesBySymbol.entries()) {
            actives[symbol] = a;
        }
        const tracked = Array.from(this.crypto15mTrackedByCondition.values())
            .sort((a: any, b: any) => String(b?.startedAt || '').localeCompare(String(a?.startedAt || '')))
            .slice(0, 50);
        return {
            enabled: this.crypto15mAutoEnabled,
            config: this.crypto15mAutoConfig,
            lastScanAt: this.crypto15mLastScanAt,
            lastError: this.crypto15mLastError,
            actives,
            tracked,
        };
    }

    private crypto15mUpdateTracking(nowMs: number) {
        for (const [symbol, a] of this.crypto15mActivesBySymbol.entries()) {
            const endMs = a?.expiresAtMs != null ? Number(a.expiresAtMs) : Date.parse(String(a?.endDate || ''));
            if (Number.isFinite(endMs) && nowMs > endMs) {
                const expired = { ...a, phase: 'expired', expiredAt: new Date(nowMs).toISOString() };
                this.crypto15mTrackedByCondition.set(String(expired.conditionId), expired);
                this.crypto15mActivesBySymbol.delete(symbol);
                this.crypto15mCooldownUntilBySymbol.set(symbol, nowMs + 2_000);
            }
        }
        const cutoff = nowMs - 48 * 60 * 60_000;
        for (const [cid, a] of this.crypto15mTrackedByCondition.entries()) {
            const started = Date.parse(String(a?.startedAt || a?.started_at || ''));
            if (Number.isFinite(started) && started < cutoff) this.crypto15mTrackedByCondition.delete(cid);
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
        if (!this.hasValidKey) {
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
            const candidates = Array.isArray((r as any)?.candidates) ? (r as any).candidates : [];
            const symbols = ['BTC', 'ETH', 'SOL', 'XRP'];
            for (const symbol of symbols) {
                if (this.crypto15mActivesBySymbol.has(symbol)) continue;
                const cd = this.crypto15mCooldownUntilBySymbol.get(symbol);
                if (cd != null && nowMs < cd) continue;
                const pick = candidates.find((c: any) => String(c?.symbol || '').toUpperCase() === symbol && c?.eligibleByExpiry && c?.meetsMinProb && c?.reason == null) || null;
                if (!pick) continue;
                const cid = String(pick.conditionId || '');
                if (cid && this.crypto15mTrackedByCondition.has(cid)) continue;
                const placed: any = await this.placeCrypto15mOrder({
                    conditionId: cid,
                    outcomeIndex: Number(pick.chosenIndex),
                    amountUsd: this.crypto15mAutoConfig.amountUsd,
                    minPrice: this.crypto15mAutoConfig.minProb,
                    source: 'auto',
                    symbol,
                    endDate: pick.endDate,
                    secondsToExpire: pick.secondsToExpire,
                    chosenPrice: pick.chosenPrice,
                });
                if (placed?.success !== true) {
                    const reason = placed?.reason ? String(placed.reason) : 'order_skipped';
                    const msg = placed?.minDeltaRequired != null && placed?.deltaAbs != null
                        ? `${reason}: ${symbol} delta=${placed.deltaAbs} < ${placed.minDeltaRequired}`
                        : placed?.error ? String(placed.error) : reason;
                    this.crypto15mLastError = msg;
                }
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

    startCrypto15mAuto(config?: { enabled?: boolean; amountUsd?: number; minProb?: number; expiresWithinSec?: number; pollMs?: number; staleMsThreshold?: number }) {
        const enabled = config?.enabled != null ? !!config.enabled : true;
        const amountUsd = config?.amountUsd != null ? Number(config.amountUsd) : this.crypto15mAutoConfig.amountUsd;
        const minProb = config?.minProb != null ? Number(config.minProb) : this.crypto15mAutoConfig.minProb;
        const expiresWithinSec = config?.expiresWithinSec != null ? Number(config.expiresWithinSec) : this.crypto15mAutoConfig.expiresWithinSec;
        const pollMs = config?.pollMs != null ? Number(config.pollMs) : this.crypto15mAutoConfig.pollMs;
        const staleMsThreshold = config?.staleMsThreshold != null ? Number(config.staleMsThreshold) : this.crypto15mAutoConfig.staleMsThreshold;

        this.crypto15mAutoConfig = {
            pollMs: Math.max(500, Math.floor(pollMs)),
            expiresWithinSec: Math.max(5, Math.floor(expiresWithinSec)),
            minProb: Math.max(0, Math.min(1, minProb)),
            amountUsd: Math.max(1, Number.isFinite(amountUsd) ? amountUsd : 1),
            staleMsThreshold: Math.max(500, Math.floor(staleMsThreshold)),
        };

        this.crypto15mAutoEnabled = enabled;
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

        return this.getCrypto15mStatus();
    }

    stopCrypto15mAuto() {
        this.crypto15mAutoEnabled = false;
        if (this.crypto15mAutoTimer) {
            clearInterval(this.crypto15mAutoTimer);
            this.crypto15mAutoTimer = null;
        }
        return this.getCrypto15mStatus();
    }

    getCrypto15mWatchdogStatus() {
        const w = this.crypto15mWatchdog;
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

    startCrypto15mWatchdog(options?: { durationHours?: number; pollMs?: number; staleMsThreshold?: number }) {
        const durationHours = options?.durationHours != null ? Number(options.durationHours) : 12;
        const pollMs = options?.pollMs != null ? Number(options.pollMs) : 30_000;
        const staleMsThreshold = options?.staleMsThreshold != null ? Number(options.staleMsThreshold) : this.crypto15mWatchdog.thresholds.staleMsThreshold;
        const now = Date.now();
        this.crypto15mWatchdog.running = true;
        this.crypto15mWatchdog.pollMs = Math.max(5_000, Math.floor(pollMs));
        this.crypto15mWatchdog.startedAtMs = now;
        this.crypto15mWatchdog.endsAtMs = now + Math.max(1, durationHours) * 60 * 60_000;
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
        if (w.endsAtMs && now >= w.endsAtMs) {
            this.stopCrypto15mWatchdog({ reason: 'duration_elapsed', stopAuto: true });
            return;
        }

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
            w.issues.push({ at: new Date().toISOString(), type: 'data_error', message: `booksError=${booksError || '-'} marketError=${marketError || '-'}` });
            this.stopCrypto15mWatchdog({ reason: 'data_error', stopAuto: true });
            return;
        }
        if (w.counters.consecutiveStale >= w.thresholds.consecutiveStaleStops) {
            w.issues.push({ at: new Date().toISOString(), type: 'books_stale', message: `staleMs=${Math.floor(Number(staleMs))} threshold=${w.thresholds.staleMsThreshold}` });
            this.stopCrypto15mWatchdog({ reason: 'books_stale', stopAuto: true });
            return;
        }

        await this.refreshHistoryStatuses({ maxEntries: 50, minIntervalMs: 1000 }).catch(() => null);
        const h: any = await this.getCrypto15mHistory({ refresh: false, maxEntries: 50 }).catch(() => null);
        const items = Array.isArray(h?.history) ? h.history : [];

        const anyRedeemFailed = items.find((it: any) => String(it?.redeemStatus || '') === 'failed' || String(it?.state || '') === 'redeem_failed') || null;
        if (anyRedeemFailed) {
            w.counters.redeemFailed += 1;
            w.issues.push({ at: new Date().toISOString(), type: 'redeem_failed', message: `${anyRedeemFailed.slug || anyRedeemFailed.conditionId || ''}`, meta: { conditionId: anyRedeemFailed.conditionId, txHash: anyRedeemFailed.txHash || null } });
            if (w.counters.redeemFailed >= w.thresholds.redeemFailedStops) {
                this.stopCrypto15mWatchdog({ reason: 'redeem_failed', stopAuto: true });
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
                this.stopCrypto15mWatchdog({ reason: 'order_failed', stopAuto: true });
                return;
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
            this.stopCrypto15mWatchdog({ reason: 'duplicate_order', stopAuto: true });
            return;
        }

        for (const [cid, inflight] of this.redeemInFlight.entries()) {
            if (!inflight || inflight.status !== 'submitted') continue;
            const subAt = Date.parse(String(inflight.submittedAt || ''));
            if (!Number.isFinite(subAt)) continue;
            if (now - subAt <= w.thresholds.redeemSubmittedTimeoutMs) continue;
            w.issues.push({ at: new Date().toISOString(), type: 'redeem_timeout', message: `conditionId=${cid}`, meta: { submittedAt: inflight.submittedAt, transactionId: inflight.transactionId || null } });
            this.stopCrypto15mWatchdog({ reason: 'redeem_timeout', stopAuto: true });
            return;
        }
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

    async placeCrypto15mOrder(params: { conditionId: string; outcomeIndex?: number; amountUsd?: number; minPrice?: number; force?: boolean; source?: 'auto' | 'semi'; symbol?: string; endDate?: string; secondsToExpire?: number; chosenPrice?: number }) {
        if (!this.hasValidKey) throw new Error('Missing private key');
        const conditionId = String(params.conditionId || '').trim();
        if (!conditionId) throw new Error('Missing conditionId');
        const requestedAmountUsd = params.amountUsd != null ? Number(params.amountUsd) : NaN;
        const amountUsd = Math.max(1, Number.isFinite(requestedAmountUsd) ? requestedAmountUsd : this.crypto15mAutoConfig.amountUsd);
        const source = params.source || 'semi';
        const force = params.force === true;
        const requestedMinPrice = params.minPrice != null ? Number(params.minPrice) : NaN;
        const effectiveMinPrice = Math.max(0.9, this.crypto15mAutoConfig.minProb, Number.isFinite(requestedMinPrice) ? requestedMinPrice : -Infinity);
        if (this.crypto15mTrackedByCondition.has(conditionId)) {
            throw new Error(`Already ordered for this market (conditionId=${conditionId})`);
        }
        const alreadyInHistory = this.orderHistory.some((e: any) => {
            if (!e) return false;
            if (String(e?.action || '') !== 'crypto15m_order') return false;
            const mid = String(e?.marketId || '').trim().toLowerCase();
            return mid && mid === conditionId.toLowerCase();
        });
        if (alreadyInHistory) {
            throw new Error(`Already ordered for this market (history) (conditionId=${conditionId})`);
        }

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

        const upperSymbol = String(symbol || '').toUpperCase();
        const orderLockKey = upperSymbol && upperSymbol !== 'UNKNOWN' ? `${upperSymbol}:${expiresAtMs}` : null;
        if (!force && orderLockKey) {
            if (this.crypto15mActivesBySymbol.has(upperSymbol)) {
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
        if (!force && symbol && symbol !== 'UNKNOWN' && marketSlug) {
            const minDeltaRequired =
                symbol === 'BTC' ? this.crypto15mDeltaThresholds.btcMinDelta
                : symbol === 'ETH' ? this.crypto15mDeltaThresholds.ethMinDelta
                : symbol === 'SOL' ? this.crypto15mDeltaThresholds.solMinDelta
                : symbol === 'XRP' ? this.crypto15mDeltaThresholds.xrpMinDelta
                : 0;
            if (minDeltaRequired > 0) {
                const beat = await this.fetchCrypto15mBeatAndCurrentFromSite(marketSlug);
                if (beat.deltaAbs == null) {
                    return { success: false, skipped: true, reason: 'delta_unavailable', symbol, slug: marketSlug, minDeltaRequired, error: beat.error || 'Failed to compute delta' };
                }
                if (Number(beat.deltaAbs) < Number(minDeltaRequired)) {
                    return { success: false, skipped: true, reason: 'delta_too_small', symbol, slug: marketSlug, minDeltaRequired, deltaAbs: beat.deltaAbs, priceToBeat: beat.priceToBeat, currentPrice: beat.currentPrice };
                }
            }
        }
        const books = await this.fetchClobBooks([tokenId]);
        const book = books && books.length ? books[0] : null;
        const asks = Array.isArray(book?.asks) ? book.asks : [];
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

        const limitPrice = Math.min(0.999, Math.max(effectiveMinPrice, price) + 0.02);
        const globalKey = `crypto15m:${conditionId}`.toLowerCase();
        let order: any = null;
        let globalOk = false;
        try {
            if (!force) {
                if (!this.tryAcquireGlobalOrderLock(globalKey, 'crypto15m')) {
                    return { success: false, skipped: true, reason: 'global_locked', symbol: upperSymbol || symbol, slug: marketSlug || null, expiresAtMs };
                }
                if (this.globalOrderPlaceInFlight) {
                    this.markGlobalOrderLockDone(globalKey, false);
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
            amountUsd: amountUsd,
            results: [{ ...order, tokenId, outcome, conditionId }],
        };
        this.orderHistory.unshift(entry);
        if (this.orderHistory.length > 50) this.orderHistory.pop();
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
            amountUsd: amountUsd,
            source,
            orderId: order?.orderId ?? order?.id ?? null,
            order,
            endDate,
            expiresAtMs,
            secondsToExpire: params.secondsToExpire,
            chosenPrice: params.chosenPrice,
        };
        this.crypto15mTrackedByCondition.set(conditionId, active);
        if (active.phase === 'ordered' && symbol && symbol !== 'UNKNOWN') {
            this.crypto15mActivesBySymbol.set(symbol, active);
        } else if (symbol && symbol !== 'UNKNOWN') {
            this.crypto15mCooldownUntilBySymbol.set(symbol, Date.now() + 5_000);
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
        if (this.orderHistory.length > 50) this.orderHistory.pop();
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
            if (this.orderHistory.length > 50) this.orderHistory.pop();
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
        return {
            enabled: this.cryptoAllAutoEnabled,
            config: this.cryptoAllAutoConfig,
            lastScanAt: this.cryptoAllLastScanAt,
            lastScanSummary: this.cryptoAllLastScanSummary,
            lastError: this.cryptoAllLastError,
            actives: Object.fromEntries(Array.from(this.cryptoAllActivesByKey.entries()).slice(0, 50)),
            trackedCount: this.cryptoAllTrackedByCondition.size,
            addOn: { enabled: this.cryptoAllAutoConfig.addOn.enabled, positions: addOnPositions },
            stoploss: { enabled: this.cryptoAllAutoConfig.stoploss.enabled, positions: stoplossPositions },
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

    private async refreshCryptoAllMarketSnapshot(params: { symbols: string[]; timeframes: Array<'15m' | '1h' | '4h' | '1d'>; limit: number }) {
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
                const maxSlugsPerTf = Math.max(30, Math.min(120, limit * 3));
                const marketRefs: Array<{
                    timeframe: '15m' | '1h' | '4h' | '1d';
                    timeframeSec: number;
                    slug: string;
                    conditionId: string;
                    symbol: 'BTC' | 'ETH' | 'SOL' | 'XRP';
                    question: string;
                    endMs: number;
                    upTokenId: string;
                    downTokenId: string;
                }> = [];

                for (const tf of timeframes) {
                    const timeframeSec = this.getCryptoAllTimeframeSec(tf);
                    const paths = this.getCryptoAllListPaths(tf);
                    const nowSec = Math.floor(now / 1000);
                    const predicted = this.predictCryptoAllSlugs(tf, nowSec, symbols).slice(0, Math.max(20, Math.min(80, maxSlugsPerTf)));
                    let slugs: string[] = [];
                    if (!predicted.length && paths.length) {
                        const settledPaths = await Promise.allSettled(paths.slice(0, 2).map((p) => this.fetchCryptoSlugsFromSitePath(p, maxSlugsPerTf)));
                        slugs = settledPaths.flatMap((r: any) => (r.status === 'fulfilled' && Array.isArray(r.value)) ? r.value : []);
                    }
                    const uniq = Array.from(new Set(predicted.concat(slugs))).slice(0, Math.max(30, maxSlugsPerTf));

                    const tfLimit = Math.max(12, limit * 3);
                    const settled = await Promise.allSettled(uniq.slice(0, tfLimit).map(async (slug) => {
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
                            const sym = this.inferCryptoSymbolFromText(slug, q);
                            if (!sym) continue;
                            if (symbols.length && !symbols.includes(sym)) continue;

                            const endIso = m?.endDate ?? m?.end_date ?? m?.endDateIso ?? m?.end_date_iso ?? null;
                            const endMs = endIso ? Date.parse(String(endIso)) : NaN;
                            if (!Number.isFinite(endMs)) continue;
                            if (endMs <= now) continue;

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
                            if (marketRefs.length >= limit * 8) break;
                        } catch {
                        }
                    }
                }

                const uniqMarketRefs = Array.from(new Map(marketRefs.map((m) => [`${m.timeframe}:${m.conditionId}`, m])).values());
                (this.cryptoAllMarketSnapshot as any).key = key;
                this.cryptoAllMarketSnapshot = { ...this.cryptoAllMarketSnapshot, atMs: Date.now(), markets: uniqMarketRefs, lastError: null, lastAttemptError: null };
                this.cryptoAllMarketBackoffMs = 0;
                this.cryptoAllMarketNextAllowedAtMs = 0;
            } catch (e: any) {
                const msg = e?.message || String(e);
                const next = this.cryptoAllMarketBackoffMs ? Math.min(30_000, this.cryptoAllMarketBackoffMs * 2) : 1000;
                this.cryptoAllMarketBackoffMs = next;
                this.cryptoAllMarketNextAllowedAtMs = Date.now() + next;
                this.cryptoAllMarketSnapshot = { ...this.cryptoAllMarketSnapshot, lastError: msg, lastAttemptError: msg };
            } finally {
                this.cryptoAllMarketInFlight = null;
            }
        })();
        return this.cryptoAllMarketInFlight;
    }

    private async refreshCryptoAllBooksSnapshot(params: { symbols: string[]; timeframes: Array<'15m' | '1h' | '4h' | '1d'>; limit: number }) {
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
                    .slice(0, Math.max(60, Math.min(400, Math.floor(Number(params.limit) || 0) * 8)));
                const tokenIds: string[] = [];
                const seen = new Set<string>();
                for (const m of markets) {
                    const up = String(m?.upTokenId || '').trim();
                    const down = String(m?.downTokenId || '').trim();
                    if (up && !seen.has(up)) { tokenIds.push(up); seen.add(up); }
                    if (down && !seen.has(down)) { tokenIds.push(down); seen.add(down); }
                    if (tokenIds.length >= 480) break;
                }
                if (!tokenIds.length) {
                    (this.cryptoAllBooksSnapshot as any).key = key;
                    this.cryptoAllBooksSnapshot = { ...this.cryptoAllBooksSnapshot, atMs: Date.now(), byTokenId: {}, lastError: null, lastAttemptError: null };
                    return;
                }
                const books = await this.fetchClobBooks(tokenIds);
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

    private async buildCryptoAllCandidatesFromSnapshots(options: { symbols: string[]; timeframes: Array<'15m' | '1h' | '4h' | '1d'>; minProb: number; expiresWithinSec: number; limit: number }) {
        const { symbols, timeframes, minProb, expiresWithinSec, limit } = options;
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
            const eligibleByExpiry = secondsToExpire <= expiresWithinSec;
            const withinComputeWindow = secondsToExpire <= (expiresWithinSec + precomputeExpiryBufferSec);
            const minDeltaRequired =
                m.symbol === 'BTC' ? this.cryptoAllDeltaThresholds.btcMinDelta
                : m.symbol === 'ETH' ? this.cryptoAllDeltaThresholds.ethMinDelta
                : m.symbol === 'SOL' ? this.cryptoAllDeltaThresholds.solMinDelta
                : this.cryptoAllDeltaThresholds.xrpMinDelta;
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

    async getCryptoAllCandidates(options?: { symbols?: string[] | string; timeframes?: Array<'15m' | '1h' | '4h' | '1d'> | string; minProb?: number; expiresWithinSec?: number; limit?: number }) {
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
        const timeframes = Array.from(new Set(tfArr.map((x: any) => String(x || '').toLowerCase()).filter(Boolean))) as Array<'15m' | '1h' | '4h' | '1d'>;

        const minProbRaw = options?.minProb != null ? Number(options.minProb) : this.cryptoAllAutoConfig.minProb;
        const expiresWithinSecRaw = options?.expiresWithinSec != null ? Number(options.expiresWithinSec) : this.cryptoAllAutoConfig.expiresWithinSec;
        const limitRaw = options?.limit != null ? Number(options.limit) : 20;

        const minProb = Math.max(0, Math.min(1, Number.isFinite(minProbRaw) ? minProbRaw : this.cryptoAllAutoConfig.minProb));
        const expiresWithinSec = Math.max(10, Math.floor(Number.isFinite(expiresWithinSecRaw) ? expiresWithinSecRaw : this.cryptoAllAutoConfig.expiresWithinSec));
        const limit = Math.max(1, Math.min(100, Math.floor(Number.isFinite(limitRaw) ? limitRaw : 20)));

        await this.refreshCryptoAllMarketSnapshot({ symbols, timeframes, limit }).catch(() => {});
        await this.refreshCryptoAllBooksSnapshot({ symbols, timeframes, limit }).catch(() => {});
        return await this.buildCryptoAllCandidatesFromSnapshots({ symbols, timeframes, minProb, expiresWithinSec, limit });
    }

    startCryptoAllAuto(config?: {
        pollMs?: number;
        expiresWithinSec?: number;
        minProb?: number;
        amountUsd?: number;
        symbols?: string[];
        timeframes?: Array<'15m' | '1h' | '4h' | '1d'>;
        dojiGuardEnabled?: boolean;
        riskSkipScore?: number;
        riskAddOnBlockScore?: number;
        addOnEnabled?: boolean;
        addOnMultiplierA?: number;
        addOnMultiplierB?: number;
        addOnMultiplierC?: number;
        addOnAccelEnabled?: boolean;
        addOnMaxTotalStakeUsdPerPosition?: number;
        stoplossEnabled?: boolean;
        stoplossCut1DropCents?: number;
        stoplossCut1SellPct?: number;
        stoplossCut2DropCents?: number;
        stoplossCut2SellPct?: number;
        stoplossSpreadGuardCents?: number;
        stoplossMinSecToExit?: number;
    }) {
        const pollMsRaw = config?.pollMs != null ? Number(config.pollMs) : this.cryptoAllAutoConfig.pollMs;
        const expiresWithinSecRaw = config?.expiresWithinSec != null ? Number(config.expiresWithinSec) : this.cryptoAllAutoConfig.expiresWithinSec;
        const minProbRaw = config?.minProb != null ? Number(config.minProb) : this.cryptoAllAutoConfig.minProb;
        const amountUsdRaw = config?.amountUsd != null ? Number(config.amountUsd) : this.cryptoAllAutoConfig.amountUsd;
        const symbols = Array.isArray(config?.symbols) && config?.symbols.length ? Array.from(new Set(config.symbols.map((s) => String(s || '').toUpperCase()).filter(Boolean))) : this.cryptoAllAutoConfig.symbols;
        const timeframes = Array.isArray(config?.timeframes) && config?.timeframes.length ? Array.from(new Set(config.timeframes.map((t) => String(t || '').toLowerCase()))) as any : this.cryptoAllAutoConfig.timeframes;

        const dojiGuardEnabled = config?.dojiGuardEnabled != null ? !!config.dojiGuardEnabled : this.cryptoAllAutoConfig.dojiGuard.enabled;
        const riskSkipScoreRaw = config?.riskSkipScore != null ? Number(config.riskSkipScore) : this.cryptoAllAutoConfig.dojiGuard.riskSkipScore;
        const riskAddOnBlockScoreRaw = config?.riskAddOnBlockScore != null ? Number(config.riskAddOnBlockScore) : this.cryptoAllAutoConfig.dojiGuard.riskAddOnBlockScore;
        const addOnEnabled = config?.addOnEnabled != null ? !!config.addOnEnabled : this.cryptoAllAutoConfig.addOn.enabled;
        const addOnMultiplierA = config?.addOnMultiplierA != null ? Number(config.addOnMultiplierA) : this.cryptoAllAutoConfig.addOn.multiplierA;
        const addOnMultiplierB = config?.addOnMultiplierB != null ? Number(config.addOnMultiplierB) : this.cryptoAllAutoConfig.addOn.multiplierB;
        const addOnMultiplierC = config?.addOnMultiplierC != null ? Number(config.addOnMultiplierC) : this.cryptoAllAutoConfig.addOn.multiplierC;
        const addOnAccelEnabled = config?.addOnAccelEnabled != null ? !!config.addOnAccelEnabled : this.cryptoAllAutoConfig.addOn.accelEnabled;
        const addOnMaxTotalStakeUsdPerPosition = config?.addOnMaxTotalStakeUsdPerPosition != null ? Number(config.addOnMaxTotalStakeUsdPerPosition) : this.cryptoAllAutoConfig.addOn.maxTotalStakeUsdPerPosition;
        const stoplossEnabled = config?.stoplossEnabled != null ? !!config.stoplossEnabled : this.cryptoAllAutoConfig.stoploss.enabled;
        const stoplossCut1DropCentsRaw = config?.stoplossCut1DropCents != null ? Number(config.stoplossCut1DropCents) : this.cryptoAllAutoConfig.stoploss.cut1DropCents;
        const stoplossCut1SellPctRaw = config?.stoplossCut1SellPct != null ? Number(config.stoplossCut1SellPct) : this.cryptoAllAutoConfig.stoploss.cut1SellPct;
        const stoplossCut2DropCentsRaw = config?.stoplossCut2DropCents != null ? Number(config.stoplossCut2DropCents) : this.cryptoAllAutoConfig.stoploss.cut2DropCents;
        const stoplossCut2SellPctRaw = config?.stoplossCut2SellPct != null ? Number(config.stoplossCut2SellPct) : this.cryptoAllAutoConfig.stoploss.cut2SellPct;
        const stoplossSpreadGuardCentsRaw = config?.stoplossSpreadGuardCents != null ? Number(config.stoplossSpreadGuardCents) : this.cryptoAllAutoConfig.stoploss.spreadGuardCents;
        const stoplossMinSecToExitRaw = config?.stoplossMinSecToExit != null ? Number(config.stoplossMinSecToExit) : this.cryptoAllAutoConfig.stoploss.minSecToExit;

        this.cryptoAllAutoConfig = {
            pollMs: Math.max(500, Math.floor(Number.isFinite(pollMsRaw) ? pollMsRaw : 2_000)),
            expiresWithinSec: Math.max(10, Math.floor(Number.isFinite(expiresWithinSecRaw) ? expiresWithinSecRaw : 180)),
            minProb: Math.max(0, Math.min(1, Number.isFinite(minProbRaw) ? minProbRaw : 0.9)),
            amountUsd: Math.max(1, Number.isFinite(amountUsdRaw) ? amountUsdRaw : 1),
            symbols,
            timeframes,
            dojiGuard: {
                enabled: dojiGuardEnabled,
                riskSkipScore: Math.max(0, Math.min(100, Math.floor(Number.isFinite(riskSkipScoreRaw) ? riskSkipScoreRaw : 70))),
                riskAddOnBlockScore: Math.max(0, Math.min(100, Math.floor(Number.isFinite(riskAddOnBlockScoreRaw) ? riskAddOnBlockScoreRaw : 50))),
            },
            addOn: {
                ...this.cryptoAllAutoConfig.addOn,
                enabled: addOnEnabled,
                accelEnabled: addOnAccelEnabled,
                multiplierA: Number.isFinite(addOnMultiplierA) ? Math.max(0.1, Math.min(5, addOnMultiplierA)) : this.cryptoAllAutoConfig.addOn.multiplierA,
                multiplierB: Number.isFinite(addOnMultiplierB) ? Math.max(0.1, Math.min(5, addOnMultiplierB)) : this.cryptoAllAutoConfig.addOn.multiplierB,
                multiplierC: Number.isFinite(addOnMultiplierC) ? Math.max(0.1, Math.min(5, addOnMultiplierC)) : this.cryptoAllAutoConfig.addOn.multiplierC,
                maxTotalStakeUsdPerPosition: Number.isFinite(addOnMaxTotalStakeUsdPerPosition) ? Math.max(1, addOnMaxTotalStakeUsdPerPosition) : this.cryptoAllAutoConfig.addOn.maxTotalStakeUsdPerPosition,
            },
            stoploss: {
                enabled: stoplossEnabled,
                cut1DropCents: Math.max(0, Math.min(50, Math.floor(Number.isFinite(stoplossCut1DropCentsRaw) ? stoplossCut1DropCentsRaw : 1))),
                cut1SellPct: Math.max(0, Math.min(100, Math.floor(Number.isFinite(stoplossCut1SellPctRaw) ? stoplossCut1SellPctRaw : 50))),
                cut2DropCents: Math.max(0, Math.min(50, Math.floor(Number.isFinite(stoplossCut2DropCentsRaw) ? stoplossCut2DropCentsRaw : 2))),
                cut2SellPct: Math.max(0, Math.min(100, Math.floor(Number.isFinite(stoplossCut2SellPctRaw) ? stoplossCut2SellPctRaw : 100))),
                spreadGuardCents: Math.max(0, Math.min(50, Math.floor(Number.isFinite(stoplossSpreadGuardCentsRaw) ? stoplossSpreadGuardCentsRaw : 2))),
                minSecToExit: Math.max(0, Math.min(600, Math.floor(Number.isFinite(stoplossMinSecToExitRaw) ? stoplossMinSecToExitRaw : 25))),
            },
        };

        this.cryptoAllAutoEnabled = true;
        this.startCryptoAllStoplossLoop();
        if (this.cryptoAllAutoTimer) {
            clearInterval(this.cryptoAllAutoTimer);
            this.cryptoAllAutoTimer = null;
        }

        const tick = async () => {
            if (!this.cryptoAllAutoEnabled) return;
            if (this.cryptoAllAutoInFlight) return;
            this.cryptoAllAutoInFlight = true;
            this.cryptoAllLastScanAt = new Date().toISOString();
            try {
                const candidates = await this.getCryptoAllCandidates({
                    symbols: this.cryptoAllAutoConfig.symbols,
                    timeframes: this.cryptoAllAutoConfig.timeframes,
                    minProb: this.cryptoAllAutoConfig.minProb,
                    expiresWithinSec: this.cryptoAllAutoConfig.expiresWithinSec,
                    limit: 40,
                });
                const riskSkipScore = this.cryptoAllAutoConfig.dojiGuard.enabled ? Number(this.cryptoAllAutoConfig.dojiGuard.riskSkipScore) : null;
                const stats: Record<string, number> = { total: 0, eligible: 0 };
                for (const c of candidates) {
                    stats.total++;
                    const missingCore = !(c?.conditionId && c?.chosen?.tokenId);
                    const expiry = c?.eligibleByExpiry === true;
                    const prob = c?.meetsMinProb === true;
                    const delta = c?.meetsMinDelta === true;
                    const riskBlocked = riskSkipScore != null && c?.riskScore != null && Number(c.riskScore) >= riskSkipScore;
                    const reason =
                        missingCore ? 'missing_token'
                        : !expiry ? 'expiry'
                        : !prob ? 'minProb'
                        : !delta ? 'delta'
                        : riskBlocked ? 'risk'
                        : 'eligible';
                    stats[reason] = (stats[reason] || 0) + 1;
                    if (reason === 'eligible') stats.eligible++;
                }
                const eligible = candidates.filter((c: any) => {
                    if (!c) return false;
                    if (!(c.eligibleByExpiry === true && c.meetsMinProb === true && c.meetsMinDelta === true && c.conditionId && c.chosen?.tokenId)) return false;
                    if (riskSkipScore != null && c.riskScore != null && Number(c.riskScore) >= riskSkipScore) return false;
                    return true;
                });
                const byKey = new Map<string, any>();
                for (const c of eligible) {
                    const key = `${String(c.timeframe)}:${String(c.symbol)}`;
                    const cur = byKey.get(key);
                    const curPrice = cur?.chosen?.price != null ? Number(cur.chosen.price) : -Infinity;
                    const nextPrice = c?.chosen?.price != null ? Number(c.chosen.price) : -Infinity;
                    if (!cur || nextPrice > curPrice) byKey.set(key, c);
                }
                this.cryptoAllLastScanSummary = {
                    at: new Date().toISOString(),
                    counts: stats,
                    selected: byKey.size,
                };
                for (const c of byKey.values()) {
                    await this.placeCryptoAllOrder({
                        conditionId: String(c.conditionId),
                        outcomeIndex: c.chosenIndex != null ? Number(c.chosenIndex) : undefined,
                        amountUsd: this.cryptoAllAutoConfig.amountUsd,
                        minPrice: this.cryptoAllAutoConfig.minProb,
                        force: false,
                        source: 'auto',
                        symbol: String(c.symbol),
                        timeframe: String(c.timeframe) as any,
                        endDate: String(c.endDateIso),
                        secondsToExpire: Number(c.secondsToExpire),
                    });
                }
                await this.tickCryptoAllAddOn();
                this.cryptoAllLastError = null;
            } catch (e: any) {
                this.cryptoAllLastError = e?.message || String(e);
            } finally {
                this.cryptoAllAutoInFlight = false;
            }
        };

        setTimeout(() => tick().catch(() => null), 250);
        this.cryptoAllAutoTimer = setInterval(() => setTimeout(() => tick().catch(() => null), 250), this.cryptoAllAutoConfig.pollMs);
        return this.getCryptoAllStatus();
    }

    stopCryptoAllAuto() {
        this.cryptoAllAutoEnabled = false;
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
        };
        this.cryptoAllStoplossTimer = setInterval(tick, 250);
        setTimeout(() => tick().catch(() => {}), 50);
    }

    private registerCryptoAllStoplossPosition(params: { conditionId: string; tokenId: string; symbol: string; timeframe: '15m' | '1h' | '4h' | '1d'; endMs: number; entryPrice: number; sizeEstimate: number }) {
        const positionKey = `${String(params.conditionId)}:${String(params.tokenId)}`;
        const prev = this.cryptoAllStoplossState.get(positionKey);
        const entryPrice = Number(params.entryPrice);
        const size = Math.max(0, Number(params.sizeEstimate) || 0);
        if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(size) || size <= 0) return;
        if (!prev) {
            this.cryptoAllStoplossState.set(positionKey, {
                positionKey,
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
            });
            return;
        }
        const totalSize = Number(prev.totalSize) + size;
        const avgEntry = ((Number(prev.entryPrice) * Number(prev.totalSize)) + (entryPrice * size)) / totalSize;
        this.cryptoAllStoplossState.set(positionKey, { ...prev, endMs: Math.max(Number(prev.endMs), Number(params.endMs) || 0), entryPrice: avgEntry, totalSize });
    }

    private async tickCryptoAllStoploss(): Promise<void> {
        if (!this.cryptoAllAutoConfig.stoploss.enabled) return;
        const now = Date.now();
        const cut1Drop = Math.max(0, Math.floor(Number(this.cryptoAllAutoConfig.stoploss.cut1DropCents) || 0)) / 100;
        const cut2Drop = Math.max(0, Math.floor(Number(this.cryptoAllAutoConfig.stoploss.cut2DropCents) || 0)) / 100;
        const cut1Pct = Math.max(0, Math.min(100, Math.floor(Number(this.cryptoAllAutoConfig.stoploss.cut1SellPct) || 0)));
        const cut2Pct = Math.max(0, Math.min(100, Math.floor(Number(this.cryptoAllAutoConfig.stoploss.cut2SellPct) || 0)));
        const minSecToExit = Math.max(0, Math.floor(Number(this.cryptoAllAutoConfig.stoploss.minSecToExit) || 0));
        const minAttemptGap = 900;

        for (const [positionKey, pos] of Array.from(this.cryptoAllStoplossState.entries())) {
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
            try {
                const ob = await this.sdk.clobApi.getOrderbook(pos.tokenId);
                bestBid = Number(ob?.bids?.[0]?.price) || 0;
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
            const remainingToSell = Math.max(0, sizeToHaveSold - Number(pos.soldSize));
            if (!(remainingToSell > 0)) continue;

            this.cryptoAllStoplossState.set(positionKey, { ...pos, lastAttemptAtMs: now });
            let sellResult: any = null;
            try {
                const attempt1 = await this.tradingClient.createMarketOrder({ tokenId: pos.tokenId, side: 'SELL', amount: remainingToSell, orderType: 'FAK' });
                const attempt2 = attempt1?.success ? null : await this.tradingClient.createMarketOrder({ tokenId: pos.tokenId, side: 'SELL', amount: remainingToSell, price: bestBid > 0 ? bestBid : undefined, orderType: 'FAK' });
                const sell = attempt2 || attempt1;
                const fallbackLimit = sell?.success || !(bestBid > 0) ? null : await this.tradingClient.createOrder({ tokenId: pos.tokenId, side: 'SELL', price: bestBid, size: remainingToSell, orderType: 'GTC' });
                sellResult = fallbackLimit?.success ? { ...fallbackLimit, method: 'limit_best_bid' } : { ...sell, method: attempt1?.success ? 'market_fak' : 'market_fak_with_price', fallbackLimit };

                const next = this.cryptoAllStoplossState.get(positionKey);
                if (sell?.success || fallbackLimit?.success) {
                    const soldSize = (Number(next?.soldSize) || 0) + remainingToSell;
                    const soldCut1 = (next?.soldCut1 || false) || reason === 'cut1';
                    const soldCut2 = (next?.soldCut2 || false) || reason === 'cut2' || (cut2Pct > 0 && (soldSize / Math.max(1e-9, Number(next?.totalSize) || 0)) * 100 >= cut2Pct);
                    this.cryptoAllStoplossState.set(positionKey, { ...(next as any), soldSize, soldCut1, soldCut2 });
                }
            } catch (e: any) {
                sellResult = { success: false, error: e?.message || String(e) };
            }
            this.orderHistory.unshift({
                id: Date.now(),
                timestamp: new Date().toISOString(),
                mode: 'stoploss',
                action: 'cryptoall_stoploss_sell',
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
                remainingToSell,
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

    private registerCryptoAllAddOnPosition(params: { conditionId: string; tokenId: string; direction: 'Up' | 'Down'; outcomeIndex: number; symbol: string; timeframe: '15m' | '1h' | '4h' | '1d'; endMs: number; stakeUsd: number }) {
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

    async placeCryptoAllOrder(params: { conditionId: string; outcomeIndex?: number; amountUsd?: number; minPrice?: number; force?: boolean; source?: 'auto' | 'semi' | 'addon'; symbol?: string; timeframe?: '15m' | '1h' | '4h' | '1d'; endDate?: string; secondsToExpire?: number; addonWindow?: 'A' | 'B' | 'C'; addonRiskScore?: number }) {
        if (!this.hasValidKey) throw new Error('Missing private key');
        const conditionId = String(params.conditionId || '').trim();
        if (!conditionId) throw new Error('Missing conditionId');
        const requestedAmountUsd = params.amountUsd != null ? Number(params.amountUsd) : NaN;
        const amountUsd = Math.max(1, Number.isFinite(requestedAmountUsd) ? requestedAmountUsd : this.cryptoAllAutoConfig.amountUsd);
        const source = params.source || 'semi';
        const force = params.force === true;
        const requestedMinPrice = params.minPrice != null ? Number(params.minPrice) : NaN;
        const effectiveMinPrice = Math.max(0.9, this.cryptoAllAutoConfig.minProb, Number.isFinite(requestedMinPrice) ? requestedMinPrice : -Infinity);
        if (source !== 'addon' && this.cryptoAllTrackedByCondition.has(conditionId)) {
            throw new Error(`Already ordered for this market (conditionId=${conditionId})`);
        }
        const alreadyInHistory = this.orderHistory.some((e: any) => {
            if (!e) return false;
            if (String(e?.action || '') !== 'cryptoall_order') return false;
            const mid = String(e?.marketId || '').trim().toLowerCase();
            return mid && mid === conditionId.toLowerCase();
        });
        if (source !== 'addon' && alreadyInHistory) {
            throw new Error(`Already ordered for this market (history) (conditionId=${conditionId})`);
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
        if (!force && orderLockKey) {
            const key = `${tf}:${upperSymbol}`;
            if (source !== 'addon' && this.cryptoAllActivesByKey.has(key)) {
                return { success: false, skipped: true, reason: 'already_active', symbol: upperSymbol, timeframe: tf, slug: marketSlug || null, expiresAtMs };
            }
            const locked = this.cryptoAllOrderLocks.get(orderLockKey);
            if (locked && locked.status === 'placing') {
                return { success: false, skipped: true, reason: 'duplicate_inflight', symbol: upperSymbol, timeframe: tf, slug: marketSlug || null, expiresAtMs };
            }
            this.cryptoAllOrderLocks.set(orderLockKey, { atMs: Date.now(), key: `${tf}:${upperSymbol}`, expiresAtMs, conditionId, status: 'placing' });
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
            const minDeltaRequired =
                upperSymbol === 'BTC' ? this.cryptoAllDeltaThresholds.btcMinDelta
                : upperSymbol === 'ETH' ? this.cryptoAllDeltaThresholds.ethMinDelta
                : upperSymbol === 'SOL' ? this.cryptoAllDeltaThresholds.solMinDelta
                : upperSymbol === 'XRP' ? this.cryptoAllDeltaThresholds.xrpMinDelta
                : 0;
            if (minDeltaRequired > 0) {
                const beat = await this.fetchCryptoAllBeatAndCurrentFromBinance({ symbol: upperSymbol, endMs: expiresAtMs, timeframeSec });
                if (beat.deltaAbs == null) {
                    return { success: false, skipped: true, reason: 'delta_unavailable', symbol: upperSymbol, timeframe: tf, slug: marketSlug || null, minDeltaRequired, error: beat.error || 'Failed to compute delta' };
                }
                if (beat.deltaAbs < minDeltaRequired) {
                    return { success: false, skipped: true, reason: 'delta_too_small', symbol: upperSymbol, timeframe: tf, slug: marketSlug || null, minDeltaRequired, deltaAbs: beat.deltaAbs, priceToBeat: beat.priceToBeat, currentPrice: beat.currentPrice };
                }
            }
        }

        try {
            const books = await this.fetchClobBooks([tokenId]);
            const b0: any = Array.isArray(books) && books.length ? books[0] : null;
            const asks = Array.isArray(b0?.asks) ? b0.asks : [];
            const bids = Array.isArray(b0?.bids) ? b0.bids : [];
            const bestAsk = asks.length ? Number(asks[0]?.price) : NaN;
            const bestBid = bids.length ? Number(bids[0]?.price) : NaN;
            const chosenPrice = Number.isFinite(bestAsk) ? bestAsk : null;
            if (chosenPrice == null) return { success: false, skipped: true, reason: 'missing_book', symbol: upperSymbol, timeframe: tf, slug: marketSlug || null };
            const bidPrice = Number.isFinite(bestBid) ? bestBid : null;
            if (!force && this.cryptoAllAutoConfig.stoploss?.spreadGuardCents != null && bidPrice != null) {
                const spread = chosenPrice - bidPrice;
                const guard = Math.max(0, Math.floor(Number(this.cryptoAllAutoConfig.stoploss.spreadGuardCents) || 0)) / 100;
                if (guard > 0 && spread >= guard) {
                    return { success: false, skipped: true, reason: 'spread_guard', symbol: upperSymbol, timeframe: tf, slug: marketSlug || null, bestAsk: chosenPrice, bestBid: bidPrice, spread, guard };
                }
            }
            if (!force && chosenPrice < effectiveMinPrice) return { success: false, skipped: true, reason: 'min_prob', symbol: upperSymbol, timeframe: tf, slug: marketSlug || null, bestAsk: chosenPrice, minPrice: effectiveMinPrice };

            const globalKey = `cryptoall:${conditionId}`.toLowerCase();
            if (!force) {
                if (!this.tryAcquireGlobalOrderLock(globalKey, 'cryptoall')) {
                    return { success: false, skipped: true, reason: 'global_locked', symbol: upperSymbol, timeframe: tf, slug: marketSlug || null, expiresAtMs };
                }
                if (this.globalOrderPlaceInFlight) {
                    this.markGlobalOrderLockDone(globalKey, false);
                    return { success: false, skipped: true, reason: 'global_inflight', symbol: upperSymbol, timeframe: tf, slug: marketSlug || null, expiresAtMs };
                }
                this.globalOrderPlaceInFlight = true;
            }
            let ok = false;
            let orderId: string | null = null;
            let orderErrorMsg: string | null = null;
            try {
                const result = await this.tradingClient.createMarketOrder({ tokenId, amountUsd, limitPrice: Math.min(0.999, chosenPrice + 0.02), side: 'BUY' });
                ok = !!(result as any)?.success;
                orderId = (result as any)?.orderId || null;
                orderErrorMsg = (result as any)?.errorMsg != null ? String((result as any).errorMsg) : ((result as any)?.error != null ? String((result as any).error) : null);
            } finally {
                if (!force) {
                    this.globalOrderPlaceInFlight = false;
                    this.markGlobalOrderLockDone(globalKey, ok);
                }
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
                limitPrice: Math.min(0.999, chosenPrice + 0.02),
                amountUsd,
                addonWindow: params.addonWindow || null,
                addonRiskScore: params.addonRiskScore != null ? Number(params.addonRiskScore) : null,
                results: [{ success: ok, orderId, tokenId, outcome, conditionId, errorMsg: ok ? '' : (orderErrorMsg || '') }],
            };
            this.orderHistory.unshift(historyEntry);
            this.schedulePersistOrderHistory();

            if (source !== 'addon') {
                this.cryptoAllTrackedByCondition.set(conditionId, { orderedAt: new Date().toISOString(), symbol: upperSymbol, timeframe: tf, orderId, tokenId, outcome });
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
                if (this.cryptoAllAutoConfig.stoploss.enabled) {
                    const sizeEstimate = chosenPrice > 0 ? amountUsd / chosenPrice : 0;
                    this.registerCryptoAllStoplossPosition({ conditionId, tokenId, symbol: upperSymbol, timeframe: tf, endMs: expiresAtMs, entryPrice: chosenPrice, sizeEstimate });
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
                    results: [{ success: false, orderId: null, tokenId, outcome, conditionId, errorMsg: errMsg }],
                };
                this.orderHistory.unshift(historyEntry);
                this.schedulePersistOrderHistory();
            } catch {}
            if (!force && orderLockKey) {
                this.cryptoAllOrderLocks.set(orderLockKey, { atMs: Date.now(), key: `${tf}:${upperSymbol}`, expiresAtMs, conditionId, status: 'failed' });
            }
            return { success: false, error: e?.message || String(e) };
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
            if (this.orderHistory.length > 50) this.orderHistory.pop();
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
        if (this.orderHistory.length > 50) this.orderHistory.pop();
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
        if (this.orderHistory.length > 50) this.orderHistory.pop();
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
        if (this.orderHistory.length > 50) this.orderHistory.pop();

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
                        if (this.orderHistory.length > 50) this.orderHistory.pop();
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
                                    if (this.orderHistory.length > 50) this.orderHistory.pop();
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
                        if (this.orderHistory.length > 50) this.orderHistory.pop();
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
