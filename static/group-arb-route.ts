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

    fastify.get('/history', {
        schema: {
            tags: ['Group Arb'],
            summary: 'Get Global Order History',
        },
        handler: async (request, reply) => {
            try {
                const history = scanner.getHistory();
                return { success: true, history };
            } catch (err: any) {
                return reply.status(500).send({ error: err.message });
            }
        }
    });
};
