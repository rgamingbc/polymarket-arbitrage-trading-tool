/**
 * Whale Discovery Service
 * 
 * 从链上交易中发现潜在的跟单目标（鲸鱼）。
 * 两阶段过滤：链上预过滤 + 批量分析。
 * 
 * 工作流程：
 * 1. 监控所有 CTF 交易
 * 2. 预过滤：小额交易、已分析地址、合约地址
 * 3. 批量分析：每分钟分析队列中的新地址
 * 4. 输出：符合条件的鲸鱼候选人
 */

import { EventEmitter } from 'events';
// 使用编译后的 SDK
import {
    ChainMonitorClient,
    TransferEvent,
    isOfficialAddress,
} from '../../../dist/index.js';

// ===== Types =====

export interface WhaleDiscoveryConfig {
    /** Infura API Key */
    infuraApiKey: string;

    /** 启用 WebSocket (default: true) */
    wsEnabled?: boolean;

    /** 最小交易金额 USDC (default: 50) */
    minTradeUsdcValue?: number;

    /** 地址缓存时间小时 (default: 24) */
    addressCacheTtlHours?: number;

    /** 最大缓存地址数 (default: 50000) */
    maxCachedAddresses?: number;

    /** 分析间隔秒数 (default: 60) */
    analysisIntervalSec?: number;

    /** 每批最多分析数 (default: 10) */
    maxAnalysisPerBatch?: number;

    /** 最低胜率 (default: 0.55) */
    minWinRate?: number;

    /** 最低盈利 (default: 1000) */
    minPnl?: number;

    /** 最低交易量 (default: 5000) */
    minVolume?: number;

    /** 最少观察到的交易次数 (default: 3) */
    minTradesObserved?: number;
}

export interface WalletProfile {
    pnl: number;
    winRate: number;
    totalVolume: number;
    smartScore: number;
    totalTrades: number;
}

export interface WhaleCandidate {
    address: string;
    discoveredAt: Date;
    tradesObserved: number;
    volumeObserved: number;
    profile?: WalletProfile;
}

export interface TradeRecord {
    txHash: string;
    from: string;
    to: string;
    tokenId: string;
    amount: string;
    blockNumber: number;
    timestamp: number;
}

export interface DiscoveryStats {
    running: boolean;
    mode: 'websocket' | 'polling' | 'disconnected';
    startedAt?: Date;
    runtime: string;
    tradesObserved: number;
    addressesAnalyzed: number;
    whalesDiscovered: number;
    queueSize: number;
}

export interface AnalyzedAddress {
    address: string;
    analyzedAt: number;
    isWhale: boolean;
    profile?: WalletProfile;
}

// ===== LRU Cache =====

class LRUCache<K, V> {
    private cache = new Map<K, { value: V; expiry: number }>();
    private maxSize: number;
    private ttlMs: number;

    constructor(maxSize: number, ttlMs: number) {
        this.maxSize = maxSize;
        this.ttlMs = ttlMs;
    }

    get(key: K): V | undefined {
        const entry = this.cache.get(key);
        if (!entry) return undefined;

        if (Date.now() > entry.expiry) {
            this.cache.delete(key);
            return undefined;
        }

        // Move to end (most recently used)
        this.cache.delete(key);
        this.cache.set(key, entry);
        return entry.value;
    }

    set(key: K, value: V): void {
        // Remove oldest if at capacity
        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            if (firstKey !== undefined) {
                this.cache.delete(firstKey);
            }
        }

        this.cache.set(key, {
            value,
            expiry: Date.now() + this.ttlMs,
        });
    }

    has(key: K): boolean {
        return this.get(key) !== undefined;
    }

    size(): number {
        return this.cache.size;
    }

    clear(): void {
        this.cache.clear();
    }
}

// ===== Circular Buffer =====

class CircularBuffer<T> {
    private buffer: T[] = [];
    private maxSize: number;

    constructor(maxSize: number) {
        this.maxSize = maxSize;
    }

