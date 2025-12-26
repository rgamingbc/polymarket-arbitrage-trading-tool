/**
 * Wallet Service
 *
 * Provides smart money analysis features:
 * - Wallet profile analysis
 * - Position tracking
 * - Activity monitoring
 * - Sell detection for follow wallet strategy
 */

import { DataApiClient, Position, Activity, LeaderboardEntry, LeaderboardPage } from '../clients/data-api.js';
import type { UnifiedCache } from '../core/unified-cache.js';
import { CACHE_TTL } from '../core/unified-cache.js';

export interface WalletProfile {
  address: string;
  totalPnL: number;
  realizedPnL: number;
  unrealizedPnL: number;
  avgPercentPnL: number;
  positionCount: number;
  tradeCount: number;
  smartScore: number; // 0-100
  lastActiveAt: Date;
}

export interface WalletActivitySummary {
  address: string;
  activities: Activity[];
  summary: {
    totalBuys: number;
    totalSells: number;
    buyVolume: number;
    sellVolume: number;
    activeMarkets: string[];
  };
}

export interface SellActivityResult {
  totalSellAmount: number;
  sellTransactions: Activity[];
  sellRatio: number;
  shouldExit: boolean;
}

export class WalletService {
  constructor(
    private dataApi: DataApiClient,
    private cache: UnifiedCache
  ) { }

  // ===== Wallet Analysis =====

  /**
   * Get comprehensive wallet profile with PnL analysis
   */
  async getWalletProfile(address: string): Promise<WalletProfile> {
    const [positions, activities] = await Promise.all([
      this.dataApi.getPositions(address),
      this.dataApi.getActivity(address, { limit: 1000 }),
    ]);

    const totalPnL = positions.reduce((sum, p) => sum + (p.cashPnl || 0), 0);
    const realizedPnL = positions.reduce((sum, p) => sum + (p.realizedPnl || 0), 0);
    const unrealizedPnL = totalPnL - realizedPnL;

    const avgPercentPnL =
      positions.length > 0
        ? positions.reduce((sum, p) => sum + (p.percentPnl || 0), 0) / positions.length
        : 0;

    const lastActivity = activities[0];

    return {
      address,
      totalPnL,
      realizedPnL,
      unrealizedPnL,
      avgPercentPnL,
      positionCount: positions.length,
      tradeCount: activities.filter((a) => a.type === 'TRADE').length,
      smartScore: this.calculateSmartScore(positions, activities),
      lastActiveAt: lastActivity ? new Date(lastActivity.timestamp) : new Date(0),
    };
  }

