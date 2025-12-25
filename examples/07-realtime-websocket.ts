/**
 * 示例 7: 实时 WebSocket
 *
 * 本示例演示实时价格更新：
 * - WebSocketManager 用于底层访问
 * - RealtimeService 用于订阅管理
 *
 * 运行: pnpm tsx examples/07-realtime-websocket.ts
 */

import { PolymarketSDK } from '../src/index.js';
import { WebSocketManager } from '../src/clients/websocket-manager.js';
import { RealtimeService } from '../src/services/realtime-service.js';

async function main() {
  console.log('=== 实时 WebSocket 演示 ===\n');

  const sdk = new PolymarketSDK();

  // 1. 获取要订阅的热门市场
  console.log('1. 获取热门市场...');
  const trendingMarkets = await sdk.markets.getTrendingMarkets(1);
  if (trendingMarkets.length === 0) {
    console.log('未找到热门市场');
    return;
  }

  const market = trendingMarkets[0];
  console.log(`   市场: ${market.question.slice(0, 60)}...`);
  console.log(`   Condition ID: ${market.conditionId}\n`);

  // 2. 获取市场详情以获取 token ID
  console.log('2. 获取市场详情...');
  const unifiedMarket = await sdk.markets.getMarket(market.conditionId);
  const yesTokenId = unifiedMarket.tokens.yes.tokenId;
  const noTokenId = unifiedMarket.tokens.no.tokenId;
  console.log(`   YES Token: ${yesTokenId.slice(0, 20)}...`);
  console.log(`   NO Token: ${noTokenId.slice(0, 20)}...`);
  console.log(`   当前 YES 价格: ${unifiedMarket.tokens.yes.price}`);
  console.log(`   当前 NO 价格: ${unifiedMarket.tokens.no.price}\n`);

  if (!yesTokenId || !noTokenId) {
    console.log('此市场没有可用的 token ID');
    return;
  }

  // 3. 创建 RealtimeService 并订阅
  console.log('3. 订阅实时更新...');
  const wsManager = new WebSocketManager({ enableLogging: true });
  const realtime = new RealtimeService(wsManager);

  let updateCount = 0;
  const maxUpdates = 10;

  const subscription = await realtime.subscribeMarket(yesTokenId, noTokenId, {
    onPriceUpdate: (update) => {
      updateCount++;
      const side = update.assetId === yesTokenId ? 'YES' : 'NO';
      console.log(`   [${new Date().toLocaleTimeString()}] ${side} 价格: ${update.price.toFixed(4)} (中间价: ${update.midpoint.toFixed(4)}, 价差: ${update.spread.toFixed(4)})`);
    },
    onBookUpdate: (update) => {
      const side = update.assetId === yesTokenId ? 'YES' : 'NO';
      const bestBid = update.bids[0];
      const bestAsk = update.asks[0];
      console.log(`   [${new Date().toLocaleTimeString()}] ${side} 盘口: 买 ${bestBid?.price.toFixed(4)} (${bestBid?.size.toFixed(0)}) | 卖 ${bestAsk?.price.toFixed(4)} (${bestAsk?.size.toFixed(0)})`);
    },
    onLastTrade: (trade) => {
      const side = trade.assetId === yesTokenId ? 'YES' : 'NO';
      console.log(`   [${new Date().toLocaleTimeString()}] ${side} 成交: ${trade.side} ${trade.size} @ ${trade.price.toFixed(4)}`);
    },
    onPairUpdate: (update) => {
      const spread = update.spread;
      const arbSignal = spread < 0.99 ? '🔴 套利!' : spread > 1.01 ? '🔴 套利!' : '✅';
      console.log(`   [${new Date().toLocaleTimeString()}] 组合: YES ${update.yes.price.toFixed(4)} + NO ${update.no.price.toFixed(4)} = ${spread.toFixed(4)} ${arbSignal}`);
    },
    onError: (error) => {
      console.error(`   错误: ${error.message}`);
    },
  });

  console.log(`   订阅 ID: ${subscription.id}`);
  console.log(`   已订阅: ${subscription.assetIds.length} 个资产`);
  console.log(`\n   等待更新 (最多 ${maxUpdates} 个)...\n`);

  // 4. 等待一些更新
  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      if (updateCount >= maxUpdates) {
        clearInterval(interval);
        resolve();
      }
    }, 500);

    // 30 秒后超时
    setTimeout(() => {
      clearInterval(interval);
      resolve();
    }, 30000);
  });

  // 5. 检查缓存的价格
  console.log('\n4. 缓存的价格:');
  const prices = realtime.getAllPrices();
  for (const [assetId, price] of prices) {
    const side = assetId === yesTokenId ? 'YES' : 'NO';
    console.log(`   ${side}: ${price.price.toFixed(4)}`);
  }

  // 6. 清理
  console.log('\n5. 清理中...');
  await subscription.unsubscribe();
  console.log('   已取消订阅');

  console.log('\n=== 完成 ===');
}

main().catch(console.error);
