/**
 * Chain Monitor Client
 * 
 * 监控 Polygon 链上的 CTF (Conditional Token Framework) 交易事件。
 * 支持 WebSocket 实时订阅（主模式）和 HTTP 轮询（备用模式）。
 * 
 * 用途：
 * - 监控所有 CTF 代币转移事件
 * - 发现活跃交易者（用于鲸鱼发现）
 * - 跟踪特定钱包的交易活动
 * 
 * @example
 * ```typescript
 * const monitor = new ChainMonitorClient({
 *   infuraApiKey: 'your-key',
 *   wsEnabled: true,
 * });
 * 
 * await monitor.connect();
 * 
 * for await (const event of monitor.subscribeAllTransfers()) {
 *   console.log(`${event.from} → ${event.to}: ${event.amount} tokens`);
 * }
 * ```
 */

import { ethers, Contract } from 'ethers';
import { EventEmitter } from 'events';

// ===== Contract Addresses =====

/** Polymarket CTF Exchange (ERC1155) */
export const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';

/** NegRisk CTF Exchange */
export const NEG_RISK_CTF_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';

/** 实际的 CTF 条件代币合约 - ERC1155 代币转移发生在这里 */
export const CTF_CONTRACT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

/** NegRisk 适配器 */
export const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

/** Polymarket 官方地址（用于过滤） */
export const OFFICIAL_ADDRESSES = [
    '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E'.toLowerCase(), // CTF Exchange
    '0xC5d563A36AE78145C45a50134d48A1215220f80a'.toLowerCase(), // NegRisk Exchange
    '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045'.toLowerCase(), // CTF Contract
    '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296'.toLowerCase(), // NegRisk Adapter
    '0x0000000000000000000000000000000000000000'.toLowerCase(), // Zero address
];

// ===== ABIs =====

const ERC1155_ABI = [
    // TransferSingle(operator, from, to, id, value)
    'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
    // TransferBatch(operator, from, to, ids, values)  
    'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)',
];

// ===== Types =====

export interface ChainMonitorConfig {
    /** Infura API Key */
    infuraApiKey: string;

    /** Infura 网络 (default: 'polygon-mainnet') */
    infuraNetwork?: string;

    /** 启用 WebSocket (default: true) */
    wsEnabled?: boolean;

    /** 轮询间隔毫秒 (default: 3000) */
    pollingIntervalMs?: number;

    /** 最小交易金额过滤 (default: 0，不过滤) */
    minTransferValue?: string;

    /** 自动重连 (default: true) */
    autoReconnect?: boolean;

    /** 重连延迟毫秒 (default: 5000) */
    reconnectDelayMs?: number;

    /** 最大重连次数 (default: 10) */
    maxReconnectAttempts?: number;
}

export interface TransferEvent {
    /** 交易哈希 */
    txHash: string;

    /** 发送方地址 */
    from: string;

    /** 接收方地址 */
    to: string;

    /** CTF Token ID */
    tokenId: string;

    /** 代币数量 (字符串，避免 BigInt 兼容性问题) */
    amount: string;

    /** 区块号 */
    blockNumber: number;

    /** 时间戳 (秒) */
    timestamp: number;

    /** 是否为批量转移的一部分 */
    isBatch: boolean;

    /** 操作者地址 */
    operator: string;
}

export interface ChainMonitorStats {
    /** 连接模式 */
    mode: 'websocket' | 'polling' | 'disconnected';

    /** 是否已连接 */
    connected: boolean;

    /** 启动时间 */
    startedAt?: Date;

    /** 观察到的事件数 */
    eventsObserved: number;

    /** 最后收到事件时间 */
    lastEventAt?: Date;

    /** 重连次数 */
    reconnectCount: number;

    /** 当前区块号 */
    currentBlock?: number;
}

// ===== Chain Monitor Client =====

export class ChainMonitorClient extends EventEmitter {
    private config: Required<ChainMonitorConfig>;
    private httpProvider: ethers.providers.JsonRpcProvider | null = null;
    private wsProvider: ethers.providers.WebSocketProvider | null = null;
    private ctfContract: Contract | null = null;
    private negRiskContract: Contract | null = null;

    private isRunning = false;
    private currentMode: 'websocket' | 'polling' | 'disconnected' = 'disconnected';
    private pollingTimer: ReturnType<typeof setInterval> | null = null;
    private lastScannedBlock = 0;
    private reconnectAttempts = 0;
    private watchdogTimer: ReturnType<typeof setInterval> | null = null;
    private lastObservedCount = 0;
    private watchdogCheckCount = 0;