  /**
   * Get wallet profile filtered by time period
   * @param address Wallet address
   * @param periodDays Number of days to look back (24h=1, 7d=7, 30d=30, all=0)
   */
  async getWalletProfileForPeriod(address: string, periodDays: number): Promise<{
    pnl: number;
    volume: number;
    tradeCount: number;
    winRate: number;
    smartScore: number;
  }> {
    // 获取所有活动记录（分别抓取 TRADE 和 REDEEM 以确保数据深度）
    const [trades, redemptions] = await Promise.all([
      this.dataApi.getAllActivity(address, 10000, 'TRADE'),
      this.dataApi.getAllActivity(address, 2000, 'REDEEM'),
    ]);

    const allActivities = [...trades, ...redemptions].sort((a, b) => b.timestamp - a.timestamp);

    // 按时间过滤
    const now = Date.now();
    const sinceTimestamp = periodDays > 0 ? now - periodDays * 24 * 60 * 60 * 1000 : 0;
    const filteredTrades = trades.filter(a => a.timestamp >= sinceTimestamp);
    const filteredRedemptions = redemptions.filter(a => a.timestamp >= sinceTimestamp);

    const buys = filteredTrades.filter(a => a.side === 'BUY');
    const sells = filteredTrades.filter(a => a.side === 'SELL');

    // === 计算交易量 ===
    // 交易量 = 买入 + 卖出（不含 Redemption）
    const buyVolume = buys.reduce((sum, t) => sum + (t.usdcSize || t.size * t.price), 0);
    const sellVolume = sells.reduce((sum, t) => sum + (t.usdcSize || t.size * t.price), 0);
    const volume = buyVolume + sellVolume;

    // === 计算 PnL ===
    // PnL = 卖出收入 + 交割收入 - 买入成本
    // Redemption: 如果 outcome 方向正确，每个 share 价值 1 USDC
    const redemptionValue = filteredRedemptions.reduce((sum, r) => {
      // Redemption 时，size 代表赎回的 share 数量，每个价值 1 USDC
      return sum + (r.size || 0);
    }, 0);

    const realizedPnl = sellVolume + redemptionValue - buyVolume;

    // === 获取当前持仓估值 (Mark-to-Market) ===
    let unrealizedPnl = 0;
    try {
      const positions = await this.dataApi.getPositions(address);
      // 只计算在时间段内有活动的持仓的未实现盈亏
      unrealizedPnl = positions.reduce((sum, p) => sum + (p.cashPnl || 0), 0);
    } catch {
      // 持仓获取失败，只使用已实现盈亏
    }

    // 总 PnL = 已实现 + 未实现
    const pnl = realizedPnl + unrealizedPnl;

    // === 计算胜率 ===
    // 胜率 = (盈利的卖出交易 + 成功的交割) / (总卖出交易 + 总交割)
    let winCount = 0;
    let totalClosedPositions = sells.length + filteredRedemptions.length;

    // 卖出盈利：卖出价 > 0.5（表示高于成本价）
    for (const sell of sells) {
      if (sell.price > 0.5) {
        winCount++;
      }
    }

    // 交割都算作盈利（因为只有正确预测才会有 redemption value > 0）
    winCount += filteredRedemptions.filter(r => (r.size || 0) > 0).length;

    const winRate = totalClosedPositions > 0 ? winCount / totalClosedPositions : 0.5;

    // === 计算评分 (基于该时间段的 ROI) ===
    // Score = 基础分 50 + ROI 调整 + 交易活跃度调整
    const roi = volume > 0 ? (pnl / volume) * 100 : 0; // ROI 百分比
    const activityScore = Math.min(20, (filteredTrades.length / 10)); // 交易活跃度最多加 20 分
    const roiScore = Math.min(30, Math.max(-30, roi * 3)); // ROI 最多影响 ±30 分

    const smartScore = Math.round(Math.max(0, Math.min(100, 50 + roiScore + activityScore)));

    return {
      pnl,
      volume,
      tradeCount: filteredTrades.length,
      winRate: Math.max(0, Math.min(1, winRate)),
      smartScore,
    };
  }

  /**
   * Get positions for a wallet
   */
  async getWalletPositions(address: string): Promise<Position[]> {
    return this.dataApi.getPositions(address);
  }

  /**
   * Get positions for a specific market
   */
  async getPositionsForMarket(address: string, conditionId: string): Promise<Position[]> {
    const positions = await this.dataApi.getPositions(address);
    return positions.filter((p) => p.conditionId === conditionId);
  }

  /**
   * Get wallet activity with summary
   */
  async getWalletActivity(address: string, limit = 100): Promise<WalletActivitySummary> {
    const activities = await this.dataApi.getActivity(address, { limit });

    const buys = activities.filter((a) => a.side === 'BUY');
    const sells = activities.filter((a) => a.side === 'SELL');

    return {
      address,
      activities,
      summary: {
        totalBuys: buys.length,
        totalSells: sells.length,
        buyVolume: buys.reduce((sum, a) => sum + (a.usdcSize || 0), 0),
        sellVolume: sells.reduce((sum, a) => sum + (a.usdcSize || 0), 0),
        activeMarkets: [...new Set(activities.map((a) => a.conditionId))],
      },
    };
  }

  // ===== Wallet Discovery =====

  /**
   * Get leaderboard
   */
  async getLeaderboard(page = 0, pageSize = 50): Promise<LeaderboardPage> {
    return this.dataApi.getLeaderboard({ limit: pageSize, offset: page * pageSize });
  }

  /**
   * Get top traders from leaderboard
   */
  async getTopTraders(limit = 10): Promise<LeaderboardEntry[]> {
    const leaderboard = await this.dataApi.getLeaderboard({ limit });
    return leaderboard.entries;
  }

