/**
 * 示例 6: 服务层演示
 *
 * 本示例演示新的服务层：
 * - WalletService 用于聪明钱分析
 * - MarketService 用于 K 线和市场信号
 *
 * 运行: pnpm tsx examples/06-services-demo.ts
 */

import { PolymarketSDK, type KLineInterval } from '../src/index.js';

async function main() {
  console.log('=== 服务层演示 ===\n');

  const sdk = new PolymarketSDK();

  // ===== WalletService 演示 =====
  console.log('--- WalletService 演示 ---\n');

  // 1. 获取顶级交易员
  console.log('1. 获取顶级交易员...');
  const topTraders = await sdk.wallets.getTopTraders(5);
  console.log(`   找到 ${topTraders.length} 名顶级交易员\n`);

  for (const trader of topTraders.slice(0, 3)) {
    console.log(`   排名 #${trader.rank}: ${trader.address.slice(0, 10)}...`);
    console.log(`   盈亏: $${trader.pnl.toLocaleString()}`);
    console.log(`   交易量: $${trader.volume.toLocaleString()}\n`);
  }

  // 2. 获取钱包画像
  if (topTraders.length > 0) {
    console.log('2. 获取顶级交易员的钱包画像...');
    const profile = await sdk.wallets.getWalletProfile(topTraders[0].address);
    console.log(`   地址: ${profile.address.slice(0, 10)}...`);
    console.log(`   总盈亏: $${profile.totalPnL.toFixed(2)}`);
    console.log(`   聪明分数: ${profile.smartScore}/100`);
    console.log(`   持仓数量: ${profile.positionCount}`);
    console.log(`   最后活跃: ${profile.lastActiveAt.toLocaleString()}\n`);
  }

  // 3. 发现活跃钱包
  console.log('3. 从近期交易中发现活跃钱包...');
  const activeWallets = await sdk.wallets.discoverActiveWallets(5);
  console.log(`   找到 ${activeWallets.length} 个活跃钱包:\n`);
  for (const wallet of activeWallets) {
    console.log(`   - ${wallet.address.slice(0, 10)}...: ${wallet.tradeCount} 笔交易`);
  }

  // ===== MarketService 演示 =====
  console.log('\n--- MarketService 演示 ---\n');

  // 4. 获取热门市场
  console.log('4. 获取热门市场...');
  const trendingMarkets = await sdk.markets.getTrendingMarkets(1);
  if (trendingMarkets.length === 0) {
    console.log('未找到热门市场');
    return;
  }

  const market = trendingMarkets[0];
  console.log(`   市场: ${market.question.slice(0, 60)}...`);
  console.log(`   Condition ID: ${market.conditionId}\n`);

  // 5. 获取统一市场数据
  console.log('5. 获取统一市场数据...');
  const unifiedMarket = await sdk.markets.getMarket(market.conditionId);
  console.log(`   数据来源: ${unifiedMarket.source}`);
  console.log(`   YES 价格: ${unifiedMarket.tokens.yes.price}`);
  console.log(`   NO 价格: ${unifiedMarket.tokens.no.price}`);
  console.log(`   24小时交易量: $${unifiedMarket.volume24hr?.toLocaleString() || 'N/A'}\n`);

  // 6. 获取 K 线
  console.log('6. 获取 K 线数据...');
  const interval: KLineInterval = '1h';
  const klines = await sdk.markets.getKLines(market.conditionId, interval, { limit: 100 });
  console.log(`   生成了 ${klines.length} 根蜡烛图 (${interval} 周期)\n`);

  if (klines.length > 0) {
    console.log('   最后 3 根蜡烛图:');
    for (const candle of klines.slice(-3)) {
      const date = new Date(candle.timestamp).toLocaleString();
      console.log(`   [${date}] 开:${candle.open.toFixed(3)} 高:${candle.high.toFixed(3)} 低:${candle.low.toFixed(3)} 收:${candle.close.toFixed(3)} 量:$${candle.volume.toFixed(0)}`);
    }
  }

  // 7. 获取双代币 K 线
  console.log('\n7. 获取双代币 K 线 (YES + NO)...');
  const dualKlines = await sdk.markets.getDualKLines(market.conditionId, interval, { limit: 100 });
  console.log(`   YES 蜡烛图: ${dualKlines.yes.length}`);
  console.log(`   NO 蜡烛图: ${dualKlines.no.length}`);

  if (dualKlines.spreadAnalysis && dualKlines.spreadAnalysis.length > 0) {
    console.log('\n   价差分析 (最后 3 个):');
    for (const point of dualKlines.spreadAnalysis.slice(-3)) {
      const date = new Date(point.timestamp).toLocaleString();
      console.log(`   [${date}] YES:${point.yesPrice.toFixed(3)} + NO:${point.noPrice.toFixed(3)} = ${point.spread.toFixed(4)} ${point.arbOpportunity}`);
    }
  }

  // 8. 检测市场信号
  console.log('\n8. 检测市场信号...');
  const signals = await sdk.markets.detectMarketSignals(market.conditionId);
  console.log(`   找到 ${signals.length} 个信号:\n`);
  for (const signal of signals.slice(0, 5)) {
    console.log(`   - 类型: ${signal.type}, 严重程度: ${signal.severity}`);
  }

  // 9. 检查套利机会
  console.log('\n9. 检查套利机会...');
  const arb = await sdk.markets.detectArbitrage(market.conditionId, 0.001);
  if (arb) {
    console.log(`   发现套利机会!`);
    console.log(`   类型: ${arb.type}, 利润: ${(arb.profit * 100).toFixed(3)}%`);
    console.log(`   操作: ${arb.action}`);
  } else {
    console.log('   未发现套利机会');
  }

  console.log('\n=== 完成 ===');
}

main().catch(console.error);
