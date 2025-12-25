/**
 * 示例 10: CTF（条件代币框架）操作
 *
 * 演示链上 CTF 操作：
 * - Split（拆分）: USDC → YES + NO 代币
 * - Merge（合并）: YES + NO → USDC（用于套利）
 * - Redeem（赎回）: 获胜代币 → USDC（结算后）
 * - 余额查询和 Gas 估算
 *
 * ⚠️ 重要: Polymarket CTF 使用 USDC.e（桥接版本），而非原生 USDC！
 *
 * | 代币         | 地址                                       | CTF 兼容 |
 * |--------------|-------------------------------------------|----------|
 * | USDC.e       | 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174 | ✅ 是    |
 * | 原生 USDC    | 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359 | ❌ 否    |
 *
 * 常见错误：
 * - 区块浏览器/钱包显示 USDC 余额
 * - 但 CTF 操作失败提示"USDC 余额不足"
 * - 这是因为你有原生 USDC，而非 USDC.e
 *
 * 解决方案：
 * - 将原生 USDC 兑换为 USDC.e: SwapService.swap('USDC', 'USDC_E', amount)
 * - 或使用 SwapService.transferUsdcE() 给钱包充值
 * - 使用 CTFClient.checkReadyForCTF() 在操作前验证
 *
 * 重要：这些是真实的链上交易！
 * - 需要 MATIC 支付 Gas 费用
 * - 需要 USDC.e（非原生 USDC）进行拆分操作
 * - 建议先用小额测试
 *
 * 设置环境变量：
 * - POLYMARKET_PRIVATE_KEY: 你的钱包私钥
 * - POLYGON_RPC_URL: （可选）自定义 RPC URL
 */

import {
  CTFClient,
  PolymarketSDK,
  TradingClient,
  RateLimiter,
  CTF_CONTRACT,
  USDC_CONTRACT,
  formatUSDC,
  checkArbitrage,
} from '../src/index.js';

// 配置
const PRIVATE_KEY = process.env.POLYMARKET_PRIVATE_KEY || '0xYOUR_PRIVATE_KEY_HERE';
const RPC_URL = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';

