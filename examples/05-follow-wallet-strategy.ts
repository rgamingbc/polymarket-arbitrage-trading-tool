/**
 * 示例 5: 跟单钱包策略
 *
 * 本示例演示：
 * - 追踪聪明钱钱包的持仓
 * - 检测卖出活动（作为退出信号）
 * - 计算持仓退出的卖出比例
 *
 * 运行: pnpm tsx examples/05-follow-wallet-strategy.ts
 */

import { PolymarketSDK, type Position, type Activity } from '../src/index.js';

interface WalletPositionTracker {
  address: string;
  position: Position;
  entryTimestamp: number;
  peakValue: number;
  cumulativeSellAmount: number;
  sellRatio: number;
}

async function detectSellActivity(
  sdk: PolymarketSDK,
  address: string,
  conditionId: string,
  sinceTimestamp: number
): Promise<{ totalSellAmount: number; sellTransactions: Activity[] }> {
  const activities = await sdk.dataApi.getActivity(address, { limit: 200, type: 'TRADE' });

  const sellTransactions = activities.filter(
    (a) =>
      a.conditionId === conditionId &&
      a.side === 'SELL' &&
      a.timestamp >= sinceTimestamp
  );

  const totalSellAmount = sellTransactions.reduce(
    (sum, a) => sum + (a.usdcSize || a.size * a.price),
    0
  );

  return { totalSellAmount, sellTransactions };
}

async function main() {
  console.log('=== 跟单钱包策略 ===\n');

  const sdk = new PolymarketSDK();

  // 1. 从排行榜获取顶级交易员
  console.log('1. 从排行榜获取顶级交易员...');
  const leaderboard = await sdk.dataApi.getLeaderboard({ limit: 5 });
  console.log(`   找到 ${leaderboard.entries.length} 名顶级交易员\n`);

  if (leaderboard.entries.length === 0) {
    console.log('未找到排行榜条目');
    return;
  }

  // 2. 选择要跟随的交易员
  const traderToFollow = leaderboard.entries[0];
  console.log(`2. 跟随交易员: ${traderToFollow.address.slice(0, 10)}...`);
  console.log(`   排名: #${traderToFollow.rank}`);
  console.log(`   盈亏: $${traderToFollow.pnl.toLocaleString()}\n`);

  // 3. 获取其持仓
  console.log('3. 获取持仓...');
  const positions = await sdk.dataApi.getPositions(traderToFollow.address);
  console.log(`   找到 ${positions.length} 个持仓\n`);

  if (positions.length === 0) {
    console.log('此交易员没有持仓');
    return;
  }

  // 4. 分析每个持仓的卖出活动
  console.log('4. 分析持仓的卖出活动...\n');

  const trackers: WalletPositionTracker[] = [];
  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  for (const position of positions.slice(0, 5)) {
    console.log(`   检查: ${position.title.slice(0, 50)}...`);

    try {
      // 获取一周以来的卖出活动
      const sellData = await detectSellActivity(
        sdk,
        traderToFollow.address,
        position.conditionId,
        oneWeekAgo
      );

      // 计算峰值价值（当前价值 + 卖出额）
      const currentValue = position.currentValue || position.size * (position.curPrice || position.avgPrice);
      const peakValue = currentValue + sellData.totalSellAmount;

      // 计算卖出比例
      const sellRatio = peakValue > 0 ? sellData.totalSellAmount / peakValue : 0;

      trackers.push({
        address: traderToFollow.address,
        position,
        entryTimestamp: oneWeekAgo, // 近似值
        peakValue,
        cumulativeSellAmount: sellData.totalSellAmount,
        sellRatio,
      });

      console.log(`     当前价值: $${currentValue.toFixed(2)}`);
      console.log(`     累计卖出: $${sellData.totalSellAmount.toFixed(2)}`);
      console.log(`     估计峰值: $${peakValue.toFixed(2)}`);
      console.log(`     卖出比例: ${(sellRatio * 100).toFixed(1)}%`);

      // 检查是否达到 30% 阈值
      if (sellRatio >= 0.3) {
        console.log(`     ** 退出信号: 卖出比例 >= 30% **`);
      }
      console.log('');

    } catch (error) {
      console.log(`     错误: ${(error as Error).message}\n`);
    }
  }

  // 5. 总结
  console.log('=== 跟单钱包总结 ===\n');
  console.log(`交易员: ${traderToFollow.address.slice(0, 10)}...`);
  console.log(`分析的持仓: ${trackers.length}\n`);

  const exitSignals = trackers.filter((t) => t.sellRatio >= 0.3);
  if (exitSignals.length > 0) {
    console.log(`退出信号 (${exitSignals.length}):`);
    for (const signal of exitSignals) {
      console.log(`  - ${signal.position.title.slice(0, 40)}...`);
      console.log(`    卖出比例: ${(signal.sellRatio * 100).toFixed(1)}%`);
    }
  } else {
    console.log('未检测到退出信号');
  }

  const holdingStrong = trackers.filter((t) => t.sellRatio < 0.1);
  if (holdingStrong.length > 0) {
    console.log(`\n坚定持有 (卖出比例 < 10%):`);
    for (const hold of holdingStrong) {
      console.log(`  - ${hold.position.title.slice(0, 40)}...`);
      console.log(`    结果: ${hold.position.outcome}`);
      console.log(`    盈亏: $${hold.position.cashPnl?.toFixed(2) || 'N/A'}`);
    }
  }

  console.log('\n=== 完成 ===');
}

main().catch(console.error);
