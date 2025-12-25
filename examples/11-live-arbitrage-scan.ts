/**
 * 示例 11: 实时套利扫描
 *
 * 此脚本扫描真实的 Polymarket 市场寻找套利机会。
 * 仅使用读取操作（不交易）以安全测试套利检测。
 *
 * 演示功能：
 * - 真实市场数据获取
 * - 套利机会检测
 * - Gas 成本估算
 * - 预检查模拟
 *
 * 运行：
 *   pnpm example:live-arb
 */

import { PolymarketSDK, checkArbitrage } from '../src/index.js';

async function main() {
  console.log('=== 实时套利市场扫描 ===\n');
  console.log('扫描真实 Polymarket 市场寻找套利机会...\n');

  // 初始化 SDK（读取操作不需要凭证）
  const sdk = new PolymarketSDK();

  // ===== 1. 获取活跃市场 =====
  console.log('1. 获取活跃市场...\n');

  const markets = await sdk.gammaApi.getMarkets({
    closed: false,
    active: true,
    limit: 50,
  });

  console.log(`   找到 ${markets.length} 个活跃市场\n`);

  // ===== 2. 分析每个市场的套利 =====
  console.log('2. 分析市场套利机会...\n');

  const opportunities: Array<{
    question: string;
    slug: string;
    conditionId: string;
    type: 'long' | 'short';
    yesAsk: number;
    noAsk: number;
    yesBid: number;
    noBid: number;
    askSum: number;
    bidSum: number;
    longArbProfit: number;
    shortArbProfit: number;
    spread: number;
    volume24h: number;
  }> = [];

  let analyzed = 0;
  let errors = 0;

  for (const market of markets) {
    if (!market.conditionId) continue;

    try {
      const orderbook = await sdk.clobApi.getProcessedOrderbook(market.conditionId);

      analyzed++;

      // 检查套利
      const arb = checkArbitrage(
        orderbook.yes.ask,
        orderbook.no.ask,
        orderbook.yes.bid,
        orderbook.no.bid
      );

      // 存储所有市场用于分析（即使套利利润为负）
      // 这有助于我们理解市场效率
      if (orderbook.yes.ask > 0 && orderbook.no.ask > 0) {
        opportunities.push({
          question: market.question?.slice(0, 60) || '未知',
          slug: market.slug || '',
          conditionId: market.conditionId,
          type: arb?.type || (orderbook.summary.longArbProfit > orderbook.summary.shortArbProfit ? 'long' : 'short'),
          yesAsk: orderbook.yes.ask,
          noAsk: orderbook.no.ask,
          yesBid: orderbook.yes.bid,
          noBid: orderbook.no.bid,
          askSum: orderbook.summary.askSum,
          bidSum: orderbook.summary.bidSum,
          longArbProfit: orderbook.summary.longArbProfit,
          shortArbProfit: orderbook.summary.shortArbProfit,
          spread: orderbook.summary.spread,
          volume24h: market.volume24hr || 0,
        });
      }

      // 进度指示器
      if (analyzed % 10 === 0) {
        process.stdout.write(`   已分析 ${analyzed}/${markets.length} 个市场...\r`);
      }
    } catch {
      errors++;
    }
  }

  console.log(`\n   完成: 分析了 ${analyzed} 个市场, ${errors} 个错误\n`);

  // ===== 3. 排序并显示结果 =====
  console.log('3. 最佳套利机会:\n');

  // 按最佳机会排序（多头或空头利润的最大值）
  opportunities.sort((a, b) => {
    const aMax = Math.max(a.longArbProfit, b.shortArbProfit);
    const bMax = Math.max(b.longArbProfit, b.shortArbProfit);
    return bMax - aMax;
  });

  // 显示前 10 个
  const top10 = opportunities.slice(0, 10);

  if (top10.length === 0) {
    console.log('   未找到有显著价差的市场');
  } else {
    console.log('   ┌────────────────────────────────────────────────────────────────┐');
    console.log('   │ 市场分析（按潜在利润排名前 10）                                │');
    console.log('   ├────────────────────────────────────────────────────────────────┤');

    for (const opp of top10) {
      const maxProfit = Math.max(opp.longArbProfit, opp.shortArbProfit);
      const arbType = opp.longArbProfit > opp.shortArbProfit ? '多头' : '空头';
      const isProfitable = maxProfit > 0;

      console.log(`   │ ${opp.question.padEnd(60)} │`);
      console.log(`   │                                                                │`);
      console.log(`   │   YES: 卖价=${opp.yesAsk.toFixed(4)} 买价=${opp.yesBid.toFixed(4)}                               │`);
      console.log(`   │   NO:  卖价=${opp.noAsk.toFixed(4)} 买价=${opp.noBid.toFixed(4)}                               │`);
      console.log(`   │   总和: 卖价和=${opp.askSum.toFixed(4)} 买价和=${opp.bidSum.toFixed(4)}                      │`);
      console.log(`   │   ${arbType}利润: ${(maxProfit * 100).toFixed(2)}% ${isProfitable ? '✅' : '❌'}                                     │`);
      console.log(`   │   24h 交易量: $${opp.volume24h.toLocaleString()}                                       │`);
      console.log(`   ├────────────────────────────────────────────────────────────────┤`);
    }

    console.log('   └────────────────────────────────────────────────────────────────┘');
  }

  // ===== 4. 检查实际有利可图的机会 =====
  console.log('\n4. 有利可图的机会（> 0% 利润）:\n');

  const profitable = opportunities.filter(
    (opp) => opp.longArbProfit > 0 || opp.shortArbProfit > 0
  );

  if (profitable.length === 0) {
    console.log('   未发现有利可图的套利机会。');
    console.log('   这是正常的 - 市场通常是有效的。\n');
    console.log('   ┌─────────────────────────────────────────────────────────────────┐');
    console.log('   │ 为什么没有套利？                                                │');
    console.log('   │                                                                 │');
    console.log('   │ 1. 做市商积极地填补套利缺口                                     │');
    console.log('   │ 2. Gas 成本（~$0.01-0.05）消耗小额利润                         │');
    console.log('   │ 3. 交易费用减少实际利润                                         │');
    console.log('   │ 4. 机会在毫秒内消失                                             │');
    console.log('   │                                                                 │');
    console.log('   │ 成功的套利需要：                                                │');
    console.log('   │ - 非常快速的执行                                                │');
    console.log('   │ - 优化的 Gas 使用                                               │');
    console.log('   │ - 大量资金（$1000+）                                           │');
    console.log('   └─────────────────────────────────────────────────────────────────┘');
  } else {
    console.log(`   发现 ${profitable.length} 个有利可图的机会:\n`);

    for (const opp of profitable) {
      const arbType = opp.longArbProfit > opp.shortArbProfit ? '多头' : '空头';
      const profit = Math.max(opp.longArbProfit, opp.shortArbProfit);

      console.log(`   🎯 ${arbType}套利: ${(profit * 100).toFixed(2)}% 利润`);
      console.log(`      市场: ${opp.question}`);
      console.log(`      Condition ID: ${opp.conditionId}`);

      if (arbType === '多头') {
        console.log(`      策略: 买 YES@${opp.yesAsk.toFixed(4)} + NO@${opp.noAsk.toFixed(4)} = ${opp.askSum.toFixed(4)} → 合并得 $1`);
      } else {
        console.log(`      策略: 拆分 $1 → 卖 YES@${opp.yesBid.toFixed(4)} + NO@${opp.noBid.toFixed(4)} = ${opp.bidSum.toFixed(4)}`);
      }
      console.log('');
    }
  }

  // ===== 5. 市场效率分析 =====
  console.log('\n5. 市场效率总结:\n');

  if (opportunities.length === 0) {
    console.log('   没有分析到有效订单簿的市场。\n');
  } else {
    const avgAskSum = opportunities.reduce((sum, o) => sum + o.askSum, 0) / opportunities.length;
    const avgBidSum = opportunities.reduce((sum, o) => sum + o.bidSum, 0) / opportunities.length;
    const avgSpread = opportunities.reduce((sum, o) => sum + o.spread, 0) / opportunities.length;

    const closestToLongArb = opportunities.reduce((closest, o) =>
      Math.abs(1 - o.askSum) < Math.abs(1 - closest.askSum) ? o : closest
    );

    const closestToShortArb = opportunities.reduce((closest, o) =>
      Math.abs(1 - o.bidSum) < Math.abs(1 - closest.bidSum) ? o : closest
    );

    console.log(`   平均卖价和: ${avgAskSum.toFixed(4)}（多头套利理想值: < 1.0）`);
    console.log(`   平均买价和: ${avgBidSum.toFixed(4)}（空头套利理想值: > 1.0）`);
    console.log(`   平均价差:   ${(avgSpread * 100).toFixed(2)}%`);
    console.log('');
    console.log(`   最接近多头套利: ${closestToLongArb.question.slice(0, 40)}...`);
    console.log(`                   卖价和 = ${closestToLongArb.askSum.toFixed(4)}, 利润 = ${(closestToLongArb.longArbProfit * 100).toFixed(2)}%`);
    console.log('');
    console.log(`   最接近空头套利: ${closestToShortArb.question.slice(0, 40)}...`);
    console.log(`                   买价和 = ${closestToShortArb.bidSum.toFixed(4)}, 利润 = ${(closestToShortArb.shortArbProfit * 100).toFixed(2)}%`);
  }

  console.log('\n=== 扫描完成 ===\n');
}

main().catch(console.error);