async function main() {
  console.log('=== Polymarket CTF 操作 ===\n');

  // 检查是否设置了私钥
  if (PRIVATE_KEY === '0xYOUR_PRIVATE_KEY_HERE') {
    console.log('警告：未设置私钥！');
    console.log('设置 POLYMARKET_PRIVATE_KEY 环境变量。');
    console.log('\n此示例将展示 CTF 概念而不执行交易。\n');
    await demonstrateConcepts();
    return;
  }

  // 初始化客户端
  const ctf = new CTFClient({
    privateKey: PRIVATE_KEY,
    rpcUrl: RPC_URL,
  });

  const sdk = new PolymarketSDK();
  const rateLimiter = new RateLimiter();

  console.log(`钱包: ${ctf.getAddress()}`);
  console.log(`CTF 合约: ${CTF_CONTRACT}`);
  console.log(`USDC 合约: ${USDC_CONTRACT}\n`);

  // ===== 1. 检查 CTF 就绪状态 =====
  console.log('1. 检查 CTF 就绪状态 (USDC.e + MATIC)...\n');

  try {
    const readiness = await ctf.checkReadyForCTF('10'); // 检查至少 $10 USDC.e
    console.log(`   USDC.e 余额: $${readiness.usdcEBalance}（CTF 需要）`);
    console.log(`   原生 USDC:   $${readiness.nativeUsdcBalance}（CTF 不可用）`);
    console.log(`   MATIC 余额:  ${readiness.maticBalance}（用于 Gas）`);
    console.log(`   CTF 就绪:    ${readiness.ready ? '✅ 是' : '❌ 否'}`);
    if (readiness.suggestion) {
      console.log(`\n   ⚠️  ${readiness.suggestion}`);
    }
  } catch (error) {
    console.log(`   检查就绪状态错误: ${error}`);
  }

  // ===== 2. 查找活跃市场 =====
  console.log('\n2. 查找有套利潜力的活跃市场...\n');

  const markets = await sdk.gammaApi.getMarkets({
    closed: false,
    active: true,
    limit: 10,
  });

  if (markets.length === 0) {
    console.log('   未找到活跃市场');
    return;
  }

  // 查找价差最小的市场（潜在套利）
  let bestMarket = null;
  let bestOrderbook = null;

  for (const market of markets) {
    try {
      const orderbook = await sdk.clobApi.getProcessedOrderbook(market.conditionId);
      const askSum = orderbook.summary.askSum;

      console.log(`   ${market.question?.slice(0, 40)}...`);
      console.log(`   卖价和: ${askSum.toFixed(4)} | 多头套利: ${(orderbook.summary.longArbProfit * 100).toFixed(2)}%`);

      if (!bestOrderbook || askSum < bestOrderbook.summary.askSum) {
        bestMarket = market;
        bestOrderbook = orderbook;
      }
    } catch {
      // 跳过没有订单簿的市场
    }
  }

  if (!bestMarket || !bestOrderbook) {
    console.log('   未找到合适的市场');
    return;
  }

  console.log(`\n   已选择: ${bestMarket.question?.slice(0, 50)}...`);
  console.log(`   Condition ID: ${bestMarket.conditionId}`);

  // ===== 3. 检查代币余额 =====
  console.log('\n3. 检查代币余额...\n');

  try {
    const balances = await ctf.getPositionBalance(bestMarket.conditionId);
    console.log(`   YES 余额: ${balances.yesBalance}`);
    console.log(`   NO 余额: ${balances.noBalance}`);
    console.log(`   YES Position ID: ${balances.yesPositionId.slice(0, 20)}...`);
    console.log(`   NO Position ID: ${balances.noPositionId.slice(0, 20)}...`);
  } catch (error) {
    console.log(`   检查余额错误: ${error}`);
  }

  // ===== 4. 检查市场结算状态 =====
  console.log('\n4. 检查市场结算状态...\n');

  try {
    const resolution = await ctf.getMarketResolution(bestMarket.conditionId);
    console.log(`   已结算: ${resolution.isResolved}`);
    if (resolution.isResolved) {
      console.log(`   获胜结果: ${resolution.winningOutcome}`);
      console.log(`   支付分子: [${resolution.payoutNumerators.join(', ')}]`);
      console.log(`   支付分母: ${resolution.payoutDenominator}`);
    }
  } catch (error) {
    console.log(`   检查结算状态错误: ${error}`);
  }

  // ===== 5. 套利分析 =====
  console.log('\n5. 套利分析...\n');

  const arb = checkArbitrage(
    bestOrderbook.yes.ask,
    bestOrderbook.no.ask,
    bestOrderbook.yes.bid,
    bestOrderbook.no.bid
  );

  if (arb) {
    console.log(`   发现套利机会!`);
    console.log(`   类型: ${arb.type.toUpperCase()}`);
    console.log(`   利润: ${(arb.profit * 100).toFixed(2)}%`);

    if (arb.type === 'long') {
      console.log(`\n   策略（多头套利）:`);
      console.log(`   1. 买 YES @ $${bestOrderbook.yes.ask.toFixed(4)}`);
      console.log(`   2. 买 NO @ $${bestOrderbook.no.ask.toFixed(4)}`);
      console.log(`   3. CTF 合并 → 每对 1 USDC`);
      console.log(`   总成本: $${bestOrderbook.summary.askSum.toFixed(4)} 每对`);
      console.log(`   利润: $${arb.profit.toFixed(4)} 每对`);
    } else {
      console.log(`\n   策略（空头套利）:`);
      console.log(`   1. CTF 拆分 $1 USDC → 1 YES + 1 NO`);
      console.log(`   2. 卖 YES @ $${bestOrderbook.yes.bid.toFixed(4)}`);
      console.log(`   3. 卖 NO @ $${bestOrderbook.no.bid.toFixed(4)}`);
      console.log(`   总收入: $${bestOrderbook.summary.bidSum.toFixed(4)} 每对`);
      console.log(`   利润: $${arb.profit.toFixed(4)} 每对`);
    }
  } else {
    console.log(`   无套利机会`);
    console.log(`   卖价和: $${bestOrderbook.summary.askSum.toFixed(4)}（多头套利需 < $1）`);
    console.log(`   买价和: $${bestOrderbook.summary.bidSum.toFixed(4)}（空头套利需 > $1）`);
  }

  // ===== 6. Gas 估算 =====
  console.log('\n6. Gas 估算...\n');

  try {
    const splitGas = await ctf.estimateSplitGas(bestMarket.conditionId, '100');
    const mergeGas = await ctf.estimateMergeGas(bestMarket.conditionId, '100');
    console.log(`   拆分 100 USDC: ~${splitGas} gas`);
    console.log(`   合并 100 对: ~${mergeGas} gas`);
    console.log(`   按 ~30 gwei 计算，每次操作约 $${(parseInt(splitGas) * 30 / 1e9 * 0.5).toFixed(4)}`);
  } catch (error) {
    console.log(`   Gas 估算错误: ${error}`);
  }

  // ===== 7. CTF 操作示例（未执行）=====
  console.log('\n7. CTF 操作示例（未执行）\n');

  console.log('   --- 拆分（USDC → 代币）---');
  console.log(`
   // 拆分 100 USDC 为 100 YES + 100 NO
   const splitResult = await ctf.split(conditionId, '100');
   console.log(\`TX: \${splitResult.txHash}\`);
   console.log(\`创建了 \${splitResult.yesTokens} YES + \${splitResult.noTokens} NO\`);
`);

  console.log('   --- 合并（代币 → USDC）---');
  console.log(`
   // 合并 100 YES + 100 NO → 100 USDC
   const mergeResult = await ctf.merge(conditionId, '100');
   console.log(\`TX: \${mergeResult.txHash}\`);
   console.log(\`收到 \${mergeResult.usdcReceived} USDC\`);
`);

  console.log('   --- 赎回（结算后）---');
  console.log(`
   // 市场结算后赎回获胜代币
   const redeemResult = await ctf.redeem(conditionId);
   console.log(\`TX: \${redeemResult.txHash}\`);
   console.log(\`赎回了 \${redeemResult.tokensRedeemed} \${redeemResult.outcome}\`);
   console.log(\`收到 \${redeemResult.usdcReceived} USDC\`);
`);

  // ===== 8. 完整套利流程 =====
  console.log('8. 完整套利流程示例\n');

  console.log(`
   // 假设存在多头套利机会
   // 1. 通过 TradingClient 买入 YES 代币
   const yesOrder = await tradingClient.createMarketOrder({
     tokenId: yesTokenId,
     side: 'BUY',
     amount: 100, // $100 USDC
     orderType: 'FOK',
   });

   // 2. 通过 TradingClient 买入 NO 代币
   const noOrder = await tradingClient.createMarketOrder({
     tokenId: noTokenId,
     side: 'BUY',
     amount: 100, // $100 USDC
     orderType: 'FOK',
   });

   // 3. 通过 CTFClient 合并代币
   // 计算 min(yesTokens, noTokens) 来合并
   const tokensToMerge = Math.min(yesTokensReceived, noTokensReceived);
   const mergeResult = await ctf.merge(conditionId, tokensToMerge.toString());

   // 4. 利润 = 收到的 USDC - 总支出
   console.log(\`利润: \${mergeResult.usdcReceived - totalSpent}\`);
`);

  console.log('\n=== 示例完成 ===');
}

