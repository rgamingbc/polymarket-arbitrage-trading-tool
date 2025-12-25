/**
 * 示例 1: SDK 基础用法
 *
 * 本示例演示：
 * - 从 Gamma API 获取热门市场
 * - 从统一 API（Gamma + CLOB）获取市场详情
 * - 获取订单簿数据
 *
 * 运行: pnpm tsx examples/01-basic-usage.ts
 */

import { PolymarketSDK } from '../src/index.js';

async function main() {
  console.log('=== Polymarket SDK 基础用法 ===\n');

  const sdk = new PolymarketSDK();

  // 1. 获取热门市场
  console.log('1. 获取热门市场...');
  const trendingMarkets = await sdk.gammaApi.getTrendingMarkets(5);
  console.log(`   找到 ${trendingMarkets.length} 个热门市场:\n`);

  for (const market of trendingMarkets) {
    console.log(`   - ${market.question}`);
    console.log(`     Slug: ${market.slug}`);
    console.log(`     交易量: $${market.volume.toLocaleString()}`);
    console.log(`     24h 交易量: $${market.volume24hr?.toLocaleString() || 'N/A'}`);
    console.log(`     价格: Yes=${market.outcomePrices[0]?.toFixed(2)}, No=${market.outcomePrices[1]?.toFixed(2)}`);
    console.log('');
  }

  // 2. 获取统一市场详情（合并 Gamma + CLOB 数据）
  if (trendingMarkets.length > 0) {
    const firstMarket = trendingMarkets[0];
    console.log(`2. 获取统一市场详情: ${firstMarket.slug}`);
    const unifiedMarket = await sdk.getMarket(firstMarket.slug);
    console.log(`   问题: ${unifiedMarket.question}`);
    console.log(`   Condition ID: ${unifiedMarket.conditionId}`);
    console.log(`   YES Token ID: ${unifiedMarket.tokens.yes.tokenId}`);
    console.log(`   NO Token ID: ${unifiedMarket.tokens.no.tokenId}`);
    console.log(`   YES 价格: ${unifiedMarket.tokens.yes.price.toFixed(4)}`);
    console.log(`   NO 价格: ${unifiedMarket.tokens.no.price.toFixed(4)}`);
    console.log(`   数据来源: ${unifiedMarket.source}`);
    console.log('');

    // 3. 获取订单簿
    console.log('3. 获取订单簿...');
    const orderbook = await sdk.getOrderbook(unifiedMarket.conditionId);
    console.log(`   YES 最优买价: ${orderbook.yes.bid.toFixed(4)} (数量: ${orderbook.yes.bidSize.toFixed(2)})`);
    console.log(`   YES 最优卖价: ${orderbook.yes.ask.toFixed(4)} (数量: ${orderbook.yes.askSize.toFixed(2)})`);
    console.log(`   YES 价差: ${(orderbook.yes.spread * 100).toFixed(2)}%`);
    console.log('');
    console.log(`   NO 最优买价: ${orderbook.no.bid.toFixed(4)} (数量: ${orderbook.no.bidSize.toFixed(2)})`);
    console.log(`   NO 最优卖价: ${orderbook.no.ask.toFixed(4)} (数量: ${orderbook.no.askSize.toFixed(2)})`);
    console.log(`   NO 价差: ${(orderbook.no.spread * 100).toFixed(2)}%`);
    console.log('');
    console.log(`   卖价总和 (YES+NO): ${orderbook.summary.askSum.toFixed(4)}`);
    console.log(`   买价总和 (YES+NO): ${orderbook.summary.bidSum.toFixed(4)}`);
    console.log(`   多头套利利润: ${(orderbook.summary.longArbProfit * 100).toFixed(3)}%`);
    console.log(`   空头套利利润: ${(orderbook.summary.shortArbProfit * 100).toFixed(3)}%`);
    console.log(`   不平衡率: ${orderbook.summary.imbalanceRatio.toFixed(2)}`);
  }

  console.log('\n=== 完成 ===');
}

main().catch(console.error);
