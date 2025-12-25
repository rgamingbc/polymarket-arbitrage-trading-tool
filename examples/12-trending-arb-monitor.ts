/**
 * 示例 12: 热门市场套利监控
 *
 * 实时监控热门 Polymarket 市场的套利机会。
 *
 * 重要：理解 Polymarket 订单簿
 * =============================================
 * Polymarket 订单簿的关键特性：买 YES @ P = 卖 NO @ (1-P)
 * 因此同一订单会在两个订单簿中出现
 *
 * 正确的套利计算必须使用"有效价格"：
 * - effectiveBuyYes = min(YES.ask, 1 - NO.bid)
 * - effectiveBuyNo = min(NO.ask, 1 - YES.bid)
 * - effectiveSellYes = max(YES.bid, 1 - NO.ask)
 * - effectiveSellNo = max(NO.bid, 1 - YES.ask)
 *
 * 详细文档见: docs/01-polymarket-orderbook-arbitrage.md
 *
 * 功能：
 * - 从 Gamma API 获取热门市场
 * - 持续监控订单簿寻找套利机会
 * - 使用正确的有效价格计算
 * - 详细日志用于调试和分析
 * - 可配置扫描间隔和利润阈值
 *
 * 运行：
 *   pnpm example:trending-arb
 *
 * 环境变量：
 *   SCAN_INTERVAL_MS - 扫描间隔毫秒（默认: 5000）
 *   MIN_PROFIT_THRESHOLD - 最小利润百分比（默认: 0.1）
 *   MAX_MARKETS - 最大监控市场数（默认: 20）
 */

import { PolymarketSDK, checkArbitrage, getEffectivePrices } from '../src/index.js';

// ===== 配置 =====
const CONFIG = {
  scanIntervalMs: parseInt(process.env.SCAN_INTERVAL_MS || '5000'),
  minProfitThreshold: parseFloat(process.env.MIN_PROFIT_THRESHOLD || '0.1') / 100, // 转换 % 为小数
  maxMarkets: parseInt(process.env.MAX_MARKETS || '20'),
  refreshMarketsIntervalMs: 60000, // 每分钟刷新热门市场
  maxCycles: parseInt(process.env.MAX_CYCLES || '0'), // 0 = 无限制
};

// ===== 日志工具 =====
function log(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG' | 'SUCCESS', message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  const prefix = {
    'INFO': '📋',
    'WARN': '⚠️',
    'ERROR': '❌',
    'DEBUG': '🔍',
    'SUCCESS': '✅',
  }[level];

  console.log(`[${timestamp}] ${prefix} [${level}] ${message}`);
  if (data !== undefined) {
    if (typeof data === 'object') {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(`   → ${data}`);
    }
  }
}

function logSeparator(title?: string) {
  if (title) {
    console.log(`\n${'═'.repeat(20)} ${title} ${'═'.repeat(20)}`);
  } else {
    console.log('─'.repeat(60));
  }
}

// ===== 类型 =====
interface MonitoredMarket {
  conditionId: string;
  question: string;
  slug: string;
  volume24h: number;
  lastUpdate: number;
  lastEffectiveLongCost?: number;
  lastEffectiveShortRevenue?: number;
  scanCount: number;
  errorCount: number;
}

interface ScanResult {
  timestamp: number;
  market: MonitoredMarket;
  yesAsk: number;
  noAsk: number;
  yesBid: number;
  noBid: number;
  // 有效价格（考虑镜像订单）
  effectiveBuyYes: number;
  effectiveBuyNo: number;
  effectiveSellYes: number;
  effectiveSellNo: number;
  effectiveLongCost: number;
  effectiveShortRevenue: number;
  longArbProfit: number;
  shortArbProfit: number;
  yesSpread: number;
  hasOpportunity: boolean;
  opportunityType?: 'long' | 'short';
}

// ===== 监控状态 =====
let markets: MonitoredMarket[] = [];
let scanCount = 0;
let opportunitiesFound = 0;
let totalScans = 0;
let lastMarketRefresh = 0;

