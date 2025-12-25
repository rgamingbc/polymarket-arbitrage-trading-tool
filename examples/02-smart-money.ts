/**
 * 示例 2: 聪明钱分析
 *
 * 本示例演示：
 * - 获取钱包持仓
 * - 获取钱包活动（交易记录）
 * - 获取排行榜数据
 * - 从近期交易中发现活跃钱包
 *
 * 运行: pnpm tsx examples/02-smart-money.ts
 */

import { PolymarketSDK } from '../src/index.js';

async function main() {
  console.log('=== 聪明钱分析 ===\n');

  const sdk = new PolymarketSDK();

  // 1. 获取排行榜
  console.log('1. 获取排行榜 (前10名)...');
  const leaderboard = await sdk.dataApi.getLeaderboard({ limit: 10 });
  console.log(`   总条目数: ${leaderboard.total}`);
  console.log('   前10名交易员:\n');

  for (const entry of leaderboard.entries.slice(0, 10)) {
    console.log(`   #${entry.rank} ${entry.address.slice(0, 8)}...${entry.address.slice(-6)}`);
    console.log(`       盈亏: $${entry.pnl.toLocaleString()}`);
    console.log(`       交易量: $${entry.volume.toLocaleString()}`);
    console.log(`       持仓数: ${entry.positions}, 交易数: ${entry.trades}`);
  }

  // 2. 获取顶级交易员的持仓
  if (leaderboard.entries.length > 0) {
    const topTrader = leaderboard.entries[0].address;
    console.log(`\n2. 获取顶级交易员持仓: ${topTrader.slice(0, 8)}...`);

    const positions = await sdk.dataApi.getPositions(topTrader);
    console.log(`   找到 ${positions.length} 个持仓:\n`);

    for (const pos of positions.slice(0, 5)) {
      console.log(`   - ${pos.title || '未知市场'}`);
      console.log(`     结果: ${pos.outcome}`);
      console.log(`     数量: ${pos.size.toFixed(2)}`);
      console.log(`     平均价格: ${pos.avgPrice.toFixed(4)}`);
      console.log(`     当前价格: ${pos.curPrice?.toFixed(4) || 'N/A'}`);
      console.log(`     盈亏: $${pos.cashPnl?.toFixed(2) || 'N/A'} (${pos.percentPnl?.toFixed(1) || 'N/A'}%)`);
      console.log('');
    }

    // 3. 获取顶级交易员的近期活动
    console.log(`3. 获取顶级交易员的近期活动...`);
    const activity = await sdk.dataApi.getActivity(topTrader, { limit: 10 });
    console.log(`   找到 ${activity.length} 条近期活动:\n`);

    for (const act of activity.slice(0, 5)) {
      const date = new Date(act.timestamp).toLocaleString();
      console.log(`   - [${date}] ${act.type} ${act.side}`);
      console.log(`     数量: ${act.size.toFixed(2)} @ ${act.price.toFixed(4)}`);
      console.log(`     价值: $${(act.usdcSize || 0).toFixed(2)}`);
      console.log(`     结果: ${act.outcome}`);
      console.log('');
    }
  }

  // 4. 从近期交易中发现活跃钱包
  console.log('4. 从近期交易中发现活跃钱包...');
  const recentTrades = await sdk.dataApi.getTrades({ limit: 100 });
  console.log(`   获取了 ${recentTrades.length} 条近期交易`);

  // 统计每个钱包的交易次数
  const walletCounts = new Map<string, number>();
  for (const trade of recentTrades) {
    if (trade.proxyWallet) {
      walletCounts.set(
        trade.proxyWallet,
        (walletCounts.get(trade.proxyWallet) || 0) + 1
      );
    }
  }

  // 按交易次数排序
  const sortedWallets = [...walletCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  console.log('   近期交易最活跃的钱包:\n');
  for (const [wallet, count] of sortedWallets) {
    console.log(`   - ${wallet.slice(0, 8)}...${wallet.slice(-6)}: ${count} 笔交易`);
  }

  console.log('\n=== 完成 ===');
}

main().catch(console.error);
