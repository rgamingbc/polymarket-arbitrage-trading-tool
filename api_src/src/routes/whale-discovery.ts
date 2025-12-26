/**
 * Whale Discovery REST API Routes
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { WhaleDiscoveryService, WhaleDiscoveryConfig } from '../services/whale-discovery-service.js';
// 使用编译后的 SDK dist
import { PolymarketSDK } from '../../../dist/index.js';
import * as fs from 'fs';
import * as path from 'path';

// 配置文件路径
const CONFIG_FILE_PATH = path.resolve(process.cwd(), '..', 'config.json');

// 全局服务实例
let whaleService: WhaleDiscoveryService | null = null;
let sdk: PolymarketSDK | null = null;

// 读取配置文件
function readConfigFile(): any {
    try {
        if (fs.existsSync(CONFIG_FILE_PATH)) {
            const data = fs.readFileSync(CONFIG_FILE_PATH, 'utf-8');
            return JSON.parse(data);
        }
    } catch {
        console.error('[Config] Failed to read config file');
    }
    return {};
}

// 保存配置文件
function saveConfigFile(config: any): void {
    try {
        fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(config, null, 4), 'utf-8');
    } catch (error) {
        console.error('[Config] Failed to save config file:', error);
    }
}

// ===== 鲸鱼数据缓存 =====

const WHALE_CACHE_FILE = path.resolve(process.cwd(), '..', 'whale_cache.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时

interface WhalePeriodData {
    pnl: number;
    volume: number;
    tradeCount: number;
    winRate: number;
    smartScore: number;
}

interface WhaleCache {
    [address: string]: {
        updatedAt: number; // timestamp
        periods: {
            '24h': WhalePeriodData;
            '7d': WhalePeriodData;
            '30d': WhalePeriodData;
            'all': WhalePeriodData;
        };
    };
}

// ===== 监控名单 =====
const WATCHED_FILE = path.resolve(process.cwd(), '..', 'watched_addresses.json');
let watchedAddresses = new Set<string>();

function loadWatchedAddresses(): void {
    try {
        if (fs.existsSync(WATCHED_FILE)) {
            const data = fs.readFileSync(WATCHED_FILE, 'utf-8');
            const list = JSON.parse(data);
            watchedAddresses = new Set(list.map((a: string) => a.toLowerCase()));
        }
    } catch (error) {
        console.error('[Watched] Failed to load watched addresses:', error);
    }
}

function saveWatchedAddresses(): void {
    try {
        fs.writeFileSync(WATCHED_FILE, JSON.stringify(Array.from(watchedAddresses), null, 2), 'utf-8');
    } catch (error) {
        console.error('[Watched] Failed to save watched addresses:', error);
    }
}

let whaleCacheData: WhaleCache = {};

// 读取缓存文件
function loadWhaleCache(): void {
    try {
        if (fs.existsSync(WHALE_CACHE_FILE)) {
            const data = fs.readFileSync(WHALE_CACHE_FILE, 'utf-8');
            whaleCacheData = JSON.parse(data);
            //console.log(`[WhaleCache] Loaded ${Object.keys(whaleCacheData).length} whales from cache`);
        }
    } catch (error) {
        console.error('[WhaleCache] Failed to load cache:', error);
        whaleCacheData = {};
    }
}

// 保存缓存文件
function saveWhaleCache(): void {
    try {
        fs.writeFileSync(WHALE_CACHE_FILE, JSON.stringify(whaleCacheData, null, 2), 'utf-8');
    } catch (error) {
        console.error('[WhaleCache] Failed to save cache:', error);
    }
}

// 检查缓存是否过期
function isCacheValid(address: string): boolean {
    const normalizedAddress = address.toLowerCase();
    const cache = whaleCacheData[normalizedAddress];
    if (!cache) return false;
    return Date.now() - cache.updatedAt < CACHE_TTL_MS;
}

// 获取缓存数据
function getCachedPeriodData(address: string, period: '24h' | '7d' | '30d' | 'all'): WhalePeriodData | null {
    const normalizedAddress = address.toLowerCase();
    if (!isCacheValid(normalizedAddress)) return null;
    return whaleCacheData[normalizedAddress]?.periods[period] || null;
}

// 更新队列
const updateQueue: { address: string; force: boolean }[] = [];
let isProcessingQueue = false;

// 记录正在更新中的地址，防止并发重复调用
const pendingUpdates = new Set<string>();

// 排队更新缓存
async function updateWhaleCache(address: string, force = false): Promise<void> {
    const normalizedAddress = address.toLowerCase();

    // 1. 并发锁校验 (防止同个地址重复入队)
    if (pendingUpdates.has(normalizedAddress)) return;

    // 2. 有效性校验 (除非强制更新)
    if (!force && isCacheValid(normalizedAddress)) return;

    pendingUpdates.add(normalizedAddress);
    updateQueue.push({ address: normalizedAddress, force });

    // 启动处理循环 (如果还未启动)
    if (!isProcessingQueue) {
        processUpdateQueue().catch(err => console.error('[WhaleCache] Queue process error:', err));
    }
}

async function processUpdateQueue(): Promise<void> {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    while (updateQueue.length > 0) {
        const item = updateQueue.shift()!;
        try {
            await performWhaleCacheUpdate(item.address, item.force);
            // 扫描任务之间增加 1.5 秒间隔，规避 429
            await new Promise(r => setTimeout(r, 1500));
        } catch (error) {
            console.error(`[WhaleCache] Item process failed for ${item.address}:`, error);
        } finally {
            pendingUpdates.delete(item.address);
        }
    }

    isProcessingQueue = false;
}

// 核心更新逻辑 - 执行真正的 API 请求和计算
async function performWhaleCacheUpdate(address: string, force = false): Promise<void> {
    const normalizedAddress = address.toLowerCase();

    console.log(`[WhaleCache] Scanning ${normalizedAddress}... (Queue size: ${updateQueue.length})`);
    if (!sdk) {
        sdk = new PolymarketSDK();
    }

    try {
        // 方案 B 优化：分别抓取成交记录和结算记录，提升时间跨度
        // 成交记录 (TRADE) 是计算量的核心，抓取 10,000 条
        const trades = await sdk.dataApi.getAllActivity(normalizedAddress, 10000, 'TRADE');
        // 结算记录 (REDEEM) 是计算盈利的核心，抓取 2,000 条
        const redemptions = await sdk.dataApi.getAllActivity(normalizedAddress, 2000, 'REDEEM');

        // 数据完整性核验：如果完全拿不到记录（且已知是鲸鱼），往往是接口超限或异常，此时不应由于空结果而清空缓存
        if (trades.length === 0 && redemptions.length === 0) {
            console.warn(`[WhaleCache] No data found for ${normalizedAddress}, skipping cache update to prevent pollution.`);
            return;
        }

        const allActivities = [...trades, ...redemptions].sort((a, b) => b.timestamp - a.timestamp);

        // 获取当前持仓（用于未实现盈亏）
        let positions: any[] = [];
        try {
            positions = await sdk.dataApi.getPositions(normalizedAddress);
        } catch {
            console.warn(`[WhaleCache] Failed to get positions for ${normalizedAddress}`);
        }

        const periods = ['24h', '7d', '30d', 'all'];
        const periodsData: any = {};

        // 对每个时间段进行聚合计算
        for (const period of periods) {
            const periodDays = period === '24h' ? 1 : period === '7d' ? 7 : period === '30d' ? 30 : 0;
            const sinceTs = periodDays > 0 ? Date.now() - (periodDays * 24 * 60 * 60 * 1000) : 0;

            const filteredTrades = trades.filter(t => t.timestamp >= sinceTs);
            const filteredRedemptions = redemptions.filter(r => r.timestamp >= sinceTs);

            // 严谨校验：如果数据量触顶且时间跨度不足，说明窗口不完整，置零 24h/7h/30h
            const earliestTs = trades.length > 0 ? trades[trades.length - 1].timestamp : Date.now();
            if (periodDays > 0 && trades.length >= 10000 && earliestTs > sinceTs) {
                periodsData[period] = {
                    pnl: 0,
                    volume: 0,
                    tradeCount: 0,
                    winRate: 0.5,
                    smartScore: 50,
                };
                continue;
            }

            // 计算该时间段的 PnL 和交易量
            const buyVolume = filteredTrades.filter(t => t.side === 'BUY').reduce((sum, t) => sum + (t.usdcSize || t.size * t.price), 0);
            const sellVolume = filteredTrades.filter(t => t.side === 'SELL').reduce((sum, t) => sum + (t.usdcSize || t.size * t.price), 0);
            const redemptionValue = filteredRedemptions.reduce((sum, r) => sum + (r.usdcSize || r.size), 0);

            const realizedPnl = sellVolume + redemptionValue - buyVolume;

            let unrealizedPnl = 0;
            if (period === 'all') {
                unrealizedPnl = positions.reduce((sum, p) => sum + (p.cashPnl || 0), 0);
            }

            const pnl = realizedPnl + unrealizedPnl;
            const volume = buyVolume + sellVolume;

            // 计算胜率
            const marketGroups = new Map<string, { buys: number; exits: number }>();
            for (const t of filteredTrades) {
                const existing = marketGroups.get(t.conditionId) || { buys: 0, exits: 0 };
                if (t.side === 'BUY') existing.buys += (t.usdcSize || t.size * t.price);
                else existing.exits += (t.usdcSize || t.size * t.price);
                marketGroups.set(t.conditionId, existing);
            }
            for (const r of filteredRedemptions) {
                const existing = marketGroups.get(r.conditionId) || { buys: 0, exits: 0 };
                existing.exits += (r.usdcSize || r.size);
                marketGroups.set(r.conditionId, existing);
            }

            let winCount = 0;
            let endedMarkets = 0;
            for (const [_, stats] of marketGroups) {
                if (stats.exits > 0 && stats.buys > 0) {
                    endedMarkets++;
                    if (stats.exits > stats.buys) {
                        winCount++;
                    }
                }
            }

            const winRate = endedMarkets > 0 ? winCount / endedMarkets : 0.5;

            // 计算评分
            const roi = volume > 0 ? (pnl / volume) * 100 : 0;
            const activityScore = Math.min(20, filteredTrades.length / 10);
            const roiScore = Math.min(30, Math.max(-30, roi * 3));
            const smartScore = Math.round(Math.max(0, Math.min(100, 50 + roiScore + activityScore)));

            periodsData[period] = {
                pnl,
                volume,
                tradeCount: filteredTrades.length,
                winRate: Math.max(0, Math.min(1, winRate)),
                smartScore,
            };
        }

        whaleCacheData[normalizedAddress] = {
            updatedAt: Date.now(),
            periods: periodsData,
        };

        saveWhaleCache();

    } catch (error) {
        console.error(`[WhaleCache] Critial scan error for ${normalizedAddress}:`, error);
        // 重要：扫描失败时，绝对不能写全零占位，应当保留旧数据或等待下次更新
    }
}

// 启动时加载缓存
loadWhaleCache();
loadWatchedAddresses();

// ===== Routes =====

export async function whaleDiscoveryRoutes(fastify: FastifyInstance): Promise<void> {

    // POST /api/whale/start - 启动服务
    fastify.post('/start', {
        schema: {
            tags: ['鲸鱼发现'],
            summary: '启动鲸鱼发现服务',
            body: {
                type: 'object',
                properties: {
                    infuraApiKey: { type: 'string', description: 'Infura API Key' },
                    minTradeUsdcValue: { type: 'number', description: '最小交易金额' },
                    minWinRate: { type: 'number', description: '最低胜率' },
                    minPnl: { type: 'number', description: '最低盈利' },
                    minVolume: { type: 'number', description: '最低交易量' },
                },
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        status: { type: 'string' },
                        startedAt: { type: 'string' },
                    },
                },
            },
        },
    }, async (request: FastifyRequest<{ Body: Partial<WhaleDiscoveryConfig> }>, reply: FastifyReply) => {
        if (whaleService?.getStatus().running) {
            return reply.code(400).send({ error: 'Service already running' });
        }

        const infuraApiKey = request.body.infuraApiKey || process.env.INFURA_API_KEY;
        if (!infuraApiKey) {
            return reply.code(400).send({ error: 'Infura API key required' });
        }

        // 从配置文件读取保存的配置
        const fileConfig = readConfigFile();
        const savedConfig = fileConfig.whaleDiscovery || {};

        // 创建服务 - 优先使用配置文件的值
        whaleService = new WhaleDiscoveryService({
            infuraApiKey,
            minTradeUsdcValue: request.body.minTradeUsdcValue ?? savedConfig.minTradeUsdcValue ?? 100,
            minWinRate: request.body.minWinRate ?? savedConfig.minWinRate ?? 0.55,
            minPnl: request.body.minPnl ?? savedConfig.minPnl ?? 1000,
            minVolume: request.body.minVolume ?? savedConfig.minVolume ?? 5000,
            minTradesObserved: request.body.minTradesObserved ?? savedConfig.minTradesObserved ?? 1,
            analysisIntervalSec: request.body.analysisIntervalSec ?? savedConfig.analysisIntervalSec ?? 10,
            maxAnalysisPerBatch: 10,
        });

        // 设置钱包分析函数 - 快速分析，不做缓存
        sdk = new PolymarketSDK();
        whaleService.setWalletAnalyzer(async (address: string) => {
            try {
                // 快速获取基础 profile 用于筛选（不拉取交易历史）
                const profile = await sdk!.wallets.getWalletProfile(address);
                if (!profile) return null;

                return {
                    pnl: profile.realizedPnL || 0,
                    // 修正胜率启发式算法：基于 PnL 和交易量估算，避免离谱的 100%
                    winRate: profile.realizedPnL > 0 ?
                        Math.min(0.85, 0.5 + (profile.avgPercentPnL / 200)) :
                        Math.max(0.1, 0.5 + (profile.avgPercentPnL / 200)),
                    totalVolume: Math.abs(profile.totalPnL) * 10,
                    smartScore: profile.smartScore || 0,
                    totalTrades: profile.tradeCount || 0,
                };
            } catch {
                return null;
            }
        });

        // 设置鲸鱼确认回调 - 只有确认是鲸鱼后才预热缓存
        whaleService.setWhaleConfirmedCallback(async (address: string) => {
            const normalizedAddr = address.toLowerCase();
            if (!isCacheValid(normalizedAddr)) {
                //console.log(`[WhaleCache] Whale confirmed, pre-caching ${normalizedAddr}...`);
                await updateWhaleCache(normalizedAddr);
            }
        });

        // 注意：Polymarket 是 SPA，profile 页面不返回服务器重定向
        // 无法通过 HTTP 请求获取用户名，用户名显示为地址缩写
        // 用户可以点击链接跳转到 Polymarket 查看完整用户名

        await whaleService.start();

        return {
            status: 'started',
            startedAt: whaleService.getStatus().startedAt?.toISOString(),
        };
    });

    // POST /api/whale/stop - 停止服务
    fastify.post('/stop', {
        schema: {
            tags: ['鲸鱼发现'],
            summary: '停止鲸鱼发现服务',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        status: { type: 'string' },
                        runtime: { type: 'string' },
                    },
                },
            },
        },
    }, async (_request: FastifyRequest, reply: FastifyReply) => {
        if (!whaleService?.getStatus().running) {
            return reply.code(400).send({ error: 'Service not running' });
        }

        const stats = whaleService.getStatus();
        whaleService.stop();
        whaleService = null;
        sdk = null;

        return {
            status: 'stopped',
            runtime: stats.runtime,
        };
    });

    // GET /api/whale/status - 服务状态
    fastify.get('/status', {
        schema: {
            tags: ['鲸鱼发现'],
            summary: '获取服务状态',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        running: { type: 'boolean' },
                        mode: { type: 'string' },
                        startedAt: { type: 'string', nullable: true },
                        runtime: { type: 'string' },
                        tradesObserved: { type: 'number' },
                        addressesAnalyzed: { type: 'number' },
                        whalesDiscovered: { type: 'number' },
                        queueSize: { type: 'number' },
                    },
                },
            },
        },
    }, async () => {
        if (!whaleService) {
            return {
                running: false,
                mode: 'disconnected',
                startedAt: null,
                runtime: '0s',
                tradesObserved: 0,
                addressesAnalyzed: 0,
                whalesDiscovered: 0,
                queueSize: 0,
            };
        }

        const status = whaleService.getStatus();
        return {
            ...status,
            startedAt: status.startedAt?.toISOString() || null,
        };
    });

    // GET /api/whale/whales - 鲸鱼列表
    fastify.get('/whales', {
        schema: {
            tags: ['鲸鱼发现'],
            summary: '获取发现的鲸鱼列表',
            querystring: {
                type: 'object',
                properties: {
                    sort: { type: 'string', enum: ['pnl', 'volume', 'winRate'], default: 'pnl' },
                    limit: { type: 'number', default: 50 },
                },
            },
            response: {
                200: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            address: { type: 'string' },
                            discoveredAt: { type: 'string' },
                            tradesObserved: { type: 'number' },
                            volumeObserved: { type: 'number' },
                            profile: {
                                type: 'object',
                                nullable: true,
                                properties: {
                                    pnl: { type: 'number' },
                                    winRate: { type: 'number' },
                                    totalVolume: { type: 'number' },
                                    smartScore: { type: 'number' },
                                    totalTrades: { type: 'number' },
                                },
                            },
                        },
                    },
                },
            },
        },
    }, async (request: FastifyRequest<{ Querystring: { sort?: string; limit?: number } }>) => {
        if (!whaleService) {
            return [];
        }

        const sort = (request.query.sort || 'pnl') as 'pnl' | 'volume' | 'winRate';
        const limit = request.query.limit || 50;

        const whales = whaleService.getWhales(sort, limit);

        return whales.map((w) => ({
            ...w,
            discoveredAt: w.discoveredAt.toISOString(),
        }));
    });

    // POST /api/whale/cache/refresh - 刷新所有鲸鱼缓存
    fastify.post('/cache/refresh', {
        schema: {
            tags: ['鲸鱼发现'],
            summary: '刷新所有鲸鱼数据缓存',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        status: { type: 'string' },
                        count: { type: 'number' },
                        message: { type: 'string' },
                    },
                },
            },
        },
    }, async () => {
        if (!whaleService) {
            return { status: 'error', count: 0, message: 'Service not running' };
        }

        const whales = whaleService.getWhales('pnl', 100);
        let updated = 0;

        // 顺序更新每个鲸鱼的缓存
        for (const whale of whales) {
            try {
                await updateWhaleCache(whale.address, true);
                updated++;
            } catch (error) {
                console.error(`[WhaleCache] Failed to update ${whale.address}:`, error);
            }
        }

        return { status: 'success', count: updated, message: `Updated ${updated}/${whales.length} whales` };
    });

    // GET /api/whale/cache/status - 获取缓存状态
    fastify.get('/cache/status', {
        schema: {
            tags: ['鲸鱼发现'],
            summary: '获取缓存状态',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        cachedCount: { type: 'number' },
                        validCount: { type: 'number' },
                        expiredCount: { type: 'number' },
                    },
                },
            },
        },
    }, async () => {
        const addresses = Object.keys(whaleCacheData);
        let validCount = 0;
        let expiredCount = 0;

        for (const addr of addresses) {
            if (isCacheValid(addr)) {
                validCount++;
            } else {
                expiredCount++;
            }
        }

        return {
            cachedCount: addresses.length,
            validCount,
            expiredCount,
        };
    });

    // GET /api/whale/cache/bulk - 批量获取所有鲸鱼的缓存数据
    fastify.get('/cache/bulk', {
        schema: {
            tags: ['鲸鱼发现'],
            summary: '批量获取缓存数据',
            querystring: {
                type: 'object',
                properties: {
                    addresses: { type: 'string', description: '逗号分隔的地址列表' },
                },
            },
        },
    }, async (request: FastifyRequest<{ Querystring: { addresses?: string } }>) => {
        const addressList = request.query.addresses?.split(',').filter(a => a) || [];

        const result: Record<string, {
            cached: boolean;
            periods?: typeof whaleCacheData[string]['periods'];
        }> = {};

        for (const addr of addressList) {
            const normalizedAddr = addr.toLowerCase();
            const cached = whaleCacheData[normalizedAddr];
            if (cached && isCacheValid(normalizedAddr)) {
                result[addr] = { cached: true, periods: cached.periods };
            } else {
                result[addr] = { cached: false };
            }
        }

        return result;
    });


    // GET /api/whale/trades - 最近交易
    fastify.get('/trades', {
        schema: {
            tags: ['鲸鱼发现'],
            summary: '获取最近交易',
            querystring: {
                type: 'object',
                properties: {
                    limit: { type: 'number', default: 100 },
                },
            },
            response: {
                200: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            txHash: { type: 'string' },
                            from: { type: 'string' },
                            to: { type: 'string' },
                            tokenId: { type: 'string' },
                            amount: { type: 'string' },
                            blockNumber: { type: 'number' },
                            timestamp: { type: 'number' },
                        },
                    },
                },
            },
        },
    }, async (request: FastifyRequest<{ Querystring: { limit?: number } }>) => {
        if (!whaleService) {
            return [];
        }

        return whaleService.getRecentTrades(request.query.limit || 100);
    });

    // GET /api/whale/config - 获取配置（优先从文件读取）
    fastify.get('/config', {
        schema: {
            tags: ['鲸鱼发现'],
            summary: '获取当前配置',
        },
    }, async () => {
        // 从配置文件读取
        const fileConfig = readConfigFile();
        const whaleConfig = fileConfig.whaleDiscovery || {};

        // 如果服务在运行，用运行时配置覆盖
        if (whaleService) {
            const runtimeConfig = whaleService.getConfig();
            return {
                minTradeUsdcValue: runtimeConfig.minTradeUsdcValue,
                minWinRate: runtimeConfig.minWinRate,
                minPnl: runtimeConfig.minPnl,
                minVolume: runtimeConfig.minVolume,
                minTradesObserved: runtimeConfig.minTradesObserved,
                maxAnalysisPerBatch: runtimeConfig.maxAnalysisPerBatch,
                analysisIntervalSec: runtimeConfig.analysisIntervalSec,
            };
        }

        // 服务未运行，从文件返回
        return {
            minTradeUsdcValue: whaleConfig.minTradeUsdcValue ?? 100,
            minWinRate: whaleConfig.minWinRate ?? 0.55,
            minPnl: whaleConfig.minPnl ?? 1000,
            minVolume: whaleConfig.minVolume ?? 5000,
            minTradesObserved: whaleConfig.minTradesObserved ?? 1,
            analysisIntervalSec: whaleConfig.analysisIntervalSec ?? 10,
        };
    });

    // PUT /api/whale/config - 更新配置（同时保存到文件）
    fastify.put('/config', {
        schema: {
            tags: ['鲸鱼发现'],
            summary: '更新配置',
            body: {
                type: 'object',
                properties: {
                    minTradeUsdcValue: { type: 'number' },
                    minWinRate: { type: 'number' },
                    minPnl: { type: 'number' },
                    minVolume: { type: 'number' },
                    minTradesObserved: { type: 'number' },
                    maxAnalysisPerBatch: { type: 'number' },
                    analysisIntervalSec: { type: 'number' },
                },
            },
        },
    }, async (request: FastifyRequest<{ Body: Partial<WhaleDiscoveryConfig> }>) => {
        const updates = request.body;

        // 保存到配置文件
        const fileConfig = readConfigFile();
        fileConfig.whaleDiscovery = {
            ...(fileConfig.whaleDiscovery || {}),
            ...updates,
        };
        saveConfigFile(fileConfig);

        // 如果服务在运行，同时更新运行时配置
        if (whaleService) {
            whaleService.updateConfig(updates);
            return whaleService.getConfig();
        }

        return fileConfig.whaleDiscovery;
    });

    // 获取鲸鱼交易统计（使用 Data API /trades）
    async function getWhaleTradeStats(address: string, periodDays: number): Promise<{
        pnl: number;
        volume: number;
        tradeCount: number;
        buyVolume: number;
        sellVolume: number;
    }> {
        const DATA_API = 'https://data-api.polymarket.com';
        const normalizedAddress = address.toLowerCase();

        // 计算时间范围
        const now = Date.now();
        const sinceTimestamp = periodDays > 0 ? now - periodDays * 24 * 60 * 60 * 1000 : 0;

        try {
            // 获取全局交易（限制 5000 条以覆盖更长时间范围）
            const response = await fetch(`${DATA_API}/trades?limit=5000`);
            if (!response.ok) {
                throw new Error(`Data API error: ${response.status}`);
            }

            const allTrades = await response.json() as Array<{
                proxyWallet: string;
                side: string;
                size: number;
                price: number;
                timestamp: number;
            }>;

            // 过滤该地址的交易
            const whaleTrades = allTrades.filter(t =>
                t.proxyWallet?.toLowerCase() === normalizedAddress &&
                t.timestamp >= sinceTimestamp
            );

            // 计算统计
            let buyVolume = 0;
            let sellVolume = 0;

            for (const trade of whaleTrades) {
                const value = trade.size * trade.price;
                if (trade.side === 'BUY') {
                    buyVolume += value;
                } else {
                    sellVolume += value;
                }
            }

            return {
                pnl: sellVolume - buyVolume, // 简化 PnL = 卖出 - 买入
                volume: buyVolume + sellVolume,
                tradeCount: whaleTrades.length,
                buyVolume,
                sellVolume,
            };
        } catch (error) {
            console.error(`[WhaleStats] Error fetching trades for ${address}:`, error);
            return { pnl: 0, volume: 0, tradeCount: 0, buyVolume: 0, sellVolume: 0 };
        }
    }

    // GET /api/whale/profile/:address - 获取钱包时间段统计
    fastify.get('/profile/:address', {
        schema: {
            tags: ['鲸鱼发现'],
            summary: '获取钱包时间段统计',
            params: {
                type: 'object',
                properties: {
                    address: { type: 'string' },
                },
                required: ['address'],
            },
            querystring: {
                type: 'object',
                properties: {
                    period: { type: 'string', enum: ['24h', '7d', '30d', 'all'], default: 'all' },
                },
            },
        },
    }, async (request: FastifyRequest<{ Params: { address: string }; Querystring: { period?: string } }>) => {
        const { address } = request.params;
        const period = (request.query.period || 'all') as '24h' | '7d' | '30d' | 'all';

        // 1. 尝试从缓存读取
        const cached = getCachedPeriodData(address, period);
        if (cached) {
            return {
                address,
                period,
                pnl: cached.pnl,
                volume: cached.volume,
                tradeCount: cached.tradeCount,
                winRate: cached.winRate,
                smartScore: cached.smartScore,
                fromCache: true,
            };
        }

        // 2. 缓存不存在或过期，实时请求并更新缓存
        if (!sdk) {
            sdk = new PolymarketSDK();
        }

        const periodDays = period === '24h' ? 1 : period === '7d' ? 7 : period === '30d' ? 30 : 0;

        try {
            const stats = await sdk.wallets.getWalletProfileForPeriod(address, periodDays);

            // 更新缓存（异步，不阻塞响应）
            updateWhaleCache(address).catch(err => console.error('[WhaleCache] Async update failed:', err));

            return {
                address,
                period,
                pnl: stats.pnl,
                volume: stats.volume,
                tradeCount: stats.tradeCount,
                winRate: stats.winRate,
                smartScore: stats.smartScore,
                fromCache: false,
            };
        } catch (error) {
            console.error(`[WhaleProfile] Error fetching profile for ${address}:`, error);
            return {
                address,
                period,
                pnl: 0,
                volume: 0,
                tradeCount: 0,
                winRate: 0.5,
                smartScore: 50,
                error: 'Data unavailable',
            };
        }
    });

    // GET /api/whale/watched - 获取监控名单
    fastify.get('/watched', {
        schema: {
            tags: ['鲸鱼发现'],
            summary: '获取监控名单',
        },
    }, async () => {
        return Array.from(watchedAddresses);
    });

    // POST /api/whale/watch - 切换监控状态
    fastify.post('/watch', {
        schema: {
            tags: ['鲸鱼发现'],
            summary: '切换地址监控状态',
            body: {
                type: 'object',
                required: ['address', 'watched'],
                properties: {
                    address: { type: 'string' },
                    watched: { type: 'boolean' },
                },
            },
        },
    }, async (request: FastifyRequest<{ Body: { address: string; watched: boolean } }>) => {
        const { address, watched } = request.body;
        const normalized = address.toLowerCase();

        if (watched) {
            watchedAddresses.add(normalized);
        } else {
            watchedAddresses.delete(normalized);
        }

        saveWatchedAddresses();
        return { status: 'success', address: normalized, watched };
    });
}

