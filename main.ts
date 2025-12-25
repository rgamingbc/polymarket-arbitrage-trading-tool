/**
 * 开发入口文件 - main.ts
 * 
 * 用于二次开发和测试 SDK 功能
 * 运行: pnpm tsx main.ts
 */

import { PolymarketSDK } from './src/index.js';

async function main() {
    console.log('🚀 PolymarketSDK 开发测试启动\n');

    // 初始化 SDK
    const sdk = new PolymarketSDK();

    try {
        // 示例 1: 获取市场信息
        console.log('📊 获取市场信息...');
        // 使用一个已知的 slug 或 conditionId
        const market = await sdk.getMarket('will-netflix-close-warner-brothers-acquisition-by-end-of-2026');
        console.log('市场名称:', market.question);
        console.log('YES 价格:', market.tokens.yes.price);
        console.log('NO 价格:', market.tokens.no.price);

        // 示例 2: 获取订单簿
        console.log('\n📖 获取订单簿...');
        const orderbook = await sdk.getOrderbook(market.conditionId);
        console.log('YES Bid:', orderbook.yes.bid);
        console.log('YES Ask:', orderbook.yes.ask);

        // 示例 3: 检测套利机会
        console.log('\n💰 检测套利机会...');
        const arb = await sdk.detectArbitrage(market.conditionId, 0.01);
        if (arb) {
            console.log('发现套利:', arb.type, '利润:', arb.profit);
        } else {
            console.log('无套利机会');
        }

        // 在这里添加你的开发代码...
        console.log('✅ 开发环境准备就绪！');
        console.log('请取消注释上面的示例代码或添加你自己的代码。');

    } catch (error) {
        console.error('❌ 错误:', error);
    }
}

main();