async function demonstrateConcepts() {
  console.log('--- CTF 概念演示 ---\n');

  console.log('Polymarket 使用 Gnosis 条件代币框架 (CTF)。\n');

  console.log('核心操作：');
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log('│ 拆分:  $1 USDC  →  1 YES 代币  +  1 NO 代币               │');
  console.log('│ 合并:  1 YES + 1 NO  →  $1 USDC                           │');
  console.log('│ 赎回: 结算后，获胜代币 → 每个 $1 USDC                      │');
  console.log('└─────────────────────────────────────────────────────────────┘\n');

  console.log('套利用例：');
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log('│ 多头套利（卖价和 < $1）:                                    │');
  console.log('│   1. 买 YES @ $0.48 + NO @ $0.50 = $0.98 成本              │');
  console.log('│   2. CTF 合并 → $1 USDC                                   │');
  console.log('│   3. 利润: 每对 $0.02 (2%)                                 │');
  console.log('├─────────────────────────────────────────────────────────────┤');
  console.log('│ 空头套利（买价和 > $1）:                                    │');
  console.log('│   1. CTF 拆分 $1 → 1 YES + 1 NO                           │');
  console.log('│   2. 卖 YES @ $0.52 + NO @ $0.50 = $1.02 收入              │');
  console.log('│   3. 利润: 每对 $0.02 (2%)                                 │');
  console.log('└─────────────────────────────────────────────────────────────┘\n');

  console.log('做市用例：');
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log('│ 如果你卖出太多 YES 代币需要补仓:                            │');
  console.log('│   1. CTF 拆分 $1000 → 1000 YES + 1000 NO                  │');
  console.log('│   2. 在市场上卖出 NO 代币                                   │');
  console.log('│   3. 使用 YES 代币继续做市                                  │');
  console.log('└─────────────────────────────────────────────────────────────┘\n');

  console.log('合约地址（Polygon）：');
  console.log(`  CTF:  ${CTF_CONTRACT}`);
  console.log(`  USDC: ${USDC_CONTRACT}\n`);

  console.log('Gas 成本：');
  console.log('  拆分/合并/赎回: ~200,000-300,000 gas');
  console.log('  按 ~30 gwei 计算，每次操作约 $0.003-0.005\n');

  console.log('⚠️  重要: USDC.e vs 原生 USDC');
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log('│ Polymarket CTF 只接受 USDC.e（桥接 USDC）                   │');
  console.log('│                                                             │');
  console.log('│ USDC.e:      0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174 ✅  │');
  console.log('│ 原生 USDC:   0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359 ❌  │');
  console.log('│                                                             │');
  console.log('│ 如果你有原生 USDC，请先兑换为 USDC.e:                        │');
  console.log('│   SwapService.swap("USDC", "USDC_E", amount)               │');
  console.log('│                                                             │');
  console.log('│ 为 CTF 给钱包充值时，使用:                                   │');
  console.log('│   SwapService.transferUsdcE(to, amount)                    │');
  console.log('└─────────────────────────────────────────────────────────────┘\n');

  console.log('要运行实际 CTF 操作：');
  console.log('  1. 设置 POLYMARKET_PRIVATE_KEY 环境变量');
  console.log('  2. 确保钱包在 Polygon 上有 USDC.e（非原生 USDC！）');
  console.log('  3. 确保钱包有 MATIC 支付 Gas');
  console.log('  4. 再次运行此示例\n');
}

main().catch(console.error);
