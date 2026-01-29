/**
 * 套利 API 路由 - Background Scanning Version
 */

import { FastifyPluginAsync } from 'fastify';
import { PolymarketSDK, checkArbitrage, ArbitrageService, ArbitrageMarketConfig, ArbitrageOpportunity, PolymarketError, ErrorCode, withRetry, RateLimiter, ApiType } from '../../../dist/index.js';
import { config } from '../config.js';

// 自定义速率限制器
const rateLimiter = new RateLimiter({
  [ApiType.DATA]: { maxConcurrent: 5, minTime: 200 },
  [ApiType.GAMMA]: { maxConcurrent: 5, minTime: 200 },
  [ApiType.CLOB]: { maxConcurrent: 2, minTime: 500 },
});

const sdk = new PolymarketSDK({
    rateLimiter: rateLimiter,
} as any);

const arbService = new ArbitrageService({
    privateKey: config.polymarket.privateKey,
    rpcUrl: 'https://polygon-rpc.com',
    profitThreshold: config.arbitrage.profitThreshold,
    autoExecute: false,
    enableLogging: true,
});

// ===== Global Cache & State =====
const CACHE = {
    opportunities: new Map<string, any>(),
    scanning: false,
    progress: { total: 0, current: 0 },
    lastFullScan: null as string | null,
    scanErrors: 0,
};

// Background Scanner Loop
async function startBackgroundScanner() {
    if (CACHE.scanning) return;
    CACHE.scanning = true;
    console.log('🚀 Starting Background Arbitrage Scanner...');

    while (true) {
        try {
            // 1. Fetch Markets (Top 500 by volume/activity)
            const markets = await withRetry(() => sdk.gammaApi.getMarkets({
                closed: false,
                active: true,
                limit: 500, // Scan deep!
            }), { maxRetries: 3 });

            CACHE.progress.total = markets.length;
            CACHE.progress.current = 0;
            
            // Temporary map for this run to detect stale opps
            const foundInThisRun = new Set<string>();

            // 2. Process in chunks to respect rate limits
            const chunkSize = 5;
            for (let i = 0; i < markets.length; i += chunkSize) {
                const batch = markets.slice(i, i + chunkSize);
                
                await Promise.all(batch.map(async (market) => {
                    try {
                        // Skip if volume too low (basic filter)
                        if ((market.volume24hr || 0) < 100) return;

                        const orderbook = await withRetry(() => sdk.clobApi.getProcessedOrderbook(market.conditionId), {
                            maxRetries: 2,
                            shouldRetry: (err: any) => err?.code === ErrorCode.RATE_LIMITED
                        });

                        const arb = checkArbitrage(
                            orderbook.yes.ask,
                            orderbook.no.ask,
                            orderbook.yes.bid,
                            orderbook.no.bid
                        );

                        // If profitable (even small profit, let frontend filter)
                        if (arb && arb.profit > 0) {
                            let clobMarket;
                            try {
                                clobMarket = await sdk.clobApi.getMarket(market.conditionId);
                            } catch { return; }

                            const yesToken = clobMarket.tokens.find((t: any) => t.outcome === 'Yes');
                            const noToken = clobMarket.tokens.find((t: any) => t.outcome === 'No');

                            if (yesToken && noToken) {
                                const opp = {
                                    market: {
                                        conditionId: market.conditionId,
                                        question: market.question,
                                        slug: market.slug,
                                        volume24hr: market.volume24hr,
                                        yesTokenId: yesToken.tokenId,
                                        noTokenId: noToken.tokenId,
                                    },
                                    arbType: arb.type,
                                    profit: arb.profit,
                                    profitPercent: arb.profit * 100,
                                    description: arb.description,
                                    orderbook: {
                                        yesAsk: orderbook.yes.ask,
                                        yesBid: orderbook.yes.bid,
                                        noAsk: orderbook.no.ask,
                                        noBid: orderbook.no.bid,
                                    },
                                    recommendedSize: 10,
                                    detectedAt: new Date().toISOString()
                                };
                                CACHE.opportunities.set(market.conditionId, opp);
                                foundInThisRun.add(market.conditionId);
                            }
                        }
                    } catch (e) {
                        // Ignore individual errors
                    }
                }));

                CACHE.progress.current += batch.length;
                // Rate limit sleep: 5 reqs / 2 req/s = 2.5s safe buffer
                await new Promise(r => setTimeout(r, 2000));
            }

            // Cleanup stale opportunities
            for (const [id] of CACHE.opportunities) {
                if (!foundInThisRun.has(id)) {
                    CACHE.opportunities.delete(id);
                }
            }

            CACHE.lastFullScan = new Date().toISOString();
            console.log(`✅ Scan Complete. Found ${CACHE.opportunities.size} opportunities.`);

        } catch (error) {
            console.error('Background Scan Error:', error);
            CACHE.scanErrors++;
        }

        // Wait before next full scan (30 seconds)
        await new Promise(r => setTimeout(r, 30000));
    }
}

