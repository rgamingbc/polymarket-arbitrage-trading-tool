/**
 * Fastify 应用主体
 */

import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { config } from './config.js';

// 路由导入
import { marketRoutes } from './routes/markets.js';
import { arbitrageRoutes } from './routes/arbitrage.js';
import { walletRoutes } from './routes/wallets.js';
import { realtimeRoutes } from './websocket/realtime.js';

export async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify({
        logger: true,
    });

    // 注册插件
    await app.register(cors, config.cors);
    await app.register(websocket);

    // Swagger 文档
    await app.register(swagger, {
        openapi: {
            info: {
                title: 'Polymarket API',
                description: 'Polymarket 数据和交易 API',
                version: '1.0.0',
            },
            servers: [
                { url: `http://localhost:${config.port}`, description: '开发服务器' },
            ],
            tags: [
                { name: '市场', description: '市场数据接口' },
                { name: '套利', description: '套利检测接口' },
                { name: '钱包', description: '钱包分析接口' },
            ],
        },
    });

    await app.register(swaggerUi, {
        routePrefix: '/docs',
        uiConfig: {
            docExpansion: 'list',
            deepLinking: false,
        },
    });

    // 健康检查
    app.get('/health', async () => {
        return { status: 'ok', timestamp: new Date().toISOString() };
    });

    // 注册路由
    await app.register(marketRoutes, { prefix: '/api/markets' });
    await app.register(arbitrageRoutes, { prefix: '/api/arbitrage' });
    await app.register(walletRoutes, { prefix: '/api/wallets' });
    await app.register(realtimeRoutes, { prefix: '/ws' });

    return app;
}