    push(item: T): void {
        if (this.buffer.length >= this.maxSize) {
            this.buffer.shift();
        }
        this.buffer.push(item);
    }

    getAll(): T[] {
        return [...this.buffer];
    }

    getRecent(limit: number): T[] {
        return this.buffer.slice(-limit);
    }

    size(): number {
        return this.buffer.length;
    }

    clear(): void {
        this.buffer = [];
    }
}

// ===== Whale Discovery Service =====

export class WhaleDiscoveryService extends EventEmitter {
    private config: Required<WhaleDiscoveryConfig>;
    private chainMonitor: ChainMonitorClient | null = null;

    private isRunning = false;
    private startedAt?: Date;

    // 缓存
    private analyzedAddresses: LRUCache<string, AnalyzedAddress>;
    private discoveredWhales = new Map<string, WhaleCandidate>();
    private recentTrades: CircularBuffer<TradeRecord>;
    private analysisQueue = new Set<string>();
    private addressTradeCount = new Map<string, { count: number; volume: number }>();

    // 定时器
    private analysisTimer: ReturnType<typeof setInterval> | null = null;

    // 统计
    private stats = {
        tradesObserved: 0,
        addressesAnalyzed: 0,
    };

    // 钱包分析函数（外部注入）
    private analyzeWallet?: (address: string) => Promise<WalletProfile | null>;
    // 鲸鱼确认回调（用于缓存预热）
    private whaleConfirmedCallback?: (address: string) => Promise<void>;

    constructor(config: WhaleDiscoveryConfig) {
        super();

        this.config = {
            infuraApiKey: config.infuraApiKey,
            wsEnabled: config.wsEnabled ?? true,
            minTradeUsdcValue: config.minTradeUsdcValue ?? 50,
            addressCacheTtlHours: config.addressCacheTtlHours ?? 24,
            maxCachedAddresses: config.maxCachedAddresses ?? 50000,
            analysisIntervalSec: config.analysisIntervalSec ?? 60,
            maxAnalysisPerBatch: config.maxAnalysisPerBatch ?? 10,
            minWinRate: config.minWinRate ?? 0.55,
            minPnl: config.minPnl ?? 1000,
            minVolume: config.minVolume ?? 5000,
            minTradesObserved: config.minTradesObserved ?? 3,
        };

        // 初始化缓存
        const ttlMs = this.config.addressCacheTtlHours * 60 * 60 * 1000;
        this.analyzedAddresses = new LRUCache(this.config.maxCachedAddresses, ttlMs);
        this.recentTrades = new CircularBuffer(10000);
    }

    /**
     * 设置钱包分析函数
     */
    setWalletAnalyzer(analyzer: (address: string) => Promise<WalletProfile | null>): void {
        this.analyzeWallet = analyzer;
    }

    /**
     * 设置鲸鱼确认回调（用于缓存预热）
     */
    setWhaleConfirmedCallback(callback: (address: string) => Promise<void>): void {
        this.whaleConfirmedCallback = callback;
    }

    /**
     * 设置用户信息获取函数
     */
    private fetchUserProfile?: (address: string) => Promise<{ userName?: string; profileImage?: string } | null>;

    setUserProfileFetcher(fetcher: (address: string) => Promise<{ userName?: string; profileImage?: string } | null>): void {
        this.fetchUserProfile = fetcher;
    }

    /**
     * 启动发现服务
     */
    async start(): Promise<void> {
        if (this.isRunning) {
            return;
        }

        this.isRunning = true;
        this.startedAt = new Date();

        // 初始化链上监控
        this.chainMonitor = new ChainMonitorClient({
            infuraApiKey: this.config.infuraApiKey,
            wsEnabled: this.config.wsEnabled,
            // 不在链上过滤金额，因为我们需要完整的交易数据来统计
            minTransferValue: '0',
        });

        // 监听事件
        this.chainMonitor.on('transfer', this.handleTransfer.bind(this));
        this.chainMonitor.on('error', (error) => this.emit('error', error));
        this.chainMonitor.on('connected', (info) => this.emit('connected', info));
        this.chainMonitor.on('disconnected', () => this.emit('disconnected'));

        // 连接
        await this.chainMonitor.connect();

        // 启动分析定时器
        this.analysisTimer = setInterval(
            () => this.runAnalysisBatch(),
            this.config.analysisIntervalSec * 1000
        );

        this.emit('started');
    }