// ===== 主函数 =====

async function fetchTrendingMarkets(sdk: PolymarketSDK): Promise<MonitoredMarket[]> {
  log('INFO', `获取前 ${CONFIG.maxMarkets} 个热门市场...`);

  try {
    const trendingMarkets = await sdk.gammaApi.getTrendingMarkets(CONFIG.maxMarkets);

    const monitored: MonitoredMarket[] = trendingMarkets
      .filter(m => m.conditionId)
      .map(m => ({
        conditionId: m.conditionId,
        question: m.question || '未知',
        slug: m.slug || '',
        volume24h: m.volume24hr || 0,
        lastUpdate: Date.now(),
        scanCount: 0,
        errorCount: 0,
      }));

    log('SUCCESS', `加载了 ${monitored.length} 个热门市场`);

    // 记录市场详情
    monitored.forEach((m, i) => {
      log('DEBUG', `  ${i + 1}. ${m.question.slice(0, 50)}...`, {
        conditionId: m.conditionId.slice(0, 20) + '...',
        volume24h: `$${m.volume24h.toLocaleString()}`,
      });
    });

    return monitored;
  } catch (error) {
    log('ERROR', '获取热门市场失败', error instanceof Error ? error.message : error);
    return [];
  }
}

async function scanMarket(sdk: PolymarketSDK, market: MonitoredMarket): Promise<ScanResult | null> {
  try {
    const orderbook = await sdk.clobApi.getProcessedOrderbook(market.conditionId);

    market.scanCount++;
    market.lastUpdate = Date.now();
    market.lastEffectiveLongCost = orderbook.summary.effectiveLongCost;
    market.lastEffectiveShortRevenue = orderbook.summary.effectiveShortRevenue;

    const { effectivePrices } = orderbook.summary;

    // 使用正确的有效价格检测套利
    const arb = checkArbitrage(
      orderbook.yes.ask,
      orderbook.no.ask,
      orderbook.yes.bid,
      orderbook.no.bid
    );

    const hasOpportunity = arb !== null && arb.profit > CONFIG.minProfitThreshold;

    return {
      timestamp: Date.now(),
      market,
      yesAsk: orderbook.yes.ask,
      noAsk: orderbook.no.ask,
      yesBid: orderbook.yes.bid,
      noBid: orderbook.no.bid,
      // 有效价格
      effectiveBuyYes: effectivePrices.effectiveBuyYes,
      effectiveBuyNo: effectivePrices.effectiveBuyNo,
      effectiveSellYes: effectivePrices.effectiveSellYes,
      effectiveSellNo: effectivePrices.effectiveSellNo,
      effectiveLongCost: orderbook.summary.effectiveLongCost,
      effectiveShortRevenue: orderbook.summary.effectiveShortRevenue,
      longArbProfit: orderbook.summary.longArbProfit,
      shortArbProfit: orderbook.summary.shortArbProfit,
      yesSpread: orderbook.summary.yesSpread,
      hasOpportunity,
      opportunityType: arb?.type,
    };
  } catch (error) {
    market.errorCount++;
    log('WARN', `扫描失败: ${market.question.slice(0, 30)}...`, error instanceof Error ? error.message : '未知');
    return null;
  }
}

