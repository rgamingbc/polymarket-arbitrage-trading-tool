/**
 * 示例 4: 从交易数据聚合 K 线
 *
 * 本示例演示：
 * - 获取市场的交易历史
 * - 将交易聚合为 K 线（OHLCV）蜡烛图
 * - 计算双代币 K 线（YES + NO）
 *
 * 运行: pnpm tsx examples/04-kline-aggregation.ts
 */

import { PolymarketSDK, type Trade, type KLineInterval, getIntervalMs } from '../src/index.js';

interface KLineCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradeCount: number;
  buyVolume: number;
  sellVolume: number;
}

function aggregateToKLines(trades: Trade[], interval: KLineInterval): KLineCandle[] {
  const intervalMs = getIntervalMs(interval);
  const buckets = new Map<number, Trade[]>();

  // 将交易分组到时间桶中
  for (const trade of trades) {
    const bucketTime = Math.floor(trade.timestamp / intervalMs) * intervalMs;
    const bucket = buckets.get(bucketTime) || [];
    bucket.push(trade);
    buckets.set(bucketTime, bucket);
  }

  // 将桶转换为蜡烛图
  const candles: KLineCandle[] = [];
  for (const [timestamp, bucketTrades] of buckets) {
    if (bucketTrades.length === 0) continue;

    // 按时间戳排序以获取正确的开盘/收盘价
    bucketTrades.sort((a, b) => a.timestamp - b.timestamp);

    const prices = bucketTrades.map((t) => t.price);
    const buyTrades = bucketTrades.filter((t) => t.side === 'BUY');
    const sellTrades = bucketTrades.filter((t) => t.side === 'SELL');

    candles.push({
      timestamp,
      open: bucketTrades[0].price,
      high: Math.max(...prices),
      low: Math.min(...prices),
      close: bucketTrades[bucketTrades.length - 1].price,
      volume: bucketTrades.reduce((sum, t) => sum + t.size * t.price, 0),
      tradeCount: bucketTrades.length,
      buyVolume: buyTrades.reduce((sum, t) => sum + t.size * t.price, 0),
      sellVolume: sellTrades.reduce((sum, t) => sum + t.size * t.price, 0),
    });
  }

  return candles.sort((a, b) => a.timestamp - b.timestamp);
}

async function main() {
  console.log('=== 从交易数据聚合 K 线 ===\n');

  const sdk = new PolymarketSDK();

  // 1. 获取热门市场
  console.log('1. 获取热门市场...');
  const markets = await sdk.gammaApi.getTrendingMarkets(1);

  if (markets.length === 0) {
    console.log('未找到热门市场');
    return;
  }

  const market = markets[0];
  console.log(`   已选择: ${market.question}`);
  console.log(`   Condition ID: ${market.conditionId}\n`);

  // 2. 获取交易历史
  console.log('2. 获取交易历史...');
  const trades = await sdk.dataApi.getTradesByMarket(market.conditionId, 500);
  console.log(`   找到 ${trades.length} 笔交易\n`);

  if (trades.length === 0) {
    console.log('此市场没有交易记录');
    return;
  }

  // 3. 获取代币信息
  console.log('3. 获取代币信息...');
  const unifiedMarket = await sdk.getMarket(market.conditionId);
  console.log(`   YES Token: ${unifiedMarket.tokens.yes.tokenId.slice(0, 16)}...`);
  console.log(`   NO Token: ${unifiedMarket.tokens.no.tokenId.slice(0, 16)}...\n`);

  // 4. 按代币分离交易（YES vs NO）
  const yesTrades = trades.filter((t) => t.outcomeIndex === 0 || t.outcome === 'Yes');
  const noTrades = trades.filter((t) => t.outcomeIndex === 1 || t.outcome === 'No');
  console.log(`4. 分离交易: YES=${yesTrades.length}, NO=${noTrades.length}\n`);

  // 5. 聚合为 1 小时蜡烛图
  const interval: KLineInterval = '1h';
  console.log(`5. 聚合为 ${interval} 蜡烛图...\n`);

  const yesCandles = aggregateToKLines(yesTrades, interval);
  const noCandles = aggregateToKLines(noTrades, interval);

  console.log(`   YES Token K 线 (${yesCandles.length} 根):`);
  for (const candle of yesCandles.slice(-5)) {
    const date = new Date(candle.timestamp).toLocaleString();
    console.log(
      `   [${date}] 开:${candle.open.toFixed(3)} 高:${candle.high.toFixed(3)} 低:${candle.low.toFixed(3)} 收:${candle.close.toFixed(3)} 量:$${candle.volume.toFixed(0)} (${candle.tradeCount} 笔)`
    );
  }

  console.log(`\n   NO Token K 线 (${noCandles.length} 根):`);
  for (const candle of noCandles.slice(-5)) {
    const date = new Date(candle.timestamp).toLocaleString();
    console.log(
      `   [${date}] 开:${candle.open.toFixed(3)} 高:${candle.high.toFixed(3)} 低:${candle.low.toFixed(3)} 收:${candle.close.toFixed(3)} 量:$${candle.volume.toFixed(0)} (${candle.tradeCount} 笔)`
    );
  }

  // 6. 计算价差随时间变化
  console.log('\n6. 价差分析 (YES价格 + NO价格):\n');

  // 找到匹配的时间戳
  const yesMap = new Map(yesCandles.map((c) => [c.timestamp, c]));
  const noMap = new Map(noCandles.map((c) => [c.timestamp, c]));

  const allTimestamps = [...new Set([...yesMap.keys(), ...noMap.keys()])].sort();
  let lastYes = 0.5;
  let lastNo = 0.5;

  for (const ts of allTimestamps.slice(-5)) {
    const date = new Date(ts).toLocaleString();
    const yesCandle = yesMap.get(ts);
    const noCandle = noMap.get(ts);

    if (yesCandle) lastYes = yesCandle.close;
    if (noCandle) lastNo = noCandle.close;

    const spread = lastYes + lastNo;
    const arbOpportunity = spread < 1 ? '多头套利' : spread > 1 ? '空头套利' : '';

    console.log(
      `   [${date}] YES:${lastYes.toFixed(3)} + NO:${lastNo.toFixed(3)} = ${spread.toFixed(4)} ${arbOpportunity}`
    );
  }

  console.log('\n=== 完成 ===');
}

main().catch(console.error);
