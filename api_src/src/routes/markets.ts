/**
 * 市场 API 路由
 */

import { FastifyPluginAsync } from 'fastify';
import { PolymarketSDK } from '../../../src/index.js';

const sdk = new PolymarketSDK();

export const marketRoutes: FastifyPluginAsync = async (fastify) => {
    // 获取热门市场
    fastify.get('/trending', {
        schema: {
            tags: ['市场'],
            summary: '获取热门市场',
            querystring: {
                type: 'object',
                properties: {
                    limit: { type: 'number', default: 10 },
                },
            },
            response: {
                200: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            conditionId: { type: 'string' },
                            question: { type: 'string' },
                            slug: { type: 'string' },
                            volume24hr: { type: 'number' },
                        },
                    },
                },
            },
        },
        handler: async (request, reply) => {
            const { limit = 10 } = request.query as { limit?: number };
            const markets = await sdk.gammaApi.getTrendingMarkets(limit);
            return markets.map((m) => ({
                conditionId: m.conditionId,
                question: m.question,
                slug: m.slug,
                volume24hr: m.volume24hr,
            }));
        },
    });

    // 获取市场详情
    fastify.get('/:conditionId', {
        schema: {
            tags: ['市场'],
            summary: '获取市场详情',
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
            const market = await sdk.getMarket(conditionId);
            return market;
        },
    });

    // 获取订单簿
    fastify.get('/:conditionId/orderbook', {
        schema: {
            tags: ['市场'],
            summary: '获取订单簿',
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
            const orderbook = await sdk.getOrderbook(conditionId);
            return orderbook;
        },
    });

    // 获取 K 线数据
    fastify.get('/:conditionId/klines', {
        schema: {
            tags: ['市场'],
            summary: '获取 K 线数据',
            params: {
                type: 'object',
                properties: {
                    conditionId: { type: 'string' },
                },
                required: ['conditionId'],
            },
            querystring: {
                type: 'object',
                properties: {
                    interval: { type: 'string', default: '1h' },
                    limit: { type: 'number', default: 100 },
                },
            },
        },
        handler: async (request, reply) => {
            const { conditionId } = request.params as { conditionId: string };
            const { interval = '1h', limit = 100 } = request.query as { interval?: string; limit?: number };
            const klines = await sdk.markets.getKLines(conditionId, interval as any, { limit });
            return klines;
        },
    });
};
