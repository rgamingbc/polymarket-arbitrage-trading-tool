import { FastifyPluginAsync } from 'fastify';
import { GroupArbitrageScanner } from '../services/group-arbitrage.js';
import { config } from '../config.js';

export const groupArbRoutes: FastifyPluginAsync = async (fastify) => {
    const scanner = new GroupArbitrageScanner(config.polymarket.privateKey);
    scanner.start();

    fastify.get('/scan', {
        schema: {
            tags: ['Group Arb'],
            summary: 'Get Latest Background Scan Results',
        },
        handler: async (request, reply) => {
            try {
                const result = scanner.getResults();
                return {
                    success: true,
                    count: result.count,
                    opportunities: result.opportunities,
                    logs: result.logs
                };
            } catch (err: any) {
                return reply.status(500).send({ error: err.message });
            }
        }
    });

    fastify.post('/preview', {
        schema: {
            tags: ['Group Arb'],
            summary: 'Preview Group Arbitrage Orders (No Trading)',
            body: {
                type: 'object',
                properties: {
                    marketId: { type: 'string' },
                    amount: { type: 'number' }
                },
                required: ['marketId', 'amount']
            }
        },
        handler: async (request, reply) => {
            const { marketId, amount } = request.body as any;
            try {
                const amountUSDC = amount || 10;
                const result = await scanner.preview(marketId, amountUSDC);
                return { success: true, preview: result };
            } catch (err: any) {
                return reply.status(500).send({ error: err.message });
            }
        }
    });

    fastify.get('/resolve', {
        schema: {
            tags: ['Group Arb'],
            summary: 'Resolve Market Identifier (URL/Slug/ConditionId)',
            querystring: {
                type: 'object',
                properties: {
                    identifier: { type: 'string' }
                },
                required: ['identifier']
            }
        },
        handler: async (request, reply) => {
            const { identifier } = request.query as any;
            try {
                const resolved = await scanner.resolveIdentifier(identifier);
                return { success: true, resolved };
            } catch (err: any) {
                return reply.status(500).send({ error: err.message });
            }
        }
    });

    fastify.get('/orderbook', {
        schema: {
            tags: ['Group Arb'],
            summary: 'Get YES/NO Orderbook Ladder',
            querystring: {
                type: 'object',
                properties: {
                    identifier: { type: 'string' },
                    depth: { type: 'number' }
                },
                required: ['identifier']
            }
        },
        handler: async (request, reply) => {
            const { identifier, depth } = request.query as any;
            try {
                const ladder = await scanner.getOrderbookLadder(identifier, depth ? Number(depth) : 5);
                return { success: true, ladder };
            } catch (err: any) {
                return reply.status(500).send({ error: err.message });
            }
        }
    });

    fastify.post('/execute-manual', {
        schema: {
            tags: ['Group Arb'],
            summary: 'Execute Manual Buy-All (Fixed Size)',
            body: {
                type: 'object',
                properties: {
                    identifier: { type: 'string' },
                    yesPrice: { type: 'number' },
                    noPrice: { type: 'number' },
                    size: { type: 'number' },
                    orderType: { type: 'string' }
                },
                required: ['identifier', 'yesPrice', 'noPrice', 'size']
            }
        },
        handler: async (request, reply) => {
            const { identifier, yesPrice, noPrice, size, orderType } = request.body as any;
            try {
                const result = await scanner.executeManual({
                    identifier,
                    yesPrice: Number(yesPrice),
                    noPrice: Number(noPrice),
                    size: Number(size),
                    orderType
                });
                return result;
            } catch (err: any) {
                return reply.status(500).send({ error: err.message });
            }
        }
    });

    fastify.post('/execute-shares', {
        schema: {
            tags: ['Group Arb'],
            summary: 'Execute Group Arbitrage (Shares Input)',
            body: {
                type: 'object',
                properties: {
                    marketId: { type: 'string' },
                    shares: { type: 'number' },
                    targetProfitPercent: { type: 'number' },
                    cutLossPercent: { type: 'number' },
                    trailingStopPercent: { type: 'number' },
                    oneLegTimeoutMinutes: { type: 'number' },
                    wideSpreadCents: { type: 'number' },
                    forceMarketExitFromPeakPercent: { type: 'number' }
                },
                required: ['marketId', 'shares']
            }
        },
        handler: async (request, reply) => {
            const { marketId, shares, slug, question, ...settings } = request.body as any;
            try {
                const result = await scanner.executeByShares(
                    String(marketId),
                    Number(shares),
                    { ...settings, slug, question }
                );
                return result;
            } catch (err: any) {
                return reply.status(500).send({ error: err.message });
            }
        }
    });

    fastify.post('/execute', {
        schema: {
            tags: ['Group Arb'],
            summary: 'Execute Group Arbitrage',
            body: {
                type: 'object',
                properties: {
                    marketId: { type: 'string' },
                    amount: { type: 'number' }
                },
                required: ['marketId', 'amount']
            }
        },
        handler: async (request, reply) => {
            const { marketId, amount } = request.body as any;
            try {
                const amountUSDC = amount || 10;
                const result = await scanner.execute(marketId, amountUSDC);
                return result;
            } catch (err: any) {
                return reply.status(500).send({ error: err.message });
            }
        }
    });

    fastify.get('/orders', {
        schema: {
            tags: ['Group Arb'],
            summary: 'Check Active Orders for a Market',
            querystring: {
                type: 'object',
                properties: {
                    marketId: { type: 'string' }
                },
                required: ['marketId']
            }
        },
        handler: async (request, reply) => {
            const { marketId } = request.query as any;
            try {
                const orders = await scanner.getActiveOrders(marketId);
                return { success: true, orders };
            } catch (err: any) {
                return reply.status(500).send({ error: err.message });
            }
        }
    });

    fastify.get('/diagnose', {
        schema: {
            tags: ['Group Arb'],
            summary: 'Diagnose Market Orders/Trades (Open Orders + Recent Trades)',
            querystring: {
                type: 'object',
                properties: {
                    identifier: { type: 'string' },
                    marketId: { type: 'string' }
                }
            }
        },
        handler: async (request, reply) => {
            const q = request.query as any;
            try {
                const identifier = q.identifier ? String(q.identifier) : '';
                const marketId = q.marketId ? String(q.marketId) : '';
                const resolved = identifier ? await scanner.resolveIdentifier(identifier) : null;
                const mid = resolved?.marketId || marketId;
                if (!mid) return reply.status(400).send({ error: 'Missing identifier or marketId' });

                const [openOrders, trades] = await Promise.all([
                    scanner.getActiveOrders(mid),
                    scanner.getTrades({ market: mid }).catch(() => []),
                ]);

                return {
                    success: true,
                    marketId: mid,
                    resolved,
                    openOrders,
                    trades
                };
            } catch (err: any) {
                return reply.status(500).send({ error: err.message });
            }
        }
    });

    fastify.get('/status', {
        schema: {
            tags: ['Group Arb'],
            summary: 'Trading Status (CLOB Connectivity)'
        },
        handler: async (request, reply) => {
            try {
                const status = await scanner.getTradingStatus();
                return { success: true, status };
            } catch (err: any) {
                return reply.status(500).send({ error: err.message });
            }
        }
    });

    fastify.get('/funder', {
        schema: {
            tags: ['Group Arb'],
            summary: 'Get Funder Address'
        },
        handler: async () => {
            return { success: true, funder: scanner.getFunderAddress() };
        }
    });

    fastify.get('/ctf-custody', {
        schema: {
            tags: ['Group Arb'],
            summary: 'CTF Custody Check (Signer vs Funder)',
            querystring: {
                type: 'object',
                properties: {
                    marketId: { type: 'string' }
                },
                required: ['marketId']
            }
        },
        handler: async (request, reply) => {
            const { marketId } = request.query as any;
            try {
                const custody = await scanner.getCtfCustody(marketId);
                return { success: true, custody };
            } catch (err: any) {
                return reply.status(500).send({ error: err.message });
            }
        }
    });

    fastify.get('/open-orders', {
        schema: {
            tags: ['Group Arb'],
            summary: 'Get Open Orders (All Markets)'
        },
        handler: async (request, reply) => {
            try {
                const orders = await scanner.getAllOpenOrders();
                return { success: true, orders };
            } catch (err: any) {
                return reply.status(500).send({ error: err.message });
            }
        }
    });

    fastify.get('/monitored', {
        schema: {
            tags: ['Group Arb'],
            summary: 'Get Monitored Positions Summary',
        },
        handler: async (request, reply) => {
            try {
                const positions = await scanner.getMonitoredPositionsSummary();
                return { success: true, positions };
            } catch (err: any) {
                return reply.status(500).send({ error: err.message });
            }
        }
    });

    fastify.get('/portfolio-summary', {
        schema: {
            tags: ['Group Arb'],
            summary: 'Portfolio summary (portfolio value, cash, positions)',
            querystring: {
                type: 'object',
                properties: {
                    positionsLimit: { type: 'number' }
                }
            }
        },
        handler: async (request, reply) => {
            try {
                const q = request.query as any;
                const positionsLimit = q.positionsLimit != null ? Number(q.positionsLimit) : 50;
                const summary = await scanner.getPortfolioSummary({ positionsLimit });
                return { success: true, summary };
            } catch (err: any) {
                return reply.status(500).send({ error: err.message });
            }
        }
    });

    fastify.post('/cancel-order', {
        schema: {
            tags: ['Group Arb'],
            summary: 'Cancel One Order',
            body: {
                type: 'object',
                properties: {
                    orderId: { type: 'string' }
                },
                required: ['orderId']
            }
        },
        handler: async (request, reply) => {
            const { orderId } = request.body as any;
            try {
                const result = await scanner.cancelOrder(orderId);
                return { success: true, result };
            } catch (err: any) {
                return reply.status(500).send({ error: err.message });
            }
        }
    });

    fastify.post('/exit-now', {
        schema: {
            tags: ['Group Arb'],
            summary: 'Manual Exit Now (cancel related orders + attempt one-leg exit)',
            body: {
                type: 'object',
                required: ['marketId'],
                properties: {
                    marketId: { type: 'string' }
                }
            }
        },
        handler: async (request, reply) => {
            const { marketId } = request.body as any;
            try {
                const result = await scanner.exitNow(String(marketId));
                return { success: true, result };
            } catch (err: any) {
                return reply.status(500).send({ error: err.message });
            }
        }
    });

    fastify.get('/trades', {
        schema: {
            tags: ['Group Arb'],
            summary: 'Get Recent Trades (Authed User; optional market filter)'
        },
        handler: async (request, reply) => {
            try {
                const q = request.query as any;
                const market = q.marketId || q.market;
                const params: any = {};
                if (market) params.market = market;
                const trades = await scanner.getTrades(params);
                return { success: true, trades };
            } catch (err: any) {
                return reply.status(500).send({ error: err.message });
            }
        }
    });

    fastify.get('/performance', {
        schema: {
            tags: ['Group Arb'],
            summary: 'Cashflow P/L by timeframe and strategy'
        },
        handler: async (request, reply) => {
            try {
                const q = request.query as any;
                const range = String(q.range || '1D').toUpperCase();
                const limit = q.limit != null ? Number(q.limit) : 200;

                const nowSec = Math.floor(Date.now() / 1000);
                const rangeToSec: any = { '1D': 86400, '1W': 604800, '1M': 2592000, 'ALL': Number.POSITIVE_INFINITY };
                const windowSec = rangeToSec[range] ?? 86400;
                const fromSec = windowSec == Number.POSITIVE_INFINITY ? 0 : (nowSec - windowSec);

                const history = scanner.getHistory();
                const orderIdToStrategy = new Map<string, string>();
                for (const entry of history) {
                    const tag = entry?.mode === 'manual' ? 'manual' : entry?.mode === 'auto' ? 'auto' : entry?.mode === 'semi' ? 'semi' : String(entry?.mode || 'unknown');
                    for (const r of (entry?.results || [])) {
                        const orderId = r?.orderId;
                        if (orderId) orderIdToStrategy.set(String(orderId), tag);
                    }
                }

                const trades = await scanner.getTrades({ limit: Number.isFinite(limit) ? limit : 200 }).catch(() => []);
                const filtered = (trades || []).filter((t: any) => {
                    const mt = Number(t?.match_time ?? t?.matchTime ?? 0);
                    return Number.isFinite(mt) && mt >= fromSec;
                });

                const byStrategy: Record<string, any> = {};
                let totalNet = 0;
                let totalBuy = 0;
                let totalSell = 0;

                const tagForTrade = (t: any) => {
                    const ids: string[] = [];
                    const taker = t?.taker_order_id ?? t?.takerOrderId;
                    if (taker) ids.push(String(taker));
                    const makers = t?.maker_orders ?? t?.makerOrders;
                    if (Array.isArray(makers)) {
                        for (const mo of makers) {
                            const oid = mo?.order_id ?? mo?.orderId;
                            if (oid) ids.push(String(oid));
                        }
                    }
                    for (const id of ids) {
                        const tag = orderIdToStrategy.get(id);
                        if (tag) return tag;
                    }
                    return 'external';
                };

                for (const t of filtered) {
                    const side = String(t?.side || '').toUpperCase();
                    const price = Number(t?.price ?? 0);
                    const size = Number(t?.size ?? 0);
                    if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) continue;

                    const cash = (side === 'SELL' ? 1 : -1) * price * size;
                    const tag = tagForTrade(t);

                    if (!byStrategy[tag]) byStrategy[tag] = { strategy: tag, netCashflow: 0, buyVolume: 0, sellVolume: 0, tradeCount: 0 };
                    byStrategy[tag].netCashflow += cash;
                    byStrategy[tag].tradeCount += 1;
                    if (side === 'BUY') byStrategy[tag].buyVolume += price * size;
                    if (side === 'SELL') byStrategy[tag].sellVolume += price * size;

                    totalNet += cash;
                    if (side === 'BUY') totalBuy += price * size;
                    if (side === 'SELL') totalSell += price * size;
                }

                const rows = Object.values(byStrategy).sort((a: any, b: any) => (b.netCashflow - a.netCashflow));

                return {
                    success: true,
                    range,
                    fromSec,
                    toSec: nowSec,
                    total: { netCashflow: totalNet, buyVolume: totalBuy, sellVolume: totalSell, tradeCount: filtered.length },
                    byStrategy: rows
                };
            } catch (err: any) {
                return reply.status(500).send({ error: err.message });
            }
        }
    });

    fastify.get('/pnl', {
        schema: {
            tags: ['Group Arb'],
            summary: 'Profit/Loss time series (Polymarket-style)',
            querystring: {
                type: 'object',
                properties: {
                    range: { type: 'string' }
                }
            }
        },
        handler: async (request, reply) => {
            try {
                const q = request.query as any;
                const range = String(q.range || '1D').toUpperCase() as any;
                const r = scanner.getPnl(range);
                return { success: true, ...r };
            } catch (err: any) {
                return reply.status(500).send({ error: err.message });
            }
        }
    });

    fastify.post('/redeem-now', {
        schema: {
            tags: ['Group Arb'],
            summary: 'Redeem resolved positions (Data API redeemable=true)',
            body: {
                type: 'object',
                properties: {
                    max: { type: 'number' }
                }
            }
        },
        handler: async (request, reply) => {
            try {
                const b = (request.body || {}) as any;
                const max = b.max != null ? Number(b.max) : 20;
                const result = await scanner.redeemNow({ max, source: 'manual' });
                return { success: true, result };
            } catch (err: any) {
                return reply.status(500).send({ error: err.message });
            }
        }
    });

    fastify.post('/redeem-drain', {
        schema: {
            tags: ['Group Arb'],
            summary: 'Redeem ASAP (one-by-one drain; non-blocking confirmations)',
            body: {
                type: 'object',
                properties: {
                    maxTotal: { type: 'number' }
                }
            }
        },
        handler: async (request, reply) => {
            try {
                const b = (request.body || {}) as any;
                const maxTotal = b.maxTotal != null ? Number(b.maxTotal) : undefined;
                const started = scanner.startRedeemDrain({ maxTotal, source: 'manual' });
                return { success: true, started };
            } catch (err: any) {
                return reply.status(500).send({ error: err.message });
            }
        }
    });

    fastify.post('/auto-redeem/config', {
        schema: {
            tags: ['Group Arb'],
            summary: 'Configure auto redeem',
            body: {
                type: 'object',
                properties: {
                    enabled: { type: 'boolean' },
                    intervalMinutes: { type: 'number' },
                    maxPerCycle: { type: 'number' }
                }
            }
        },
        handler: async (request, reply) => {
            try {
                const b = (request.body || {}) as any;
                const config = scanner.setAutoRedeemConfig({
                    enabled: b.enabled,
                    intervalMinutes: b.intervalMinutes,
                    maxPerCycle: b.maxPerCycle
                });
                return { success: true, config };
            } catch (err: any) {
                return reply.status(500).send({ error: err.message });
            }
        }
    });

    fastify.get('/auto-redeem/status', {
        schema: {
            tags: ['Group Arb'],
            summary: 'Get auto redeem status',
        },
        handler: async () => {
            return { success: true, status: scanner.getAutoRedeemStatus() };
        }
    });

    fastify.get('/relayer/status', {
        schema: {
            tags: ['Group Arb'],
            summary: 'Get relayer status',
        },
        handler: async () => {
            return { success: true, status: scanner.getRelayerStatus() };
        }
    });

    fastify.post('/relayer/config', {
        schema: {
            tags: ['Group Arb'],
            summary: 'Configure builder relayer credentials (persisted to disk)',
            body: {
                type: 'object',
                required: ['apiKey', 'secret', 'passphrase'],
                properties: {
                    apiKey: { type: 'string' },
                    secret: { type: 'string' },
                    passphrase: { type: 'string' },
                    relayerUrl: { type: 'string' },
                    persist: { type: 'boolean' },
                    testRedeem: { type: 'boolean' },
                    testMax: { type: 'number' },
                }
            }
        },
        handler: async (request, reply) => {
            try {
                const b = (request.body || {}) as any;
                const result = scanner.configureRelayer({
                    apiKey: String(b.apiKey || ''),
                    secret: String(b.secret || ''),
                    passphrase: String(b.passphrase || ''),
                    relayerUrl: b.relayerUrl != null ? String(b.relayerUrl) : undefined,
                    persist: b.persist !== false,
                });
                const testRedeem = b.testRedeem !== false;
                const testMax = b.testMax != null ? Number(b.testMax) : 1;
                const test = testRedeem && result?.success ? await scanner.redeemNow({ max: testMax, source: 'manual' }) : null;
                const results: any[] = Array.isArray(test?.results) ? test.results : [];
                const firstFail = results.find(r => !r?.success);
                const errMsg = firstFail?.error ? String(firstFail.error) : '';
                if (errMsg.includes('invalid authorization') || errMsg.includes('"status":401') || errMsg.includes('Unauthorized')) {
                    scanner.clearRelayerConfig({ deleteFile: true });
                }
                return { success: true, result, status: scanner.getRelayerStatus(), testRedeemResult: test };
            } catch (err: any) {
                return reply.status(500).send({ error: err.message });
            }
        }
    });

    fastify.get('/redeem/diagnose', {
        schema: {
            tags: ['Group Arb'],
            summary: 'Redeem diagnostics (redeemables + wallet info)',
            querystring: {
                type: 'object',
                properties: {
                    limit: { type: 'number' }
                }
            }
        },
        handler: async (request, reply) => {
            try {
                const q = request.query as any;
                const limit = q.limit != null ? Number(q.limit) : 50;
                const diag = await scanner.getRedeemDiagnostics({ limit });
                return { success: true, diagnostics: diag };
            } catch (err: any) {
                return reply.status(500).send({ error: err.message });
            }
        }
    });

    fastify.post('/redeem/conditions', {
        schema: {
            tags: ['Group Arb'],
            summary: 'Redeem specific conditions (creates history entry)',
            body: {
                type: 'object',
                properties: {
                    source: { type: 'string' },
                    items: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                conditionId: { type: 'string' },
                                title: { type: 'string' },
                                slug: { type: 'string' },
                                eventSlug: { type: 'string' },
                                outcome: { type: 'string' },
                            },
                            required: ['conditionId']
                        }
                    }
                }
            }
        },
        handler: async (request, reply) => {
            try {
                const b = request.body as any;
                const items = Array.isArray(b?.items) ? b.items : [];
                const source = String(b?.source || 'manual') === 'auto' ? 'auto' : 'manual';
                const r = await scanner.redeemByConditions(items, { source });
                return r;
            } catch (err: any) {
                return reply.status(500).send({ error: err.message });
            }
        }
    });

    fastify.get('/redeem/in-flight', {
        schema: {
            tags: ['Group Arb'],
            summary: 'Get in-flight redeem transactions (submitted/confirmed/failed)',
            querystring: {
                type: 'object',
                properties: {
                    limit: { type: 'number' }
                }
            }
        },
        handler: async (request, reply) => {
            try {
                const q = request.query as any;
                const limit = q.limit != null ? Number(q.limit) : 50;
                const inflight = scanner.getRedeemInFlight({ limit });
                return { success: true, inflight };
            } catch (err: any) {
                return reply.status(500).send({ error: err.message });
            }
        }
    });

    fastify.get('/history', {
        schema: {
            tags: ['Group Arb'],
            summary: 'Get Global Order History',
        },
        handler: async (request, reply) => {
            try {
                const q = request.query as any;
                const refresh = String(q.refresh || '') === '1' || String(q.refresh || '') === 'true';
                const intervalMs = q.intervalMs != null ? Number(q.intervalMs) : 1000;
                const maxEntries = q.maxEntries != null ? Number(q.maxEntries) : 20;

                if (refresh) {
                    await scanner.refreshHistoryStatuses({ minIntervalMs: intervalMs, maxEntries });
                }
                const history = scanner.getHistory();
                return { success: true, history };
            } catch (err: any) {
                return reply.status(500).send({ error: err.message });
            }
        }
    });
};
