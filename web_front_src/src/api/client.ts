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

export const followActivityApi = {
    confirm: (config: {
        address: string;
        limit?: number;
        queryMode?: 'user' | 'proxyWallet' | 'auto';
        types?: string[];
        sides?: string[];
        includeKeywords?: string[];
        excludeKeywords?: string[];
        ratio?: number;
        maxUsdcPerOrder?: number;
        maxUsdcPerDay?: number;
    }) => api.post('/follow-activity/confirm', config),
    start: (config: {
        address: string;
        pollMs?: number;
        limit?: number;
        queryMode?: 'user' | 'proxyWallet' | 'auto';
        types?: string[];
        sides?: string[];
        includeKeywords?: string[];
        excludeKeywords?: string[];
        ratio?: number;
        maxUsdcPerOrder?: number;
        maxUsdcPerDay?: number;
    }) => api.post('/follow-activity/start', config),
    stop: () => api.post('/follow-activity/stop'),
    getStatus: () => api.get('/follow-activity/status'),
    getActivities: (limit = 100, beforeTs?: number | null) => api.get(`/follow-activity/activities?limit=${limit}${beforeTs != null ? `&beforeTs=${encodeURIComponent(String(beforeTs))}` : ''}`),
    getSuggestions: (limit = 100, beforeAt?: number | null) => api.get(`/follow-activity/suggestions?limit=${limit}${beforeAt != null ? `&beforeAt=${encodeURIComponent(String(beforeAt))}` : ''}`),
    getActivitiesPage: (params: { address: string; limit?: number; offset?: number; queryMode?: 'user' | 'proxyWallet' | 'auto' }) => {
        const limit = params.limit != null ? Number(params.limit) : 100;
        const offset = params.offset != null ? Number(params.offset) : 0;
        const queryMode = params.queryMode || 'auto';
        return api.get(`/follow-activity/activities?address=${encodeURIComponent(params.address)}&limit=${limit}&offset=${offset}&queryMode=${encodeURIComponent(queryMode)}`);
    },
    getSuggestionsPage: (params: {
        address: string;
        limit?: number;
        offset?: number;
        queryMode?: 'user' | 'proxyWallet' | 'auto';
        types?: string[];
        sides?: string[];
        includeKeywords?: string[];
        excludeKeywords?: string[];
        ratio?: number;
        maxUsdcPerOrder?: number;
        maxUsdcPerDay?: number;
    }) => {
        const limit = params.limit != null ? Number(params.limit) : 100;
        const offset = params.offset != null ? Number(params.offset) : 0;
        const queryMode = params.queryMode || 'auto';
        const q = new URLSearchParams();
        q.set('address', params.address);
        q.set('limit', String(limit));
        q.set('offset', String(offset));
        q.set('queryMode', queryMode);
        for (const t of (Array.isArray(params.types) ? params.types : [])) q.append('types', String(t));
        for (const s of (Array.isArray(params.sides) ? params.sides : [])) q.append('sides', String(s));
        for (const k of (Array.isArray(params.includeKeywords) ? params.includeKeywords : [])) q.append('includeKeywords', String(k));
        for (const k of (Array.isArray(params.excludeKeywords) ? params.excludeKeywords : [])) q.append('excludeKeywords', String(k));
        if (params.ratio != null) q.set('ratio', String(params.ratio));
        if (params.maxUsdcPerOrder != null) q.set('maxUsdcPerOrder', String(params.maxUsdcPerOrder));
        if (params.maxUsdcPerDay != null) q.set('maxUsdcPerDay', String(params.maxUsdcPerDay));
        return api.get(`/follow-activity/suggestions?${q.toString()}`);
    },
    getAutoTradeStatus: () => api.get('/follow-activity/autotrade/status'),
    updateAutoTradeConfig: (config: {
        enabled?: boolean;
        mode?: 'queue' | 'auto';
        executionStyle?: 'copy' | 'sweep';
        allowConditionIds?: string[];
        denyConditionIds?: string[];
        allowCategories?: string[];
        priceBufferCents?: number;
        maxOrdersPerHour?: number;
        paperTradeEnabled?: boolean;
        paperFillRule?: 'touch' | 'sweep';
        paperBookLevels?: number;
        paperMinFillPct?: number;
        sweepPriceCapCents?: number;
        sweepMinTriggerCents?: number;
        sweepMaxUsdcPerEvent?: number;
        sweepMaxOrdersPerEvent?: number;
        sweepMinIntervalMs?: number;
    }) => api.post('/follow-activity/autotrade/config', config),
    getAutoTradePending: (limit = 200) => api.get(`/follow-activity/autotrade/pending?limit=${limit}`),
    clearAutoTradePending: (keep = 50) => api.post('/follow-activity/autotrade/pending/clear', { keep }),
    executeAutoTradePending: (id: string) => api.post(`/follow-activity/autotrade/pending/${encodeURIComponent(id)}/execute`),
    getAutoTradeHistory: (limit = 200) => api.get(`/follow-activity/autotrade/history?limit=${limit}`),
    getPaperTradeStatus: () => api.get('/follow-activity/autotrade/paper/status'),
    getPaperTradeHistory: (limit = 200) => api.get(`/follow-activity/autotrade/paper/history?limit=${limit}`),
    clearPaperTradeHistory: (keep = 50) => api.post('/follow-activity/autotrade/paper/clear', { keep }),
};

export default api;
