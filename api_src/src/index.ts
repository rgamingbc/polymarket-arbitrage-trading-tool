/**
 * API 服务入口
 */

import { buildApp } from './app.js';
import { config } from './config.js';

async function main() {
    console.log('🚀 启动 Polymarket API 服务...');

    const app = await buildApp();

    try {
        await app.listen({ port: config.port, host: config.host });
        console.log(`✅ 服务已启动: http://localhost:${config.port}`);
        console.log(`📚 API 文档: http://localhost:${config.port}/docs`);
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
}

main();
