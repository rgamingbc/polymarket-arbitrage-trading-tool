/**
 * 示例 09: 做市商奖励追踪
 *
 * 演示如何：
 * - 查找高奖励市场
 * - 检查订单是否在计分
 * - 追踪每日收益
 * - 优化以获取最大奖励
 *
 * 注意：需要有交易历史的钱包才能查看收益。
 */

import {
  TradingClient,
  RateLimiter,
  PolymarketSDK,
  formatUSDC,
} from '../src/index.js';

// 测试钱包私钥
const PRIVATE_KEY = process.env.POLYMARKET_PRIVATE_KEY || '0xYOUR_PRIVATE_KEY_HERE';

async function main() {
  console.log('=== Polymarket 奖励追踪 ===\n');

  const sdk = new PolymarketSDK();
  const rateLimiter = new RateLimiter();
  const tradingClient = new TradingClient(rateLimiter, {
    privateKey: PRIVATE_KEY,
  });

  // ===== 1. 获取有活跃奖励的市场 =====
  console.log('1. 查找有活跃奖励的市场...\n');

  try {
    await tradingClient.initialize();
    console.log(`   钱包: ${tradingClient.getAddress()}\n`);

    const rewards = await tradingClient.getCurrentRewards();
    console.log(`   找到 ${rewards.length} 个有活跃奖励的市场\n`);

    if (rewards.length > 0) {
      console.log('   前 5 个奖励市场:');
      console.log('   ' + '─'.repeat(70));

      for (const reward of rewards.slice(0, 5)) {
        console.log(`\n   市场: ${reward.question?.slice(0, 50)}...`);
        console.log(`   Slug: ${reward.marketSlug}`);
        console.log(`   最大价差: ${reward.rewardsMaxSpread}`);
        console.log(`   最小数量: ${reward.rewardsMinSize}`);

        if (reward.rewardsConfig.length > 0) {
          const config = reward.rewardsConfig[0];
          console.log(`   每日奖励率: ${config.ratePerDay}`);
          console.log(`   总奖励池: ${config.totalRewards}`);
          console.log(`   期间: ${config.startDate} 到 ${config.endDate}`);
        }

        // 显示代币价格
        if (reward.tokens.length > 0) {
          const yesToken = reward.tokens.find(t => t.outcome === 'Yes');
          const noToken = reward.tokens.find(t => t.outcome === 'No');
          if (yesToken && noToken) {
            console.log(`   YES 价格: $${yesToken.price.toFixed(2)} | NO 价格: $${noToken.price.toFixed(2)}`);
          }
        }
      }
      console.log('\n   ' + '─'.repeat(70));
    }

    // ===== 2. 检查订单计分状态 =====
    console.log('\n2. 检查订单是否在计分...\n');

    const openOrders = await tradingClient.getOpenOrders();
    console.log(`   未成交订单: ${openOrders.length}`);

    if (openOrders.length > 0) {
      console.log('\n   订单计分状态:');

      // 检查前 5 个订单
      for (const order of openOrders.slice(0, 5)) {
        const isScoring = await tradingClient.isOrderScoring(order.id);
        const status = isScoring ? '✅ 计分中' : '❌ 未计分';
        console.log(`   - ${order.side} ${order.originalSize} @ $${order.price.toFixed(4)}: ${status}`);
      }

      // 批量检查
      if (openOrders.length > 1) {
        const orderIds = openOrders.slice(0, 5).map(o => o.id);
        const scoringStatus = await tradingClient.areOrdersScoring(orderIds);
        const scoringCount = Object.values(scoringStatus).filter(Boolean).length;
        console.log(`\n   总结: ${scoringCount}/${orderIds.length} 个订单在计分`);
      }
    } else {
      console.log('   没有未成交订单。下限价单以获取奖励。');
    }

    // ===== 3. 追踪收益 =====
    console.log('\n3. 追踪收益...\n');

    // 获取过去 7 天的收益
    const dates: string[] = [];
    for (let i = 1; i <= 7; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      dates.push(date.toISOString().split('T')[0]);
    }

    console.log('   每日收益（过去 7 天）:');
    console.log('   ' + '─'.repeat(40));

    let totalWeeklyEarnings = 0;

    for (const date of dates) {
      try {
        const earnings = await tradingClient.getTotalEarningsForDay(date);
        totalWeeklyEarnings += earnings.totalEarnings;

        if (earnings.totalEarnings > 0) {
          console.log(`   ${date}: ${formatUSDC(earnings.totalEarnings)}`);
        } else {
          console.log(`   ${date}: $0.00`);
        }
      } catch {
        console.log(`   ${date}: (无数据)`);
      }
    }

    console.log('   ' + '─'.repeat(40));
    console.log(`   周总计: ${formatUSDC(totalWeeklyEarnings)}`);

    // ===== 4. 获取奖励百分比 =====
    console.log('\n4. 市场奖励百分比...\n');

    try {
      const percentages = await tradingClient.getRewardPercentages();
      const entries = Object.entries(percentages);

      if (entries.length > 0) {
        console.log('   按奖励百分比排名的顶级市场:');

        // 按百分比降序排序
        const sorted = entries.sort((a, b) => b[1] - a[1]).slice(0, 10);

        for (const [market, percentage] of sorted) {
          console.log(`   - ${market.slice(0, 30)}...: ${(percentage * 100).toFixed(2)}%`);
        }
      } else {
        console.log('   没有可用的奖励百分比');
      }
    } catch (error) {
      console.log('   奖励百分比不可用');
    }

    // ===== 5. 检查余额 =====
    console.log('\n5. 账户余额...\n');

    try {
      const balance = await tradingClient.getBalanceAllowance('COLLATERAL');
      console.log(`   USDC 余额: ${balance.balance}`);
      console.log(`   USDC 授权额度: ${balance.allowance}`);
    } catch {
      console.log('   余额检查不可用');
    }

    // ===== 6. 奖励优化技巧 =====
    console.log('\n6. 奖励优化技巧\n');
    console.log('   ┌─────────────────────────────────────────────────────────────┐');
    console.log('   │ 如何最大化做市奖励:                                         │');
    console.log('   ├─────────────────────────────────────────────────────────────┤');
    console.log('   │ 1. 保持订单在中间价的最大价差范围内                          │');
    console.log('   │ 2. 维持最小数量（检查 rewardsMinSize）                       │');
    console.log('   │ 3. 双边报价（YES 和 NO）以获得更高分数                       │');
    console.log('   │ 4. 全天保持活跃（奖励每分钟采样）                            │');
    console.log('   │ 5. 专注于每日奖励率更高的市场                                │');
    console.log('   │ 6. 避免大价差 - 越紧凑分数越高                               │');
    console.log('   └─────────────────────────────────────────────────────────────┘');

  } catch (error) {
    console.log(`   初始化失败: ${error}`);
    console.log('   设置 POLYMARKET_PRIVATE_KEY 以访问奖励数据');
  }

  console.log('\n=== 示例完成 ===');
}

main().catch(console.error);
