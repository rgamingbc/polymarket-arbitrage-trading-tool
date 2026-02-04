/**
 * API 配置
 * 
 * 所有配置项支持通过环境变量覆盖
 */
import dotenv from 'dotenv';
import path from 'path';

// Load .env from project root
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export const config = {
    // ===== 服务器配置 =====
    port: parseInt(process.env.API_PORT || '3001'),     // 服务端口，环境变量: API_PORT
    host: process.env.API_HOST || '0.0.0.0',            // 服务地址，环境变量: API_HOST

    // ===== CORS 配置 =====
    cors: {
        origin: process.env.CORS_ORIGIN || '*',         // 允许的源，环境变量: CORS_ORIGIN
        credentials: true,                              // 允许携带凭证
    },

    // ===== Polymarket 配置 =====
    polymarket: {
        privateKey: process.env.POLY_PRIVKEY,           // 交易私钥，环境变量: POLY_PRIVKEY
    },

    // ===== 套利配置 =====
    arbitrage: {
        profitThreshold: parseFloat(process.env.ARB_PROFIT_THRESHOLD || '0.005'),  // 最小利润阈值 (0.5%)，环境变量: ARB_PROFIT_THRESHOLD
        scanInterval: parseInt(process.env.ARB_SCAN_INTERVAL || '5000'),           // 扫描间隔毫秒，环境变量: ARB_SCAN_INTERVAL
        minVolume24h: parseInt(process.env.ARB_MIN_VOLUME || '5000'),              // 最小24h交易量 ($)，环境变量: ARB_MIN_VOLUME
    },

    // ===== 鲸鱼发现配置 =====
    whaleDiscovery: {
        // --- 链接配置 ---
        infuraApiKey: process.env.INFURA_API_KEY || '',                            // Infura API Key，环境变量: INFURA_API_KEY

        // --- 【阶段1】进入观察队列的条件 ---
        // 满足以下条件的地址才会进入分析队列
        minTradeUsdcValue: parseInt(process.env.WHALE_MIN_TRADE || '100'),          // [观察] 最小单笔交易金额 ($)，环境变量: WHALE_MIN_TRADE
        minTradesObserved: parseInt(process.env.WHALE_MIN_TRADES || '1'),          // [观察] 最小观察到的交易次数，环境变量: WHALE_MIN_TRADES

        // --- 【阶段2】判断为鲸鱼的条件 ---
        // 进入分析后，必须同时满足以下条件才会被标记为鲸鱼
        minWinRate: parseFloat(process.env.WHALE_MIN_WINRATE || '0.55'),           // [判定] 最低胜率 (55%)，环境变量: WHALE_MIN_WINRATE
        minPnl: parseInt(process.env.WHALE_MIN_PNL || '1000'),                     // [判定] 最低盈利 ($)，环境变量: WHALE_MIN_PNL
        minVolume: parseInt(process.env.WHALE_MIN_VOLUME || '5000'),               // [判定] 最低交易量 ($)，环境变量: WHALE_MIN_VOLUME

        // --- 分析调度配置 ---
        analysisIntervalSec: parseInt(process.env.WHALE_ANALYSIS_INTERVAL || '20'), // 分析间隔秒数，环境变量: WHALE_ANALYSIS_INTERVAL
        maxAnalysisPerBatch: parseInt(process.env.WHALE_MAX_BATCH || '10'),        // 每批最多分析地址数 (上限10)，环境变量: WHALE_MAX_BATCH
    },
};

export type Config = typeof config;