async function runScanCycle(sdk: PolymarketSDK): Promise<void> {
  scanCount++;
  const cycleStart = Date.now();

  logSeparator(`扫描周期 #${scanCount}`);
  log('INFO', `扫描 ${markets.length} 个市场...`);

  const results: ScanResult[] = [];
  let successCount = 0;
  let errorCount = 0;

  for (const market of markets) {
    const result = await scanMarket(sdk, market);
    totalScans++;

    if (result) {
      successCount++;
      results.push(result);

      // 记录每个市场扫描结果
      const profitIndicator = result.hasOpportunity ? '🎯' :
        result.longArbProfit > -0.01 ? '📈' :
          result.shortArbProfit > -0.01 ? '📉' : '⏸️';

      log('DEBUG', `${profitIndicator} ${market.question.slice(0, 40)}...`, {
        // 有效价格计算
        effectiveLongCost: result.effectiveLongCost.toFixed(4),
        effectiveShortRevenue: result.effectiveShortRevenue.toFixed(4),
        longArb: `${(result.longArbProfit * 100).toFixed(2)}%`,
        shortArb: `${(result.shortArbProfit * 100).toFixed(2)}%`,
        yesSpread: `${(result.yesSpread * 100).toFixed(2)}%`,
      });
    } else {
      errorCount++;
    }
  }

  // 发现机会
  const opportunities = results.filter(r => r.hasOpportunity);

  if (opportunities.length > 0) {
    opportunitiesFound += opportunities.length;

    logSeparator('🚨 发现机会');

    for (const opp of opportunities) {
      log('SUCCESS', `${opp.opportunityType?.toUpperCase()} 套利机会`, {
        market: opp.market.question,
        conditionId: opp.market.conditionId,
        type: opp.opportunityType,
        profit: `${(Math.max(opp.longArbProfit, opp.shortArbProfit) * 100).toFixed(3)}%`,
        effectivePrices: {
          buyYes: opp.effectiveBuyYes.toFixed(4),
          buyNo: opp.effectiveBuyNo.toFixed(4),
          sellYes: opp.effectiveSellYes.toFixed(4),
          sellNo: opp.effectiveSellNo.toFixed(4),
        },
        costs: {
          effectiveLongCost: opp.effectiveLongCost.toFixed(4),
          effectiveShortRevenue: opp.effectiveShortRevenue.toFixed(4),
        },
      });

      // 记录执行策略
      if (opp.opportunityType === 'long') {
        log('INFO', '📌 策略: 买 YES + 买 NO → 合并 → 获利', {
          step1: `买 YES @ ${opp.effectiveBuyYes.toFixed(4)}`,
          step2: `买 NO @ ${opp.effectiveBuyNo.toFixed(4)}`,
          step3: '合并代币 → 1 USDC',
          profit: `每单位 ${(opp.longArbProfit * 100).toFixed(3)}%`,
        });
      } else {
        log('INFO', '📌 策略: 拆分 USDC → 卖 YES + 卖 NO → 获利', {
          step1: '拆分 1 USDC → 1 YES + 1 NO',
          step2: `卖 YES @ ${opp.effectiveSellYes.toFixed(4)}`,
          step3: `卖 NO @ ${opp.effectiveSellNo.toFixed(4)}`,
          profit: `每单位 ${(opp.shortArbProfit * 100).toFixed(3)}%`,
        });
      }
    }
  }

  // 周期总结
  const cycleTime = Date.now() - cycleStart;
  log('INFO', `周期 #${scanCount} 完成`, {
    duration: `${cycleTime}ms`,
    scanned: successCount,
    errors: errorCount,
    opportunities: opportunities.length,
  });

  // 显示最佳价差（最接近套利）
  if (results.length > 0) {
    const sortedByLongArb = [...results].sort((a, b) => b.longArbProfit - a.longArbProfit);
    const sortedByShortArb = [...results].sort((a, b) => b.shortArbProfit - a.shortArbProfit);

    log('DEBUG', '最佳多头套利候选（按有效成本）:', {
      '第1': `${sortedByLongArb[0].market.question.slice(0, 30)}... → 成本=${sortedByLongArb[0].effectiveLongCost.toFixed(4)} → ${(sortedByLongArb[0].longArbProfit * 100).toFixed(2)}%`,
      '第2': sortedByLongArb[1] ? `${sortedByLongArb[1].market.question.slice(0, 30)}... → 成本=${sortedByLongArb[1].effectiveLongCost.toFixed(4)} → ${(sortedByLongArb[1].longArbProfit * 100).toFixed(2)}%` : 'N/A',
    });

    log('DEBUG', '最佳空头套利候选（按有效收益）:', {
      '第1': `${sortedByShortArb[0].market.question.slice(0, 30)}... → 收益=${sortedByShortArb[0].effectiveShortRevenue.toFixed(4)} → ${(sortedByShortArb[0].shortArbProfit * 100).toFixed(2)}%`,
      '第2': sortedByShortArb[1] ? `${sortedByShortArb[1].market.question.slice(0, 30)}... → 收益=${sortedByShortArb[1].effectiveShortRevenue.toFixed(4)} → ${(sortedByShortArb[1].shortArbProfit * 100).toFixed(2)}%` : 'N/A',
    });

    // 显示价差分析
    const avgSpread = results.reduce((sum, r) => sum + r.yesSpread, 0) / results.length;
    log('DEBUG', '市场效率:', {
      avgYesSpread: `${(avgSpread * 100).toFixed(2)}%`,
      interpretation: '价差 = 交易成本，价差 > 0 时市场是有效的',
    });
  }
}