    private stats: ChainMonitorStats = {
        mode: 'disconnected',
        connected: false,
        eventsObserved: 0,
        reconnectCount: 0,
    };

    constructor(config: ChainMonitorConfig) {
        super();

        this.config = {
            infuraApiKey: config.infuraApiKey,
            infuraNetwork: config.infuraNetwork || 'polygon-mainnet',
            wsEnabled: config.wsEnabled ?? true,
            pollingIntervalMs: config.pollingIntervalMs || 3000,
            minTransferValue: config.minTransferValue || '0',
            autoReconnect: config.autoReconnect ?? true,
            reconnectDelayMs: config.reconnectDelayMs || 5000,
            maxReconnectAttempts: config.maxReconnectAttempts || 10,
        };
    }

    // ===== Public API =====

    /**
     * 连接到 Polygon 链
     */
    async connect(): Promise<void> {
        if (this.isRunning) {
            return;
        }

        this.isRunning = true;
        this.stats.startedAt = new Date();

        // 初始化 HTTP Provider（始终需要）
        const httpUrl = `https://${this.config.infuraNetwork}.infura.io/v3/${this.config.infuraApiKey}`;
        this.httpProvider = new ethers.providers.JsonRpcProvider(httpUrl);

        // 获取当前区块
        this.lastScannedBlock = await this.httpProvider.getBlockNumber();
        this.stats.currentBlock = this.lastScannedBlock;

        // 尝试 WebSocket 连接
        if (this.config.wsEnabled) {
            try {
                await this.connectWebSocket();
            } catch (error) {
                // eslint-disable-next-line no-console
                console.warn('[ChainMonitor] WebSocket connection failed, falling back to polling:', error);
                this.startPolling();
            }
        } else {
            this.startPolling();
        }
    }

    /**
     * 断开连接
     */
    disconnect(): void {
        this.isRunning = false;

        // 停止轮询
        if (this.pollingTimer) {
            clearInterval(this.pollingTimer);
            this.pollingTimer = null;
        }

        // 关闭 WebSocket
        if (this.wsProvider) {
            this.wsProvider.destroy();
            this.wsProvider = null;
        }

        // 清理看门狗
        if (this.watchdogTimer) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = null;
        }

        // 清理合约
        this.ctfContract = null;
        this.negRiskContract = null;

        this.currentMode = 'disconnected';
        this.stats.mode = 'disconnected';
        this.stats.connected = false;