export const arbitrageRoutes: FastifyPluginAsync = async (fastify) => {
    // Start the background scanner once
    startBackgroundScanner();

    // GET /scan - Return cached results immediately
    fastify.get('/scan', {
        schema: {
            tags: ['套利'],
            summary: '获取套利机会缓存',
            querystring: {
                type: 'object',
                properties: {
                    minVolume: { type: 'number', default: 1000 },
                    limit: { type: 'number', default: 100 },
                    minProfit: { type: 'number', default: 0.003 },
                },
            },
        },
        handler: async (request, reply) => {
            const { minVolume = 1000, limit = 100, minProfit = 0.003 } = request.query as any;

            // Filter from Cache
            let results = Array.from(CACHE.opportunities.values());

            results = results.filter(o => 
                o.market.volume24hr >= minVolume && 
                o.profit >= minProfit
            );

            // Sort by profit
            results.sort((a, b) => b.profit - a.profit);

            // Limit
            results = results.slice(0, limit);

            return {
                count: results.length,
                opportunities: results,
                scannedAt: CACHE.lastFullScan || new Date().toISOString(),
                status: {
                    scanning: CACHE.scanning,
                    progress: CACHE.progress,
                    totalCached: CACHE.opportunities.size
                }
            };
        },
    });

    // Execute Arbitrage
    fastify.post('/execute', {
        schema: {
            tags: ['套利'],
            summary: '执行套利',
            body: {
                type: 'object',
                properties: {
                    market: { type: 'object' },
                    opportunity: { type: 'object' },
                    size: { type: 'number' },
                },
                required: ['market', 'opportunity'],
            },
        },
        handler: async (request, reply) => {
            const { market, opportunity, size } = request.body as any;

            if (!config.polymarket.privateKey) {
                return reply.status(400).send({ error: 'Private key not configured' });
            }

            console.log(`🚀 Executing ${opportunity.arbType} arb on ${market.question}...`);

            const arbMarket: ArbitrageMarketConfig = {
                name: market.question,
                conditionId: market.conditionId,
                yesTokenId: market.yesTokenId,
                noTokenId: market.noTokenId,
                outcomes: ['Yes', 'No'],
            };

            try {
                await arbService.stop();
            } catch {}

            await arbService.start(arbMarket);

            const arbOpp: ArbitrageOpportunity = {
                type: opportunity.arbType,
                profitRate: opportunity.profit,
                profitPercent: opportunity.profitPercent,
                effectivePrices: {
                    buyYes: opportunity.orderbook.yesAsk,
                    buyNo: opportunity.orderbook.noAsk,
                    sellYes: opportunity.orderbook.yesBid,
                    sellNo: opportunity.orderbook.noBid,
                },
                maxOrderbookSize: 1000,
                maxBalanceSize: 1000,
                recommendedSize: size || 5,
                estimatedProfit: (size || 5) * opportunity.profit,
                description: opportunity.description,
                timestamp: Date.now(),
            };

            try {
                const result = await arbService.execute(arbOpp);
                await arbService.stop();
                return result;
            } catch (error: any) {
                await arbService.stop();
                return reply.status(500).send({ error: error.message });
            }
        },
    });

    // ... existing individual check route ...
    fastify.get('/:conditionId', {
        schema: {
            tags: ['套利'],
            summary: '检测特定市场套利',
            params: {
                type: 'object',
                properties: {
                    conditionId: { type: 'string' },
                },
                required: ['conditionId'],
            },
        },
        handler: async (request, reply) => {
            const { conditionId } = request.params as { conditionId: string };
            const arb = await sdk.detectArbitrage(conditionId);

            if (arb) {
                return {
                    hasOpportunity: true,
                    type: arb.type,
                    profit: arb.profit,
                    profitPercent: arb.profit * 100,
                    action: arb.action,
                };
            }

            return {
                hasOpportunity: false,
                message: '无套利机会',
            };
        },
    });
};
