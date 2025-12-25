/**
 * API 配置
 */

export const config = {
    // 服务器配置
    port: parseInt(process.env.API_PORT || '3000'),
    host: process.env.API_HOST || '0.0.0.0',

    // CORS 配置  
    cors: {
        origin: process.env.CORS_ORIGIN || '*',
        credentials: true,
    },

    // Polymarket 配置
    polymarket: {
        privateKey: process.env.POLY_PRIVKEY,
    },

    // 套利配置
    arbitrage: {
        profitThreshold: parseFloat(process.env.ARB_PROFIT_THRESHOLD || '0.005'),
        scanInterval: parseInt(process.env.ARB_SCAN_INTERVAL || '5000'),
        minVolume24h: parseInt(process.env.ARB_MIN_VOLUME || '5000'),
    },
};

export type Config = typeof config;
