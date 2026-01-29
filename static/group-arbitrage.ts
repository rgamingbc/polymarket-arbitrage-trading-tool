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
    private crypto15mAutoConfig: { pollMs: number; expiresWithinSec: number; minProb: number; amountUsd: number } = { pollMs: 2_000, expiresWithinSec: 180, minProb: 0.9, amountUsd: 1 };
    private crypto15mLastScanAt: string | null = null;
    private crypto15mLastError: string | null = null;
    private crypto15mActivesBySymbol: Map<string, any> = new Map();
    private crypto15mTrackedByCondition: Map<string, any> = new Map();
    private crypto15mCooldownUntilBySymbol: Map<string, number> = new Map();
    private crypto15mCryptoTagId: string | null = null;
    private crypto15mNextScanAllowedAtMs = 0;
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
            const envList = process.env.POLY_RPC_URLS || process.env.POLY_CTF_RPC_URLS || process.env.POLY_RPC_FALLBACK_URLS;
            const urls = (envList ? String(envList).split(',') : [
                process.env.POLY_CTF_RPC_URL,
                process.env.POLY_RPC_URL,
                'https://polygon-rpc.com',
                'https://rpc.ankr.com/polygon',
                'https://polygon.llamarpc.com',
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
        this.relayerSafe = null;
        this.relayerProxy = null;
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
                if (this.isRelayerAuthError(e)) throw new Error(`Relayer proxy auth failed: ${e?.message || String(e)}`);
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
                if (this.isRelayerAuthError(e)) throw new Error(`Relayer safe auth failed: ${e?.message || String(e)}`);
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
                if (this.isRelayerAuthError(e)) throw new Error(`Relayer proxy auth failed: ${e?.message || String(e)}`);
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
        const tokens = market.tokens || [];
        const yesToken = tokens.find((t: any) => String(t?.outcome ?? '').toLowerCase() === 'yes');
        const noToken = tokens.find((t: any) => String(t?.outcome ?? '').toLowerCase() === 'no');
        const yesTokenId = yesToken?.token_id ?? yesToken?.tokenId ?? yesToken?.id;
        const noTokenId = noToken?.token_id ?? noToken?.tokenId ?? noToken?.id;

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
            const res = await fetch(url, { headers });
            if (!res.ok) throw new Error(`Data API positions failed (${res.status})`);
            const data = await res.json().catch(() => []);
            return Array.isArray(data) ? data : [];
        };
        try {
            return await tryOnce();
        } catch {
            await new Promise(r => setTimeout(r, 300));
            try {
                return await tryOnce();
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
            const res = await fetch(url, { headers });
            if (!res.ok) throw new Error(`Data API value failed (${res.status})`);
            const data = await res.json().catch(() => []);
            const first = Array.isArray(data) ? data[0] : null;
            const v = Number(first?.value ?? 0);
            return Number.isFinite(v) ? v : 0;
        };
        try {
            return await tryOnce();
        } catch {
            await new Promise(r => setTimeout(r, 300));
            try {
                return await tryOnce();
            } catch {
                return 0;
            }
        }
    }

    private shouldRotateRpc(e: any): boolean {
        const msg = String(e?.message || e || '');
        return msg.includes('Too many requests') || msg.includes('rate limit') || msg.includes('-32090') || msg.includes('429') || msg.includes('noNetwork') || msg.includes('NETWORK_ERROR');
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
        const provider = this.redeemProvider || this.createRpcProvider(process.env.POLY_CTF_RPC_URL || process.env.POLY_RPC_URL || 'https://polygon-rpc.com');
        const receipt: any = await this.withRpcRetry(() => provider.getTransactionReceipt(hash));
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
                                if (payout.txStatus !== 0 && Number(payout.netUsdc) <= 0) {
                                    cur.status = 'failed';
                                    cur.error = 'No USDC payout detected';
                                }
                                cur.payoutComputedAt = new Date().toISOString();
                            } catch {
                            }
                        }
                        this.crypto15mSyncFromRedeemInFlight(conditionId);
                    }
                } catch (e: any) {
                    const cur = this.redeemInFlight.get(conditionId);
                    if (cur) {
                        cur.status = 'failed';
                        cur.error = e?.message || String(e);
                    }
                    this.crypto15mSyncFromRedeemInFlight(conditionId);
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
        this.redeemDrainLast = { startedAt, finishedAt: null, source, submitted: 0, skippedInFlight: 0, remaining: null, errors: 0 };

        const run = async () => {
            try {
                const funder = this.getFunderAddress();
                const before = await this.getPortfolioSummary({ positionsLimit: 1 }).catch(() => null);
                const cashBefore = before?.cash != null ? Number(before.cash) : null;
                const claimableCountBefore = before?.claimableCount != null ? Number(before.claimableCount) : null;
                let submitted = 0;
                let skippedInFlight = 0;
                let errors = 0;
                const submittedResults: any[] = [];
                const conditionIds: string[] = [];
                while (submitted < maxTotal) {
                    this.cleanupRedeemInFlight();
                    const positions = await this.fetchDataApiPositions(funder);
                    const redeemables = (positions || []).filter((p: any) => !!p?.redeemable && p?.conditionId);
                    const next = redeemables.find((p: any) => !this.redeemInFlight.has(String(p.conditionId)));
                    if (!next) {
                        skippedInFlight += redeemables.length;
                        this.redeemDrainLast.remaining = redeemables.length;
                        break;
                    }
                    const conditionId = String(next.conditionId);
                    try {
                        const proxyWallet = String(next.proxyWallet || '').trim();
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
                            submitted += 1;
                            conditionIds.push(conditionId);
                            this.redeemDrainLast.submitted = submitted;
                            this.redeemDrainLast.remaining = redeemables.length - submitted;
                            this.autoRedeemLast = { at: new Date().toISOString(), source, count: submitted, ok: submitted, fail: 0 };
                            this.autoRedeemLastError = null;
                            submittedResults.push({
                                success: true,
                                confirmed: true,
                                redeemStatus: 'confirmed',
                                conditionId,
                                title: next.title,
                                outcome: next.outcome,
                                slug: next.slug,
                                eventSlug: next.eventSlug,
                                polymarketUrl: this.buildPolymarketMarketUrlFromSlug(next.slug),
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
                        } else {
                            const r = await this.redeemNow({ max: 1, source });
                            submitted += 1;
                            this.redeemDrainLast.submitted = submitted;
                            this.redeemDrainLast.remaining = redeemables.length - submitted;
                        }
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
        const res = await fetch(url, { headers });
        if (!res.ok) {
            const retryAfter = res.headers?.get ? res.headers.get('retry-after') : null;
            const err: any = new Error(`Gamma API failed (${res.status})`);
            if (res.status === 429) {
                const sec = retryAfter != null && retryAfter !== '' ? Number(retryAfter) : NaN;
                err.retryAfterMs = Number.isFinite(sec) ? Math.max(1, sec) * 1000 : 60_000;
            }
            throw err;
        }
        return await res.json();
    }

    private tryParseJsonArray(raw: any): any[] {
        if (Array.isArray(raw)) return raw;
        try {
            const parsed = JSON.parse(String(raw || '[]'));
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
        try {
            const headers: any = {
                'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'accept-language': 'en-US,en;q=0.9',
                'cache-control': 'no-cache',
                'pragma': 'no-cache',
            };
            const res = await fetch('https://polymarket.com/crypto/15M', { headers });
            if (!res.ok) return [];
            const html = await res.text();
            const slugs: string[] = [];
            const re = /\/event\/([a-z0-9-]{6,})/gi;
            let m: RegExpExecArray | null;
            while ((m = re.exec(html)) && slugs.length < limit * 3) {
                slugs.push(String(m[1]).toLowerCase());
            }
            return Array.from(new Set(slugs)).slice(0, limit);
        } catch {
            return [];
        }
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
        try {
            const url = `https://polymarket.com/event/${encodeURIComponent(eventSlug)}`;
            const headers: any = {
                'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'accept-language': 'en-US,en;q=0.9',
                'cache-control': 'no-cache',
                'pragma': 'no-cache',
            };
            const res = await fetch(url, { headers });
            if (!res.ok) return null;
            const html = await res.text();
            const m = html.match(/id=\"__NEXT_DATA__\"[^>]*>([\s\S]*?)<\/script>/i);
            if (!m || !m[1]) return null;
            const data = JSON.parse(m[1]);
            const found = this.findObjectDeep(data, (x: any) => x?.slug === eventSlug && x?.conditionId && x?.outcomes && x?.outcomePrices && x?.clobTokenIds);
            return found;
        } catch {
            return null;
        }
    }

    async getCrypto15mCandidates(options?: { minProb?: number; expiresWithinSec?: number; limit?: number }) {
        const minProb = Math.max(0, Math.min(1, Number(options?.minProb ?? this.crypto15mAutoConfig.minProb)));
        const expiresWithinSec = Math.max(5, Math.floor(Number(options?.expiresWithinSec ?? this.crypto15mAutoConfig.expiresWithinSec)));
        const limit = Math.max(1, Math.floor(Number(options?.limit ?? 20)));

        const now = Date.now();
        const is15m = (m: any) => {
            const title = String(m?.question || m?.title || '').toLowerCase();
            const slug = String(m?.slug || '').toLowerCase();
            const has15m = /\b15\s*(m|min|mins|minute|minutes)\b/.test(title) || slug.includes('15m') || slug.includes('15-min') || slug.includes('-15m-');
            const hasUpDown = title.includes('up or down') || title.includes('up/down') || title.includes('updown') || slug.includes('updown');
            return has15m && hasUpDown;
        };

        const markets: any[] = [];

        const slugs = await this.fetchCrypto15mSlugsFromSite(30);
        const priorityPrefixes = ['btc-updown-15m', 'eth-updown-15m', 'sol-updown-15m'];
        const nowSec = Math.floor(now / 1000);
        const getSymbolFromSlug = (slug: string): string | null => {
            const s = String(slug || '').toLowerCase();
            if (s.startsWith('btc-')) return 'BTC';
            if (s.startsWith('eth-')) return 'ETH';
            if (s.startsWith('sol-')) return 'SOL';
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
        const uniqueSlugs = Array.from(new Set(slugs));
        const candidateSlugs = uniqueSlugs
            .filter(s => priorityPrefixes.some(p => s.startsWith(p)))
            .map(s => {
                const startSec = parseStartSecFromSlug(s);
                const endSec = startSec != null ? startSec + 15 * 60 : null;
                return { slug: s, startSec, endSec };
            })
            .filter(x => x.endSec != null && (x.endSec as number) >= nowSec - 60)
            .sort((a, b) => (a.endSec as number) - (b.endSec as number));

        const picked: string[] = [];
        for (const prefix of priorityPrefixes) {
            const next = candidateSlugs.find(x => x.slug.startsWith(prefix) && (x.endSec as number) >= nowSec);
            if (next) picked.push(next.slug);
        }
        const orderedSlugs = Array.from(new Set(picked.concat(candidateSlugs.slice(0, 6).map(x => x.slug)))).slice(0, 8);

        for (const eventSlug of orderedSlugs) {
            const m = await this.fetchEventMarketFromSite(eventSlug);
            if (m) markets.push(m);
        }

        if (!markets.length) {
            const tagId = await this.resolveCryptoTagId();
            const tagParam = tagId ? `&tag_id=${encodeURIComponent(tagId)}` : '';
            const url = `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=200&offset=0${tagParam}`;
            const data = await this.fetchGammaJson(url);
            if (Array.isArray(data)) markets.push(...data);
        }

        const candidates: any[] = [];
        for (const m of markets) {
            if (!m || !is15m(m)) continue;
            const conditionId = String(m?.conditionId || m?.condition_id || '').trim();
            if (!conditionId || !conditionId.startsWith('0x')) continue;
            const end = m?.endDateIso || m?.endDate || m?.umaEndDateIso || m?.umaEndDate;
            const slugStartSec = parseStartSecFromSlug(String(m?.slug || ''));
            let endMs = slugStartSec != null ? (slugStartSec + 15 * 60) * 1000 : Date.parse(String(end || ''));
            if (!Number.isFinite(endMs)) endMs = Date.parse(String(end || ''));
            if (!Number.isFinite(endMs)) continue;
            const secondsToExpire = Math.floor((endMs - now) / 1000);
            if (!(secondsToExpire > 0)) continue;

            const outcomes = this.tryParseJsonArray(m?.outcomes);
            const tokenIds = this.tryParseJsonArray(m?.clobTokenIds);
            if (outcomes.length < 2 || tokenIds.length < 2) continue;
            const outsLower = outcomes.map(x => x.toLowerCase());
            const hasUp = outsLower.some(x => x.includes('up'));
            const hasDown = outsLower.some(x => x.includes('down'));
            if (!hasUp || !hasDown) continue;

            const books = await Promise.allSettled(tokenIds.slice(0, 2).map((t: any) => {
                const tokenId = String(t ?? '').trim();
                if (!tokenId) return Promise.resolve(null as any);
                return withRetry(() => this.sdk.clobApi.getOrderbook(tokenId), { maxRetries: 1 });
            }));
            const prices = books.map((r: any) => {
                if (r?.status !== 'fulfilled') return NaN;
                const ob = r.value;
                const bestAsk = Number(ob?.asks?.[0]?.price);
                return Number.isFinite(bestAsk) && bestAsk > 0 ? bestAsk : NaN;
            });
            if (!Number.isFinite(prices[0]) || !Number.isFinite(prices[1])) continue;

            let bestIdx = -1;
            let bestPrice = -1;
            for (let i = 0; i < Math.min(outcomes.length, tokenIds.length, prices.length); i++) {
                const pr = Number(prices[i]);
                if (!Number.isFinite(pr)) continue;
                if (pr > bestPrice) {
                    bestPrice = pr;
                    bestIdx = i;
                }
            }
            if (bestIdx < 0) continue;

            candidates.push({
                symbol: getSymbolFromSlug(String(m?.slug || '')),
                conditionId,
                slug: m?.slug,
                title: m?.question || m?.title,
                endDate: new Date(endMs).toISOString(),
                secondsToExpire,
                eligibleByExpiry: secondsToExpire <= expiresWithinSec,
                meetsMinProb: bestPrice >= minProb,
                outcomes: outcomes.slice(0, 2),
                prices: prices.slice(0, 2),
                tokenIds: tokenIds.slice(0, 2),
                chosenIndex: bestIdx,
                chosenOutcome: String(outcomes[bestIdx]),
                chosenPrice: bestPrice,
                chosenTokenId: String(tokenIds[bestIdx]),
            });
        }

        candidates.sort((a, b) => (b.meetsMinProb ? 1 : 0) - (a.meetsMinProb ? 1 : 0) || b.chosenPrice - a.chosenPrice || a.secondsToExpire - b.secondsToExpire);
        const countEligible = candidates.filter(c => c.meetsMinProb && c.eligibleByExpiry).length;
        return { success: true, count: candidates.length, countEligible, candidates: candidates.slice(0, limit) };
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
        if (!this.hasValidKey) {
            this.crypto15mLastError = 'Missing private key';
            return;
        }
        const nowMs = Date.now();
        this.crypto15mUpdateTracking(nowMs);
        this.crypto15mLastScanAt = new Date(nowMs).toISOString();
        try {
            const r = await this.getCrypto15mCandidates({ minProb: this.crypto15mAutoConfig.minProb, expiresWithinSec: this.crypto15mAutoConfig.expiresWithinSec, limit: 30 });
            const candidates = Array.isArray((r as any)?.candidates) ? (r as any).candidates : [];
            const symbols = ['BTC', 'ETH', 'SOL'];
            for (const symbol of symbols) {
                if (this.crypto15mActivesBySymbol.has(symbol)) continue;
                const cd = this.crypto15mCooldownUntilBySymbol.get(symbol);
                if (cd != null && nowMs < cd) continue;
                const pick = candidates.find((c: any) => String(c?.symbol || '').toUpperCase() === symbol && c?.eligibleByExpiry && c?.meetsMinProb) || null;
                if (!pick) continue;
                const cid = String(pick.conditionId || '');
                if (cid && this.crypto15mTrackedByCondition.has(cid)) continue;
                await this.placeCrypto15mOrder({
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
            }
        } catch (e: any) {
            if (e?.retryAfterMs != null || String(e?.message || '').includes('(429)')) {
                const retryAfterMs = e?.retryAfterMs != null ? Number(e.retryAfterMs) : 60_000;
                this.crypto15mNextScanAllowedAtMs = Date.now() + Math.max(5_000, retryAfterMs);
            }
            this.crypto15mLastError = e?.message || String(e);
        }
    }

    startCrypto15mAuto(config?: { enabled?: boolean; amountUsd?: number; minProb?: number; expiresWithinSec?: number; pollMs?: number }) {
        const enabled = config?.enabled != null ? !!config.enabled : true;
        const amountUsd = config?.amountUsd != null ? Number(config.amountUsd) : this.crypto15mAutoConfig.amountUsd;
        const minProb = config?.minProb != null ? Number(config.minProb) : this.crypto15mAutoConfig.minProb;
        const expiresWithinSec = config?.expiresWithinSec != null ? Number(config.expiresWithinSec) : this.crypto15mAutoConfig.expiresWithinSec;
        const pollMs = config?.pollMs != null ? Number(config.pollMs) : this.crypto15mAutoConfig.pollMs;

        this.crypto15mAutoConfig = {
            pollMs: Math.max(500, Math.floor(pollMs)),
            expiresWithinSec: Math.max(5, Math.floor(expiresWithinSec)),
            minProb: Math.max(0, Math.min(1, minProb)),
            amountUsd: Math.max(0.5, Number.isFinite(amountUsd) ? amountUsd : 1),
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
        const amountUsd = params.amountUsd != null ? Number(params.amountUsd) : this.crypto15mAutoConfig.amountUsd;
        const source = params.source || 'semi';
        const force = params.force === true;
        const minPrice = params.minPrice != null ? Number(params.minPrice) : this.crypto15mAutoConfig.minProb;

        const market = await withRetry(() => this.sdk.clobApi.getMarket(conditionId), { maxRetries: 2 });
        const tokens = Array.isArray(market?.tokens) ? market.tokens : [];
        if (tokens.length < 2) throw new Error('Invalid market tokens');
        const idx = params.outcomeIndex != null ? Math.max(0, Math.min(tokens.length - 1, Math.floor(Number(params.outcomeIndex)))) : 0;
        const tok = tokens[idx];
        const tokenId = String(tok?.token_id ?? tok?.tokenId ?? tok?.id ?? '').trim();
        if (!tokenId) throw new Error('Missing tokenId');
        const outcome = String(tok?.outcome ?? '').trim() || `idx_${idx}`;
        const ob = await withRetry(() => this.sdk.clobApi.getOrderbook(tokenId), { maxRetries: 1 }).catch(() => null);
        const bestAsk = Number(ob?.asks?.[0]?.price);
        const price = Number.isFinite(bestAsk) && bestAsk > 0 ? bestAsk : Number(tok?.price ?? tok?.last_price ?? tok?.lastPrice ?? 0);
        if (!force && Number.isFinite(minPrice) && minPrice > 0 && (!Number.isFinite(price) || price < minPrice)) {
            throw new Error(`Price below threshold: bestAsk=${Number.isFinite(price) ? price : 'N/A'} < minPrice=${minPrice}`);
        }

        const order = await this.tradingClient.createMarketOrder({
            tokenId,
            side: 'BUY',
            amount: Math.max(0.5, amountUsd),
            orderType: 'FOK',
        });

        const marketSlug = String(market?.market_slug ?? market?.marketSlug ?? '');
        const q = String(market?.question || '');
        const symbol = String(params.symbol || (marketSlug.toLowerCase().startsWith('btc-') ? 'BTC' : marketSlug.toLowerCase().startsWith('eth-') ? 'ETH' : marketSlug.toLowerCase().startsWith('sol-') ? 'SOL' : q.toLowerCase().includes('bitcoin') ? 'BTC' : q.toLowerCase().includes('ethereum') ? 'ETH' : q.toLowerCase().includes('solana') ? 'SOL' : 'UNKNOWN'));
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
        const expiresAtMs = endDate ? Date.parse(endDate) : NaN;
        if (symbol && symbol !== 'UNKNOWN') {
            if (this.crypto15mActivesBySymbol.has(symbol)) throw new Error(`Crypto15m already has an active order for ${symbol}`);
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
            price,
            amountUsd: Math.max(0.5, amountUsd),
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
            price,
            amountUsd: Math.max(0.5, amountUsd),
            source,
            orderId: order?.orderId ?? order?.id ?? null,
            order,
            endDate,
            expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : null,
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
        const tokens = market.tokens || [];
        const yesToken = tokens.find((t: any) => String(t?.outcome ?? '').toLowerCase() === 'yes') || tokens[0];
        const noToken = tokens.find((t: any) => String(t?.outcome ?? '').toLowerCase() === 'no') || tokens[1];

        const yesTokenId = yesToken?.token_id ?? yesToken?.tokenId ?? yesToken?.id;
        const noTokenId = noToken?.token_id ?? noToken?.tokenId ?? noToken?.id;
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
        const tokens = market.tokens || [];
        const yesToken = tokens.find((t: any) => String(t?.outcome ?? '').toLowerCase() === 'yes') || tokens[0];
        const noToken = tokens.find((t: any) => String(t?.outcome ?? '').toLowerCase() === 'no') || tokens[1];

        const yesTokenId = yesToken?.token_id ?? yesToken?.tokenId ?? yesToken?.id;
        const noTokenId = noToken?.token_id ?? noToken?.tokenId ?? noToken?.id;
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

        for (const token of tokens) {
            try {
                const tokenId = token.token_id ?? token.tokenId ?? token.id;
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
        for (const token of tokens) {
            try {
                const tokenId = token.token_id ?? token.tokenId ?? token.id;
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
