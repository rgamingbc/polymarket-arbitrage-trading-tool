#!/usr/bin/env npx tsx
/**
 * 示例 13: ArbitrageService - 完整工作流
 *
 * 演示完整的套利工作流：
 * 1. 扫描市场寻找机会
 * 2. 启动实时监控
 * 3. 自动执行套利
 * 4. 停止并清理仓位
 *
 * 环境变量：
 *   POLY_PRIVKEY - 交易私钥（仅扫描模式可选）
 *
 * 运行：
 *   pnpm example:arb-service
 *
 * 或仅扫描（不交易）：
 *   npx tsx examples/13-arbitrage-service.ts --scan-only
 */

import { ArbitrageService } from '../src/index.js';

// 解析参数
const args = process.argv.slice(2);
const SCAN_ONLY = args.includes('--scan-only');
const RUN_DURATION = parseInt(args.find(a => a.startsWith('--duration='))?.split('=')[1] || '60') * 1000; // 默认 60s

async function main() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║              ArbitrageService - 完整工作流                      ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log();

  const privateKey = process.env.POLY_PRIVKEY;

  if (!privateKey && !SCAN_ONLY) {
    console.log('未提供 POLY_PRIVKEY。以仅扫描模式运行。\n');
  }

  // ========== 初始化 ArbitrageService ==========
  const arbService = new ArbitrageService({
    privateKey: SCAN_ONLY ? undefined : privateKey,
    profitThreshold: 0.005,  // 0.5% 最小利润
    minTradeSize: 5,         // $5 最小交易
    maxTradeSize: 100,       // $100 最大交易
    autoExecute: !SCAN_ONLY && !!privateKey,
    enableLogging: true,

    // 再平衡配置
    enableRebalancer: !SCAN_ONLY && !!privateKey,
    minUsdcRatio: 0.2,
    maxUsdcRatio: 0.8,
    targetUsdcRatio: 0.5,
    imbalanceThreshold: 5,
    rebalanceInterval: 10000,
    rebalanceCooldown: 30000,

    // 执行安全
    sizeSafetyFactor: 0.8,
    autoFixImbalance: true,
  });

  // ========== 设置事件监听器 ==========
  arbService.on('opportunity', (opp) => {
    console.log(`\n🎯 ${opp.type.toUpperCase()} 套利: ${opp.profitPercent.toFixed(2)}%`);
    console.log(`   ${opp.description}`);
    console.log(`   推荐数量: ${opp.recommendedSize.toFixed(2)}, 预估利润: $${opp.estimatedProfit.toFixed(2)}`);
  });

  arbService.on('execution', (result) => {
    if (result.success) {
      console.log(`\n✅ 执行成功!`);
      console.log(`   类型: ${result.type}, 数量: ${result.size.toFixed(2)}`);
      console.log(`   利润: $${result.profit.toFixed(2)}`);
      console.log(`   耗时: ${result.executionTimeMs}ms`);
    } else {
      console.log(`\n❌ 执行失败: ${result.error}`);
    }
  });

  arbService.on('rebalance', (result) => {
    if (result.success) {
      console.log(`\n🔄 再平衡: ${result.action.type} ${result.action.amount.toFixed(2)}`);
      console.log(`   原因: ${result.action.reason}`);
    } else {
      console.log(`\n⚠️ 再平衡失败: ${result.error}`);
    }
  });

  arbService.on('balanceUpdate', (balance) => {
    console.log(`\n💰 余额: USDC=${balance.usdc.toFixed(2)}, YES=${balance.yesTokens.toFixed(2)}, NO=${balance.noTokens.toFixed(2)}`);
  });

  arbService.on('error', (error) => {
    console.error(`\n🚨 错误: ${error.message}`);
  });

  // ========== 步骤 1: 扫描市场 ==========
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('步骤 1: 扫描市场寻找套利机会...');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const scanResults = await arbService.scanMarkets(
    { minVolume24h: 5000, limit: 50 },
    0.003  // 0.3% 扫描最小利润
  );

  const opportunities = scanResults.filter(r => r.arbType !== 'none');

  console.log(`\n在 ${scanResults.length} 个扫描的市场中找到 ${opportunities.length} 个机会\n`);

  if (opportunities.length > 0) {
    console.log('前 5 个机会:');
    console.log('┌──────────────────────────────────────────────────────────────────┐');
    for (const r of opportunities.slice(0, 5)) {
      console.log(`│ ${r.market.name.slice(0, 50).padEnd(50)} │`);
      console.log(`│   ${r.arbType.toUpperCase()} +${r.profitPercent.toFixed(2)}%  数量: ${r.availableSize.toFixed(0)}  交易量: $${r.volume24h.toLocaleString().padEnd(10)} │`);
      console.log(`├──────────────────────────────────────────────────────────────────┤`);
    }
    console.log('└──────────────────────────────────────────────────────────────────┘');
  }

  if (SCAN_ONLY || opportunities.length === 0) {
    console.log('\n✅ 扫描完成。');
    if (SCAN_ONLY) {
      console.log('   （以仅扫描模式运行，不启动套利）');
    }
    if (opportunities.length === 0) {
      console.log('   （未找到有利可图的机会）');
    }
    return;
  }

  // ========== 步骤 2: 启动套利 ==========
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('步骤 2: 在最佳市场启动套利...');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const best = opportunities[0];
  console.log(`已选择: ${best.market.name}`);
  console.log(`类型: ${best.arbType.toUpperCase()}, 利润: +${best.profitPercent.toFixed(2)}%\n`);

  await arbService.start(best.market);

  // ========== 步骤 3: 运行指定时长 ==========
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`步骤 3: 运行 ${RUN_DURATION / 1000} 秒...`);
  console.log('═══════════════════════════════════════════════════════════════\n');
  console.log('监控套利机会...');
  console.log('（按 Ctrl+C 提前停止）\n');

  // 处理优雅关闭
  let stopped = false;
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    console.log('\n\n正在关闭...');
    await cleanup();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // 等待指定时长
  await new Promise(resolve => setTimeout(resolve, RUN_DURATION));

  // ========== 步骤 4: 停止并清理 ==========
  async function cleanup() {
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('步骤 4: 停止并清理仓位...');
    console.log('═══════════════════════════════════════════════════════════════\n');

    await arbService.stop();

    // 打印统计
    const stats = arbService.getStats();
    console.log('会话统计:');
    console.log(`  检测到的机会: ${stats.opportunitiesDetected}`);
    console.log(`  尝试执行次数: ${stats.executionsAttempted}`);
    console.log(`  成功执行次数: ${stats.executionsSucceeded}`);
    console.log(`  总利润: $${stats.totalProfit.toFixed(2)}`);
    console.log(`  运行时间: ${(stats.runningTimeMs / 1000).toFixed(0)}s`);

    // 清理仓位
    if (privateKey) {
      console.log('\n清理仓位...');
      const clearResult = await arbService.clearPositions(best.market, false);

      console.log(`\n仓位状态:`);
      console.log(`  市场状态: ${clearResult.marketStatus}`);
      console.log(`  YES 余额: ${clearResult.yesBalance.toFixed(4)}`);
      console.log(`  NO 余额: ${clearResult.noBalance.toFixed(4)}`);
      console.log(`  预期回收: $${clearResult.totalUsdcRecovered.toFixed(2)}`);

      if (clearResult.actions.length > 0) {
        console.log(`\n计划操作:`);
        for (const action of clearResult.actions) {
          console.log(`  - ${action.type}: ${action.amount.toFixed(4)} → ~$${action.usdcResult.toFixed(2)}`);
        }
        console.log('\n（使用 --execute-clear 实际清理仓位）');
      }
    }

    console.log('\n✅ 完成!');
  }

  await cleanup();
}

main().catch(console.error);