    /**
     * 停止服务
     */
    stop(): void {
        this.isRunning = false;

        if (this.analysisTimer) {
            clearInterval(this.analysisTimer);
            this.analysisTimer = null;
        }

        if (this.chainMonitor) {
            this.chainMonitor.disconnect();
            this.chainMonitor = null;
        }

        this.emit('stopped');
    }

    /**
     * 获取服务状态
     */
    getStatus(): DiscoveryStats {
        const runtime = this.startedAt
            ? this.formatRuntime(Date.now() - this.startedAt.getTime())
            : '0s';

        return {
            running: this.isRunning,
            mode: this.chainMonitor?.getMode() || 'disconnected',
            startedAt: this.startedAt,
            runtime,
            tradesObserved: this.stats.tradesObserved,
            addressesAnalyzed: this.stats.addressesAnalyzed,
            whalesDiscovered: this.discoveredWhales.size,
            queueSize: this.analysisQueue.size,
        };
    }

    /**
     * 获取发现的鲸鱼
     */
    getWhales(sort: 'pnl' | 'volume' | 'winRate' = 'pnl', limit = 50): WhaleCandidate[] {
        const whales = Array.from(this.discoveredWhales.values());

        // 排序
        whales.sort((a, b) => {
            if (!a.profile || !b.profile) return 0;
            switch (sort) {
                case 'pnl':
                    return b.profile.pnl - a.profile.pnl;
                case 'volume':
                    return b.profile.totalVolume - a.profile.totalVolume;
                case 'winRate':
                    return b.profile.winRate - a.profile.winRate;
                default:
                    return 0;
            }
        });

        return whales.slice(0, limit);
    }

    /**
     * 获取最近交易
     */
    getRecentTrades(limit = 100): TradeRecord[] {
        return this.recentTrades.getRecent(limit);
    }

    /**
     * 获取配置
     */
    getConfig(): Required<WhaleDiscoveryConfig> {
        // Return copy without sensitive data
        return {
            ...this.config,
            infuraApiKey: '***',
        };
    }

    /**
     * 更新配置（运行时）
     */
    updateConfig(updates: Partial<WhaleDiscoveryConfig>): void {
        if (updates.minTradeUsdcValue !== undefined) {
            this.config.minTradeUsdcValue = updates.minTradeUsdcValue;
        }
        if (updates.minWinRate !== undefined) {
            this.config.minWinRate = updates.minWinRate;
        }
        if (updates.minPnl !== undefined) {
            this.config.minPnl = updates.minPnl;
        }
        if (updates.minVolume !== undefined) {
            this.config.minVolume = updates.minVolume;
        }
        if (updates.minTradesObserved !== undefined) {
            this.config.minTradesObserved = updates.minTradesObserved;
        }
        if (updates.maxAnalysisPerBatch !== undefined) {
            // 限制最大值为 10，避免 API 调用超限
            this.config.maxAnalysisPerBatch = Math.min(updates.maxAnalysisPerBatch, 10);
        }
        if (updates.analysisIntervalSec !== undefined && updates.analysisIntervalSec >= 10) {
            this.config.analysisIntervalSec = updates.analysisIntervalSec;
            // 重置定时器
            this.resetAnalysisTimer();
        }
    }

    /**
     * 重置分析定时器
     */
    private resetAnalysisTimer(): void {
        if (this.analysisTimer) {
            clearInterval(this.analysisTimer);
        }
        if (this.isRunning) {
            this.analysisTimer = setInterval(
                () => this.runAnalysisBatch(),
                this.config.analysisIntervalSec * 1000
            );
        }
    }

    // ===== Private Methods =====

