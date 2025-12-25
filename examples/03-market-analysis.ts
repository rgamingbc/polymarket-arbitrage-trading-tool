/**
 * 示例 3: 市场分析与套利检测
 *
 * 本示例演示：
 * - 获取多个市场的订单簿
 * - 检测套利机会
 * - 分析市场深度和不平衡度
 *
 * 运行: pnpm tsx examples/03-market-analysis.ts
 */

import { PolymarketSDK } from '../src/index.js';

async function main() {
  console.log('=== 市场分析与套利检测 ===\n');

  const sdk = new PolymarketSDK();

  // 1. 获取热门市场进行分析
  console.log('1. 获取热门市场...');
  const markets = await sdk.gammaApi.getTrendingMarkets(10);
  console.log(`   找到 ${markets.length} 个热门市场\n`);

  // 2. 分析每个市场的套利机会
  console.log('2. 分析市场套利机会...\n');

  const arbitrageOpportunities = [];

  for (const market of markets) {
    try {
      console.log(`   检查: ${market.question.slice(0, 60)}...`);

      // 获取统一市场以获取 token ID
      const unifiedMarket = await sdk.getMarket(market.conditionId);

      if (!unifiedMarket.tokens.yes.tokenId || !unifiedMarket.tokens.no.tokenId) {
        console.log('     跳过 (缺少 token ID)\n');
        continue;
      }

      // 获取订单簿
      const orderbook = await sdk.getOrderbook(market.conditionId);

      // 检查套利机会
      const arb = await sdk.detectArbitrage(market.conditionId, 0.001); // 0.1% 阈值

      if (arb) {
        console.log(`     ** 发现套利机会 **`);
        console.log(`     类型: ${arb.type}`);
        console.log(`     利润: ${(arb.profit * 100).toFixed(3)}%`);
        console.log(`     操作: ${arb.action}`);
        arbitrageOpportunities.push({
          market: market.question,
          slug: market.slug,
          ...arb,
        });
      } else {
        console.log(`     无套利 (卖价和: ${orderbook.summary.askSum.toFixed(4)}, 买价和: ${orderbook.summary.bidSum.toFixed(4)})`);
      }
      console.log('');

    } catch (error) {
      console.log(`     错误: ${(error as Error).message}\n`);
    }
  }

  // 3. 总结
  console.log('=== 总结 ===\n');

  if (arbitrageOpportunities.length > 0) {
    console.log(`发现 ${arbitrageOpportunities.length} 个套利机会:\n`);
    for (const opp of arbitrageOpportunities) {
      console.log(`- ${opp.market.slice(0, 60)}...`);
      console.log(`  Slug: ${opp.slug}`);
      console.log(`  类型: ${opp.type}, 利润: ${(opp.profit * 100).toFixed(3)}%`);
      console.log('');
    }
  } else {
    console.log('未发现套利机会（这在有效市场中是正常的）');
  }

  // 4. 分析市场深度
  console.log('\n=== 市场深度分析 ===\n');

  for (const market of markets.slice(0, 3)) {
    try {
      const orderbook = await sdk.getOrderbook(market.conditionId);

      console.log(`市场: ${market.question.slice(0, 50)}...`);
      console.log(`  总买单深度: $${orderbook.summary.totalBidDepth.toFixed(2)}`);
      console.log(`  总卖单深度: $${orderbook.summary.totalAskDepth.toFixed(2)}`);
      console.log(`  不平衡率: ${orderbook.summary.imbalanceRatio.toFixed(2)}`);

      if (orderbook.summary.imbalanceRatio > 1.5) {
        console.log(`  ** 高买入压力 (比率 > 1.5) **`);
      } else if (orderbook.summary.imbalanceRatio < 0.67) {
        console.log(`  ** 高卖出压力 (比率 < 0.67) **`);
      }
      console.log('');
    } catch {
      // 跳过错误
    }
  }

  console.log('=== 完成 ===');
}

main().catch(console.error);
