/**
 * 示例 08: 交易订单
 *
 * 演示所有交易功能：
 * - 限价单 (GTC, GTD)
 * - 市价单 (FOK, FAK)
 * - 订单管理
 * - 价格工具
 * - 奖励追踪
 *
 * 注意：此示例不会执行真实交易。
 * 取消注释订单部分以使用真实资金进行测试。
 */

import {
  TradingClient,
  RateLimiter,
  PolymarketSDK,
  roundPrice,
  validatePrice,
  calculateBuyAmount,
  checkArbitrage,
  formatUSDC,
  type TickSize,
} from '../src/index.js';

// 测试钱包私钥（使用空钱包以确保安全）
const PRIVATE_KEY = process.env.POLYMARKET_PRIVATE_KEY || '0xYOUR_PRIVATE_KEY_HERE';

async function main() {
  console.log('=== Polymarket 交易示例 ===\n');

  // 初始化 SDK 和 TradingClient
  const sdk = new PolymarketSDK();
  const rateLimiter = new RateLimiter();
  const tradingClient = new TradingClient(rateLimiter, {
    privateKey: PRIVATE_KEY,
  });

  // ===== 1. 查找活跃市场 =====
  console.log('1. 查找活跃市场...\n');

  const markets = await sdk.gammaApi.getMarkets({
    closed: false,
    active: true,
    limit: 5,
  });

  if (markets.length === 0) {
    console.log('   未找到活跃市场');
    return;
  }

  const market = markets[0];
  console.log(`   市场: ${market.question?.slice(0, 60)}...`);
  console.log(`   Condition ID: ${market.conditionId}`);

  // 从 CLOB 获取市场详情
  const clobMarket = await sdk.clobApi.getMarket(market.conditionId);
  const yesToken = clobMarket.tokens.find((t) => t.outcome === 'Yes');
  const noToken = clobMarket.tokens.find((t) => t.outcome === 'No');

  if (!yesToken || !noToken) {
    console.log('   找不到代币');
    return;
  }

  console.log(`   YES Token: ${yesToken.tokenId.slice(0, 20)}...`);
  console.log(`   NO Token: ${noToken.tokenId.slice(0, 20)}...`);
  console.log(`   YES 价格: $${yesToken.price}`);
  console.log(`   NO 价格: $${noToken.price}`);

  // ===== 2. 价格工具演示 =====
  console.log('\n2. 价格工具演示\n');

  // 获取市场的最小价格变动
  const tickSize: TickSize = '0.01'; // 大多数市场使用 0.01

  // 将价格四舍五入到最小变动
  const rawPrice = 0.523;
  console.log(`   原始价格: ${rawPrice}`);
  console.log(`   向下取整: ${roundPrice(rawPrice, tickSize, 'floor')}`);
  console.log(`   向上取整: ${roundPrice(rawPrice, tickSize, 'ceil')}`);
  console.log(`   四舍五入: ${roundPrice(rawPrice, tickSize, 'round')}`);

  // 验证价格
  const validation = validatePrice(0.525, tickSize);
  console.log(`   价格 0.525 有效: ${validation.valid}`);

  const invalidValidation = validatePrice(0.5233, tickSize);
  console.log(`   价格 0.5233 有效: ${invalidValidation.valid}`);
  if (!invalidValidation.valid) {
    console.log(`   错误: ${invalidValidation.error}`);
  }

  // 计算订单金额
  const price = 0.52;
  const size = 100;
  const amount = calculateBuyAmount(price, size);
  console.log(`\n   订单: 买入 ${size} YES @ $${price}`);
  console.log(`   成本: ${formatUSDC(amount)}`);

  // ===== 3. 套利检测 =====
  console.log('\n3. 套利检测\n');

  // 获取当前订单簿
  const orderbook = await sdk.clobApi.getProcessedOrderbook(market.conditionId);

  console.log(`   YES: 买价 $${orderbook.yes.bid} / 卖价 $${orderbook.yes.ask}`);
  console.log(`   NO:  买价 $${orderbook.no.bid} / 卖价 $${orderbook.no.ask}`);

  const arb = checkArbitrage(
    orderbook.yes.ask,
    orderbook.no.ask,
    orderbook.yes.bid,
    orderbook.no.bid
  );

  if (arb) {
    console.log(`\n   发现套利机会!`);
    console.log(`   类型: ${arb.type}`);
    console.log(`   利润: ${formatUSDC(arb.profit)}`);
  } else {
    console.log(`   无套利机会`);
    console.log(`   做多成本: $${(orderbook.yes.ask + orderbook.no.ask).toFixed(4)}`);
    console.log(`   做空收益: $${(orderbook.yes.bid + orderbook.no.bid).toFixed(4)}`);
  }

  // ===== 4. 初始化交易客户端 =====
  console.log('\n4. 初始化交易客户端...\n');

  try {
    await tradingClient.initialize();
    console.log(`   钱包: ${tradingClient.getAddress()}`);
    console.log(`   已初始化: ${tradingClient.isInitialized()}`);

    const creds = tradingClient.getCredentials();
    if (creds) {
      console.log(`   API Key: ${creds.key.slice(0, 20)}...`);
    }
  } catch (error) {
    console.log(`   跳过初始化（无有效私钥）`);
    console.log(`   设置 POLYMARKET_PRIVATE_KEY 以测试交易`);
    return;
  }

  // ===== 5. 获取现有订单和交易 =====
  console.log('\n5. 获取现有订单和交易...\n');

  const openOrders = await tradingClient.getOpenOrders();
  console.log(`   未成交订单: ${openOrders.length}`);

  const trades = await tradingClient.getTrades();
  console.log(`   总交易数: ${trades.length}`);

  if (trades.length > 0) {
    console.log('\n   最近交易:');
    for (const t of trades.slice(0, 3)) {
      console.log(`   - ${t.side} ${t.size} @ $${t.price.toFixed(4)}`);
    }
  }

  // ===== 6. 订单类型演示 =====
  console.log('\n6. 订单类型（未执行）\n');

  console.log('   --- 限价单 ---');
  console.log('   GTC (一直有效直到取消):');
  console.log('   - 保持在订单簿上直到成交或取消');
  console.log('   - 最适合在目标价格被动挂单');
  console.log(`
   tradingClient.createOrder({
     tokenId: '${yesToken.tokenId.slice(0, 20)}...',
     side: 'BUY',
     price: 0.45,
     size: 10,
     orderType: 'GTC',
   });
`);

  console.log('   GTD (有效期至指定日期):');
  console.log('   - 在指定时间戳自动过期');
  console.log('   - 适合时间敏感的策略');
  console.log(`
   tradingClient.createOrder({
     tokenId: '${yesToken.tokenId.slice(0, 20)}...',
     side: 'BUY',
     price: 0.45,
     size: 10,
     orderType: 'GTD',
     expiration: Math.floor(Date.now() / 1000) + 3600, // 1小时
   });
`);

  console.log('   --- 市价单 ---');
  console.log('   FOK (全部成交否则取消):');
  console.log('   - 必须全部成交，否则不成交');
  console.log('   - 最适合保证执行');
  console.log(`
   tradingClient.createMarketOrder({
     tokenId: '${yesToken.tokenId.slice(0, 20)}...',
     side: 'BUY',
     amount: 10, // 买入时为 $10 USDC
     orderType: 'FOK',
   });
`);

  console.log('   FAK (成交并取消剩余):');
  console.log('   - 尽可能成交，取消剩余');
  console.log('   - 适合部分成交');
  console.log(`
   tradingClient.createMarketOrder({
     tokenId: '${yesToken.tokenId.slice(0, 20)}...',
     side: 'SELL',
     amount: 10, // 卖出时为 10 份额
     orderType: 'FAK',
   });
`);

  // ===== 7. 奖励演示 =====
  console.log('\n7. 奖励（做市激励）\n');

  try {
    // 获取当前奖励计划
    const rewards = await tradingClient.getCurrentRewards();
    console.log(`   活跃奖励计划: ${rewards.length}`);

    if (rewards.length > 0) {
      const reward = rewards[0];
      console.log(`\n   示例奖励市场:`);
      console.log(`   - 问题: ${reward.question?.slice(0, 50)}...`);
      console.log(`   - 最大价差: ${reward.rewardsMaxSpread}`);
      console.log(`   - 最小数量: ${reward.rewardsMinSize}`);

      if (reward.rewardsConfig.length > 0) {
        const config = reward.rewardsConfig[0];
        console.log(`   - 每日奖励率: ${config.ratePerDay}`);
        console.log(`   - 总奖励池: ${config.totalRewards}`);
      }
    }

    // 检查订单是否在计分（需要实际订单 ID）
    if (openOrders.length > 0) {
      const orderId = openOrders[0].id;
      const isScoring = await tradingClient.isOrderScoring(orderId);
      console.log(`\n   订单 ${orderId.slice(0, 20)}... 计分中: ${isScoring}`);
    }

    // 获取昨天的收益
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().split('T')[0];

    const earnings = await tradingClient.getTotalEarningsForDay(dateStr);
    console.log(`\n   ${dateStr} 的收益:`);
    console.log(`   总计: ${formatUSDC(earnings.totalEarnings)}`);
  } catch (error) {
    console.log(`   奖励数据不可用（需要有效的交易历史）`);
  }

  // ===== 8. 余额检查 =====
  console.log('\n8. 余额检查\n');

  try {
    const balance = await tradingClient.getBalanceAllowance('COLLATERAL');
    console.log(`   USDC 余额: ${balance.balance}`);
    console.log(`   USDC 授权额度: ${balance.allowance}`);
  } catch (error) {
    console.log(`   余额检查失败（需要已初始化的钱包）`);
  }

  console.log('\n=== 示例完成 ===');
  console.log('\n要执行真实交易:');
  console.log('1. 设置 POLYMARKET_PRIVATE_KEY 环境变量');
  console.log('2. 向你的 Polymarket 代理钱包存入 USDC');
  console.log('3. 取消此文件中下单代码的注释');
}

main().catch(console.error);
