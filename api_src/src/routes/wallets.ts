/**
 * 钱包 API 路由
 */

import { FastifyPluginAsync } from 'fastify';
import { PolymarketSDK } from '../../../src/index.js';

const sdk = new PolymarketSDK();

export const walletRoutes: FastifyPluginAsync = async (fastify) => {
    // 获取排行榜
    fastify.get('/leaderboard', {
        schema: {
            tags: ['钱包'],
            summary: '获取交易员排行榜',
            querystring: {
                type: 'object',
                properties: {
                    limit: { type: 'number', default: 10 },
                },
            },
        },
        handler: async (request, reply) => {
            const { limit = 10 } = request.query as { limit?: number };
            const traders = await sdk.wallets.getTopTraders(limit);
            return traders;
        },
    });

    // 获取钱包画像
    fastify.get('/:address/profile', {
        schema: {
            tags: ['钱包'],
            summary: '获取钱包画像',
            params: {
                type: 'object',
                properties: {
                    address: { type: 'string' },
                },
                required: ['address'],
            },
        },
        handler: async (request, reply) => {
            const { address } = request.params as { address: string };
            const profile = await sdk.wallets.getWalletProfile(address);
            return profile;
        },
    });

    // 获取钱包持仓
    fastify.get('/:address/positions', {
        schema: {
            tags: ['钱包'],
            summary: '获取钱包持仓',
            params: {
                type: 'object',
                properties: {
                    address: { type: 'string' },
                },
                required: ['address'],
            },
        },
        handler: async (request, reply) => {
            const { address } = request.params as { address: string };
            const positions = await sdk.dataApi.getPositions(address);
            return positions;
        },
    });

    // 获取钱包活动
    fastify.get('/:address/activity', {
        schema: {
            tags: ['钱包'],
            summary: '获取钱包活动',
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
                    limit: { type: 'number', default: 50 },
                },
            },
        },
        handler: async (request, reply) => {
            const { address } = request.params as { address: string };
            const { limit = 50 } = request.query as { limit?: number };
            const activity = await sdk.dataApi.getActivity(address, { limit });
            return activity;
        },
    });
};
