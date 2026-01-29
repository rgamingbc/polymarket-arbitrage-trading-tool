import axios from 'axios';

const api = axios.create({
    baseURL: '/api',
    timeout: 120000, // Increased timeout to 120s
});

// 市场 API
export const marketApi = {
    getTrending: (limit = 10) => api.get(`/markets/trending?limit=${limit}`),
    getMarket: (conditionId: string) => api.get(`/markets/${conditionId}`),
    getOrderbook: (conditionId: string) => api.get(`/markets/${conditionId}/orderbook`),
    getKLines: (conditionId: string, interval = '1h', limit = 100) =>
        api.get(`/markets/${conditionId}/klines?interval=${interval}&limit=${limit}`),
};

// 套利 API
export const arbitrageApi = {
    scan: (minVolume = 5000, limit = 50, minProfit = 0.003) =>
        api.get(`/arbitrage/scan?minVolume=${minVolume}&limit=${limit}&minProfit=${minProfit}`),
    check: (conditionId: string) => api.get(`/arbitrage/${conditionId}`),
    execute: (market: any, opportunity: any, size: number) => api.post('/arbitrage/execute', { market, opportunity, size }),
};

// 钱包 API
export const walletApi = {
    getLeaderboard: (limit = 500, timePeriod: 'DAY' | 'WEEK' | 'MONTH' | 'ALL' = 'ALL') =>
        api.get(`/wallets/leaderboard?limit=${limit}&timePeriod=${timePeriod}`),
    getProfile: (address: string) => api.get(`/wallets/${address}/profile`),
    getPositions: (address: string) => api.get(`/wallets/${address}/positions`),
    getActivity: (address: string, limit = 50) => api.get(`/wallets/${address}/activity?limit=${limit}`),
};

// 鲸鱼发现 API
export const whaleApi = {
    start: (config: { infuraApiKey?: string; minTradeUsdcValue?: number; minWinRate?: number; minPnl?: number }) =>
        api.post('/whale/start', config),
    stop: () => api.post('/whale/stop'),
    getStatus: () => api.get('/whale/status'),
    getWhales: (sort = 'pnl', limit = 50) => api.get(`/whale/whales?sort=${sort}&limit=${limit}`),
    getTrades: (limit = 100) => api.get(`/whale/trades?limit=${limit}`),
    getConfig: () => api.get('/whale/config'),
    updateConfig: (config: object) => api.put('/whale/config', config),
    getProfile: (address: string, period: '24h' | '7d' | '30d' | 'all' = 'all') =>
        api.get(`/whale/profile/${address}?period=${period}`),
    // 缓存相关
    refreshCache: () => api.post('/whale/cache/refresh'),
    getCacheStatus: () => api.get('/whale/cache/status'),
    getCacheBulk: (addresses: string[]) => api.get(`/whale/cache/bulk?addresses=${addresses.join(',')}`),
    // 监控名单
    getWatched: () => api.get('/whale/watched'),
    toggleWatch: (address: string, watched: boolean, label?: string) => api.post('/whale/watch', { address, watched, label }),
};

// 版本 API
export const versionApi = {
    getVersion: () => api.get('/version'),
};

export default api;