async function maybeRefreshMarkets(sdk: PolymarketSDK): Promise<void> {
  const now = Date.now();
  if (now - lastMarketRefresh > CONFIG.refreshMarketsIntervalMs) {
    log('INFO', '刷新热门市场列表...');
    const newMarkets = await fetchTrendingMarkets(sdk);
    if (newMarkets.length > 0) {
      markets = newMarkets;
      lastMarketRefresh = now;
    }
  }
}

async function main(): Promise<void> {
  console.clear();
  logSeparator('热门市场套利监控');

  log('INFO', '配置', {
    scanInterval: `${CONFIG.scanIntervalMs}ms`,
    minProfitThreshold: `${CONFIG.minProfitThreshold * 100}%`,
    maxMarkets: CONFIG.maxMarkets,
    refreshInterval: `${CONFIG.refreshMarketsIntervalMs / 1000}s`,
  });

  log('INFO', '理解套利计算:', {
    note: '使用考虑镜像订单的有效价格',
    longArb: '当 effectiveLongCost < 1.0 时有利润',
    shortArb: '当 effectiveShortRevenue > 1.0 时有利润',
    docs: 'docs/01-polymarket-orderbook-arbitrage.md',
  });

  // 初始化 SDK
  log('INFO', '初始化 PolymarketSDK...');
  const sdk = new PolymarketSDK();
  log('SUCCESS', 'SDK 已初始化');

  // 获取初始市场
  markets = await fetchTrendingMarkets(sdk);
  lastMarketRefresh = Date.now();

  if (markets.length === 0) {
    log('ERROR', '没有市场可监控。退出。');
    process.exit(1);
  }

  logSeparator('启动监控循环');
  log('INFO', `按 Ctrl+C 停止。每 ${CONFIG.scanIntervalMs / 1000}s 扫描一次...`);

  // 监控循环
  const runLoop = async () => {
    try {
      await maybeRefreshMarkets(sdk);
      await runScanCycle(sdk);
    } catch (error) {
      log('ERROR', '扫描周期错误', error instanceof Error ? error.message : error);
    }

    // 检查是否达到最大周期
    if (CONFIG.maxCycles > 0 && scanCount >= CONFIG.maxCycles) {
      logSeparator('达到最大周期');
      log('INFO', '最终统计', {
        totalCycles: scanCount,
        totalScans,
        opportunitiesFound,
      });
      process.exit(0);
    }

    // 安排下一次扫描
    setTimeout(runLoop, CONFIG.scanIntervalMs);
  };

  // 启动循环
  await runLoop();

  // 处理关闭
  process.on('SIGINT', () => {
    logSeparator('监控关闭');
    log('INFO', '最终统计', {
      totalCycles: scanCount,
      totalScans,
      opportunitiesFound,
      runtime: `${Math.round((Date.now() - lastMarketRefresh) / 1000)}s`,
    });
    process.exit(0);
  });
}

main().catch(error => {
  log('ERROR', '致命错误', error);
  process.exit(1);
});
