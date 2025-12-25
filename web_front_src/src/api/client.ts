import axios from 'axios';

const api = axios.create({
    baseURL: '/api',
    timeout: 30000,
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
};

// 钱包 API
export const walletApi = {
    getLeaderboard: (limit = 10) => api.get(`/wallets/leaderboard?limit=${limit}`),
    getProfile: (address: string) => api.get(`/wallets/${address}/profile`),
    getPositions: (address: string) => api.get(`/wallets/${address}/positions`),
    getActivity: (address: string, limit = 50) => api.get(`/wallets/${address}/activity?limit=${limit}`),
};

export default api;