    private handleTransfer(event: TransferEvent): void {
        this.stats.tradesObserved++;

        // 记录交易
        const trade: TradeRecord = {
            txHash: event.txHash,
            from: event.from,
            to: event.to,
            tokenId: event.tokenId,
            amount: event.amount,
            blockNumber: event.blockNumber,
            timestamp: event.timestamp,
        };
        this.recentTrades.push(trade);
        this.emit('trade', trade);

        // 分析发送方（卖出行为）
        this.processAddress(event.from, event.amount);

        // 分析接收方（买入行为）
        if (!isOfficialAddress(event.to)) {
            this.processAddress(event.to, event.amount);
        }
    }

    private processAddress(address: string, amount: string): void {
        // 过滤官方地址
        if (isOfficialAddress(address)) {
            return;
        }

        // 过滤零地址
        if (address === '0x0000000000000000000000000000000000000000') {
            return;
        }

        // 更新交易计数
        const existing = this.addressTradeCount.get(address) || { count: 0, volume: 0 };
        existing.count++;
        // 简单估算 USDC 价值（假设代币价值 ~$0.5）
        const amountNum = parseFloat(amount) / 1e6 * 0.5;
        existing.volume += amountNum;
        this.addressTradeCount.set(address, existing);

        // 过滤小额交易者
        if (existing.volume < this.config.minTradeUsdcValue) {
            return;
        }

        // 过滤已分析地址
        if (this.analyzedAddresses.has(address)) {
            return;
        }

        // 检查最小交易次数
        if (existing.count < this.config.minTradesObserved) {
            return;
        }

        // 添加到分析队列
        this.analysisQueue.add(address);
    }

    private async runAnalysisBatch(): Promise<void> {
        if (!this.analyzeWallet || this.analysisQueue.size === 0) {
            return;
        }

        // 取出待分析地址
        const addresses = Array.from(this.analysisQueue).slice(0, this.config.maxAnalysisPerBatch);

        for (const address of addresses) {
            this.analysisQueue.delete(address);

            try {
                const profile = await this.analyzeWallet(address);
                this.stats.addressesAnalyzed++;

                if (profile && this.meetsWhaleCriteria(profile)) {
                    const tradeInfo = this.addressTradeCount.get(address) || { count: 0, volume: 0 };

                    const whale: WhaleCandidate = {
                        address,
                        discoveredAt: new Date(),
                        tradesObserved: tradeInfo.count,
                        volumeObserved: tradeInfo.volume,
                        profile,
                    };

                    this.discoveredWhales.set(address, whale);
                    this.emit('newWhale', whale);

                    // 调用鲸鱼确认回调（用于缓存预热）
                    if (this.whaleConfirmedCallback) {
                        try {
                            await this.whaleConfirmedCallback(address);
                        } catch (err) {
                            console.error(`[WhaleDiscovery] Cache callback failed for ${address}:`, err);
                        }
                    }

                    // 缓存为鲸鱼
                    this.analyzedAddresses.set(address, {
                        address,
                        analyzedAt: Date.now(),
                        isWhale: true,
                        profile,
                    });
                } else {
                    // 缓存为非鲸鱼
                    this.analyzedAddresses.set(address, {
                        address,
                        analyzedAt: Date.now(),
                        isWhale: false,
                        profile: profile || undefined,
                    });
                }
            } catch (error) {
                // eslint-disable-next-line no-console
                console.error(`[WhaleDiscovery] Failed to analyze ${address}:`, error);
            }

            // 简单限速
            await this.sleep(100);
        }
    }

    private meetsWhaleCriteria(profile: WalletProfile): boolean {
        return (
            profile.winRate >= this.config.minWinRate &&
            profile.pnl >= this.config.minPnl &&
            profile.totalVolume >= this.config.minVolume
        );
    }

    private formatRuntime(ms: number): string {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);

        if (hours > 0) {
            return `${hours}h ${minutes % 60}m`;
        } else if (minutes > 0) {
            return `${minutes}m ${seconds % 60}s`;
        } else {
            return `${seconds}s`;
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
