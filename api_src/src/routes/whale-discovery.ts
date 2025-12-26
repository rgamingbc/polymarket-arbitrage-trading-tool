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

let whaleCacheData: WhaleCache = {};

// 读取缓存文件
function loadWhaleCache(): void {
    try {
        if (fs.existsSync(WHALE_CACHE_FILE)) {
            const data = fs.readFileSync(WHALE_CACHE_FILE, 'utf-8');
            whaleCacheData = JSON.parse(data);
            console.log(`[WhaleCache] Loaded ${Object.keys(whaleCacheData).length} whales from cache`);
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

// 更新缓存数据
// 更新缓存数据 - 只调用一次 API，本地聚合所有时间段
async function updateWhaleCache(address: string): Promise<void> {
    if (!sdk) {
        sdk = new PolymarketSDK();
    }

    try {
        // 只调用一次 Data API，获取所有活动记录
        const allActivities = await sdk.dataApi.getAllActivity(address, 10000);

        console.log(`[WhaleCache] Fetched ${allActivities.length} activities for ${address}`);

        // 获取当前持仓（用于未实现盈亏）
        let positions: any[] = [];
        try {
            positions = await sdk.dataApi.getPositions(address);
        } catch {
            console.warn(`[WhaleCache] Failed to get positions for ${address}`);
        }

        const now = Date.now();
        const periodConfigs = [
            { period: '24h' as const, days: 1 },
            { period: '7d' as const, days: 7 },
            { period: '30d' as const, days: 30 },
            { period: 'all' as const, days: 0 },
        ];

        const periodsData: any = {};

        // 对每个时间段进行聚合计算
        for (const { period, days } of periodConfigs) {
            const sinceTimestamp = days > 0 ? now - days * 24 * 60 * 60 * 1000 : 0;
            const filtered = allActivities.filter((a: any) => a.timestamp >= sinceTimestamp);

            // 分类
            const trades = filtered.filter((a: any) => a.type === 'TRADE');
            const redemptions = filtered.filter((a: any) => a.type === 'REDEEM');
            const buys = trades.filter((a: any) => a.side === 'BUY');
            const sells = trades.filter((a: any) => a.side === 'SELL');

            // 计算交易量
            const buyVolume = buys.reduce((sum: number, t: any) => sum + (t.usdcSize || t.size * t.price), 0);
            const sellVolume = sells.reduce((sum: number, t: any) => sum + (t.usdcSize || t.size * t.price), 0);
            const volume = buyVolume + sellVolume;

            // 计算 PnL
            const redemptionValue = redemptions.reduce((sum: number, r: any) => sum + (r.size || 0), 0);
            const realizedPnl = sellVolume + redemptionValue - buyVolume;
            const unrealizedPnl = positions.reduce((sum: number, p: any) => sum + (p.cashPnl || 0), 0);
            const pnl = realizedPnl + unrealizedPnl;

            // 计算胜率
            let winCount = 0;
            for (const sell of sells) {
                if (sell.price > 0.5) winCount++;
            }
            winCount += redemptions.filter((r: any) => (r.size || 0) > 0).length;
            const totalClosed = sells.length + redemptions.length;
            const winRate = totalClosed > 0 ? winCount / totalClosed : 0.5;

            // 计算评分
            const roi = volume > 0 ? (pnl / volume) * 100 : 0;
            const activityScore = Math.min(20, trades.length / 10);
            const roiScore = Math.min(30, Math.max(-30, roi * 3));
            const smartScore = Math.round(Math.max(0, Math.min(100, 50 + roiScore + activityScore)));

            periodsData[period] = {
                pnl,
                volume,
                tradeCount: trades.length,
                winRate: Math.max(0, Math.min(1, winRate)),
                smartScore,
            };
        }

        whaleCacheData[address] = {
            updatedAt: Date.now(),
            periods: periodsData,
        };

        saveWhaleCache();
        console.log(`[WhaleCache] Updated cache for ${address} (all periods calculated from single API call)`);

    } catch (error) {
        console.error(`[WhaleCache] Failed to update cache for ${address}:`, error);
        // 设置默认值
        const defaultData = { pnl: 0, volume: 0, tradeCount: 0, winRate: 0.5, smartScore: 50 };
        whaleCacheData[address] = {
            updatedAt: Date.now(),
            periods: {
                '24h': { ...defaultData },
                '7d': { ...defaultData },
                '30d': { ...defaultData },
                'all': { ...defaultData },
            },
        };
        saveWhaleCache();
    }
}

// 启动时加载缓存
loadWhaleCache();

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
                    winRate: profile.avgPercentPnL > 0 ? Math.min(0.8, 0.5 + profile.avgPercentPnL / 200) : 0.4,
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
            if (!isCacheValid(address)) {
                console.log(`[WhaleCache] Whale confirmed, pre-caching ${address}...`);
                await updateWhaleCache(address);
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

        // 自动预热缓存：检查哪些地址没有缓存，后台异步更新
        const uncachedAddresses = whales.filter(w => !isCacheValid(w.address)).map(w => w.address);
        if (uncachedAddresses.length > 0) {
            console.log(`[WhaleCache] Auto-caching ${uncachedAddresses.length} uncached whales...`);
            // 后台异步更新，不阻塞响应
            (async () => {
                for (const addr of uncachedAddresses) {
                    try {
                        await updateWhaleCache(addr);
                    } catch (err) {
                        console.error(`[WhaleCache] Failed to auto-cache ${addr}:`, err);
                    }
                }
                console.log(`[WhaleCache] Auto-cache completed for ${uncachedAddresses.length} whales`);
            })();
        }

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
                await updateWhaleCache(whale.address);
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
}