        this.emit('disconnected');
    }

    /**
     * 获取服务状态
     */
    getStats(): ChainMonitorStats {
        return { ...this.stats };
    }

    /**
     * 是否已连接
     */
    isConnected(): boolean {
        return this.stats.connected;
    }

    /**
     * 获取当前模式
     */
    getMode(): 'websocket' | 'polling' | 'disconnected' {
        return this.currentMode;
    }

    /**
     * 订阅所有 CTF 转移事件（AsyncIterable）
     */
    async *subscribeAllTransfers(): AsyncIterable<TransferEvent> {
        const eventQueue: TransferEvent[] = [];
        let resolveNext: ((value: TransferEvent) => void) | null = null;

        const handler = (event: TransferEvent) => {
            if (resolveNext) {
                resolveNext(event);
                resolveNext = null;
            } else {
                eventQueue.push(event);
            }
        };

        this.on('transfer', handler);

        try {
            while (this.isRunning) {
                if (eventQueue.length > 0) {
                    yield eventQueue.shift()!;
                } else {
                    yield await new Promise<TransferEvent>((resolve) => {
                        resolveNext = resolve;
                    });
                }
            }
        } finally {
            this.off('transfer', handler);
        }
    }

    /**
     * 获取指定区块范围的历史事件
     */
    async getHistoricalTransfers(fromBlock: number, toBlock: number): Promise<TransferEvent[]> {
        if (!this.httpProvider) {
            throw new Error('Not connected');
        }

        const events: TransferEvent[] = [];

        // CTF Exchange
        const ctfContract = new Contract(CTF_EXCHANGE, ERC1155_ABI, this.httpProvider);
        const ctfFilter = ctfContract.filters.TransferSingle();
        const ctfLogs = await ctfContract.queryFilter(ctfFilter, fromBlock, toBlock);

        for (const log of ctfLogs) {
            const event = this.parseTransferLog(log, false);
            if (event) events.push(event);
        }

        // NegRisk Exchange
        const negRiskContract = new Contract(NEG_RISK_CTF_EXCHANGE, ERC1155_ABI, this.httpProvider);
        const negRiskFilter = negRiskContract.filters.TransferSingle();
        const negRiskLogs = await negRiskContract.queryFilter(negRiskFilter, fromBlock, toBlock);

        for (const log of negRiskLogs) {
            const event = this.parseTransferLog(log, false);
            if (event) events.push(event);
        }

        return events.sort((a, b) => a.blockNumber - b.blockNumber);
    }

    // ===== Private Methods =====

    private async connectWebSocket(): Promise<void> {
        const wsUrl = `wss://${this.config.infuraNetwork}.infura.io/ws/v3/${this.config.infuraApiKey}`;

        try {
            this.wsProvider = new ethers.providers.WebSocketProvider(wsUrl);

            // 添加全局错误处理防止 429 等错误导致崩溃
            this.wsProvider._websocket.on('error', (error: Error) => {
                // eslint-disable-next-line no-console
                console.error('[ChainMonitor] WebSocket error:', error.message);
                // 不立即处理，让 close 事件处理断开连接
            });

            // 等待连接
            await this.wsProvider.ready;
        } catch (error: any) {
            // 处理 429 或其他连接错误
            // eslint-disable-next-line no-console
            console.error(`[ChainMonitor] WebSocket connection failed: ${error.message}`);
            if (error.message?.includes('429')) {
                // eslint-disable-next-line no-console
                console.warn('[ChainMonitor] Rate limited (429), waiting 30s before retry...');
                await new Promise(r => setTimeout(r, 30000));
            }
            throw error; // 让上层处理降级到轮询
        }

        // 设置合约 - 监听实际的 CTF 合约而非交易所合约
        // CTF 代币转移发生在 CTF_CONTRACT 上
        this.ctfContract = new Contract(CTF_CONTRACT, ERC1155_ABI, this.wsProvider);
        this.negRiskContract = new Contract(NEG_RISK_ADAPTER, ERC1155_ABI, this.wsProvider);

        // eslint-disable-next-line no-console
        console.log(`[ChainMonitor] 订阅合约: ${CTF_CONTRACT.slice(0, 10)}..., ${NEG_RISK_ADAPTER.slice(0, 10)}...`);

        // 订阅 TransferSingle 事件
        this.ctfContract.on('TransferSingle', this.handleTransferSingle.bind(this));
        this.negRiskContract.on('TransferSingle', this.handleTransferSingle.bind(this));

        // 订阅 TransferBatch 事件
        this.ctfContract.on('TransferBatch', this.handleTransferBatch.bind(this));
        this.negRiskContract.on('TransferBatch', this.handleTransferBatch.bind(this));

        this.wsProvider._websocket.on('close', () => {
            // eslint-disable-next-line no-console
            console.warn('[ChainMonitor] WebSocket closed');
            this.handleDisconnect();
        });

        this.currentMode = 'websocket';
        this.stats.mode = 'websocket';
        this.stats.connected = true;
        this.reconnectAttempts = 0;
        this.lastObservedCount = this.stats.eventsObserved;
        this.watchdogCheckCount = 0;

        // 启动看门狗 (每 60 秒检查一次)
        if (this.watchdogTimer) clearInterval(this.watchdogTimer);
        this.watchdogTimer = setInterval(() => this.checkWatchdog(), 60000);

        this.emit('connected', { mode: 'websocket' });
    }

    /**
     * 看门狗检查逻辑
     * 如果连续 3 分钟没有任何链上事件（且处于活跃市场时段），强制重连
     */
    private checkWatchdog(): void {
        if (!this.isRunning || this.currentMode !== 'websocket') return;

        if (this.stats.eventsObserved === this.lastObservedCount) {
            this.watchdogCheckCount++;
            // 连续 3 分钟没动静（考虑到 Polygon 可能极偶尔没交易，给 3 次机会）
            if (this.watchdogCheckCount >= 3) {
                console.warn('[ChainMonitor] Watchdog detected silent connection, forcing reconnect...');
                this.handleDisconnect();
            }
        } else {
            this.lastObservedCount = this.stats.eventsObserved;
            this.watchdogCheckCount = 0;
        }
    }

    private handleTransferSingle(
        operator: string,
        from: string,
        to: string,
        id: ethers.BigNumber,
        value: ethers.BigNumber,
        event: ethers.Event
    ): void {
        const transferEvent: TransferEvent = {
            txHash: event.transactionHash,
            from: from.toLowerCase(),
            to: to.toLowerCase(),
            tokenId: id.toString(),
            amount: value.toString(),
            blockNumber: event.blockNumber,
            timestamp: Math.floor(Date.now() / 1000), // WebSocket 没有实时时间戳
            isBatch: false,
            operator: operator.toLowerCase(),
        };

        this.processEvent(transferEvent);
    }

    private handleTransferBatch(
        operator: string,
        from: string,
        to: string,
        ids: ethers.BigNumber[],
        values: ethers.BigNumber[],
        event: ethers.Event
    ): void {
        for (let i = 0; i < ids.length; i++) {
            const transferEvent: TransferEvent = {
                txHash: event.transactionHash,
                from: from.toLowerCase(),
                to: to.toLowerCase(),
                tokenId: ids[i].toString(),
                amount: values[i].toString(),
                blockNumber: event.blockNumber,
                timestamp: Math.floor(Date.now() / 1000),
                isBatch: true,
                operator: operator.toLowerCase(),
            };

            this.processEvent(transferEvent);
        }
    }

    private processEvent(event: TransferEvent): void {
        // 过滤小额交易
        const minValue = ethers.BigNumber.from(this.config.minTransferValue);
        if (minValue.gt(0) && ethers.BigNumber.from(event.amount).lt(minValue)) {
            return;
        }

        // 更新统计
        this.stats.eventsObserved++;
        this.stats.lastEventAt = new Date();
        this.stats.currentBlock = event.blockNumber;

        // 发射事件
        this.emit('transfer', event);
    }

    private parseTransferLog(log: ethers.Event, isBatch: boolean): TransferEvent | null {
        try {
            const args = log.args;
            if (!args) return null;

            return {
                txHash: log.transactionHash,
                from: (args[1] as string).toLowerCase(),
                to: (args[2] as string).toLowerCase(),
                tokenId: args[3].toString(),
                amount: args[4].toString(),
                blockNumber: log.blockNumber,
                timestamp: 0, // 需要额外查询区块时间
                isBatch,
                operator: (args[0] as string).toLowerCase(),
            };
        } catch {
            return null;
        }
    }

    private startPolling(): void {
        if (this.pollingTimer) {
            return;
        }

        this.currentMode = 'polling';
        this.stats.mode = 'polling';
        this.stats.connected = true;

        this.emit('connected', { mode: 'polling' });

        this.pollingTimer = setInterval(async () => {
            await this.pollNewBlocks();
        }, this.config.pollingIntervalMs);
    }

    private async pollNewBlocks(): Promise<void> {
        if (!this.httpProvider || !this.isRunning) {
            return;
        }

        try {
            const currentBlock = await this.httpProvider.getBlockNumber();

            if (currentBlock > this.lastScannedBlock) {
                const events = await this.getHistoricalTransfers(
                    this.lastScannedBlock + 1,
                    currentBlock
                );

                for (const event of events) {
                    this.processEvent(event);
                }

                this.lastScannedBlock = currentBlock;
                this.stats.currentBlock = currentBlock;
            }
        } catch (error) {
            // eslint-disable-next-line no-console
            console.error('[ChainMonitor] Polling error:', error);
            this.emit('error', error);
        }
    }

    private handleDisconnect(): void {
        if (!this.isRunning) {
            return;
        }

        this.stats.connected = false;

        // 清理 WebSocket
        if (this.wsProvider) {
            try {
                this.wsProvider.destroy();
            } catch {
                // Ignore
            }
            this.wsProvider = null;
            this.ctfContract = null;
            this.negRiskContract = null;
        }

        // 清理看门狗
        if (this.watchdogTimer) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = null;
        }

        // 自动重连
        if (this.config.autoReconnect && this.reconnectAttempts < this.config.maxReconnectAttempts) {
            this.reconnectAttempts++;
            this.stats.reconnectCount++;

            // eslint-disable-next-line no-console
            console.log(`[ChainMonitor] Reconnecting (${this.reconnectAttempts}/${this.config.maxReconnectAttempts})...`);

            setTimeout(async () => {
                if (this.isRunning) {
                    try {
                        await this.connectWebSocket();
                    } catch {
                        // 降级到轮询
                        this.startPolling();
                    }
                }
            }, this.config.reconnectDelayMs);
        } else if (this.currentMode === 'websocket') {
            // 降级到轮询
            // eslint-disable-next-line no-console
            console.log('[ChainMonitor] Falling back to polling mode');
            this.startPolling();
        }
    }
}

// ===== 辅助函数 =====

/**
 * 检查地址是否为合约
 */
export async function isContractAddress(
    provider: ethers.providers.Provider,
    address: string
): Promise<boolean> {
    try {
        const code = await provider.getCode(address);
        return code !== '0x';
    } catch {
        return false;
    }
}

/**
 * 检查地址是否为官方地址
 */
export function isOfficialAddress(address: string): boolean {
    return OFFICIAL_ADDRESSES.includes(address.toLowerCase());
}