  /**
   * Discover active wallets from recent trades
   */
  async discoverActiveWallets(limit = 100): Promise<Array<{ address: string; tradeCount: number }>> {
    const trades = await this.dataApi.getTrades({ limit: 1000 });

    // Count trades per wallet
    const walletCounts = new Map<string, number>();
    for (const trade of trades) {
      if (trade.proxyWallet) {
        walletCounts.set(trade.proxyWallet, (walletCounts.get(trade.proxyWallet) || 0) + 1);
      }
    }

    // Sort by trade count
    return [...walletCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([address, tradeCount]) => ({ address, tradeCount }));
  }

  // ===== Sell Detection (Follow Wallet Strategy) =====

  /**
   * Detect sell activity for a wallet in a specific market
   */
  async detectSellActivity(
    address: string,
    conditionId: string,
    sinceTimestamp: number,
    peakValue?: number
  ): Promise<SellActivityResult> {
    const activities = await this.dataApi.getActivity(address, { limit: 200, type: 'TRADE' });

    const sellTransactions = activities.filter(
      (a) => a.conditionId === conditionId && a.side === 'SELL' && a.timestamp >= sinceTimestamp
    );

    const totalSellAmount = sellTransactions.reduce((sum, a) => sum + (a.usdcSize || a.size * a.price), 0);

    // Calculate sell ratio if peak value is provided
    const sellRatio = peakValue && peakValue > 0 ? totalSellAmount / peakValue : 0;

    return {
      totalSellAmount,
      sellTransactions,
      sellRatio,
      shouldExit: sellRatio >= 0.3, // 30% threshold for exit signal
    };
  }

  /**
   * Track sell ratio for multiple wallets (aggregated)
   */
  async trackGroupSellRatio(
    addresses: string[],
    conditionId: string,
    peakTotalValue: number,
    sinceTimestamp: number
  ): Promise<{
    cumulativeSellAmount: number;
    sellRatio: number;
    shouldExit: boolean;
    walletSells: Array<{ address: string; sellAmount: number }>;
  }> {
    const walletSells: Array<{ address: string; sellAmount: number }> = [];
    let cumulativeSellAmount = 0;

    for (const address of addresses) {
      const sellData = await this.detectSellActivity(address, conditionId, sinceTimestamp);
      walletSells.push({ address, sellAmount: sellData.totalSellAmount });
      cumulativeSellAmount += sellData.totalSellAmount;
    }

    const sellRatio = peakTotalValue > 0 ? cumulativeSellAmount / peakTotalValue : 0;

    return {
      cumulativeSellAmount,
      sellRatio,
      shouldExit: sellRatio >= 0.3,
      walletSells,
    };
  }

  // ===== Smart Score Calculation =====

  private calculateSmartScore(positions: Position[], activities: Activity[]): number {
    // Weights: PnL 40%, Win Rate 30%, Consistency 20%, Activity 10%

    // PnL Score (0-40)
    const avgPnL =
      positions.length > 0
        ? positions.reduce((sum, p) => sum + (p.percentPnl || 0), 0) / positions.length
        : 0;
    const pnlScore = Math.min(40, Math.max(0, ((avgPnL + 50) / 100) * 40));

    // Win Rate Score (0-30)
    const winningPositions = positions.filter((p) => (p.cashPnl || 0) > 0).length;
    const winRate = positions.length > 0 ? winningPositions / positions.length : 0;
    const winRateScore = winRate * 30;

    // Consistency Score (0-20)
    const pnlValues = positions.map((p) => p.percentPnl || 0);
    const variance = this.calculateVariance(pnlValues);
    const consistencyScore = Math.max(0, 20 - variance / 10);

    // Activity Score (0-10)
    const recentTrades = activities.filter((a) => a.timestamp > Date.now() - 7 * 24 * 60 * 60 * 1000).length;
    const activityScore = Math.min(10, (recentTrades / 5) * 10);

    return Math.round(pnlScore + winRateScore + consistencyScore + activityScore);
  }

  private calculateVariance(values: number[]): number {
    if (values.length === 0) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  }
}
