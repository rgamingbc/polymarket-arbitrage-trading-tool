export type SharedMarketData = {
    crypto15mMarketSnapshot: { atMs: number; markets: any[]; lastError: string | null };
    crypto15mBooksSnapshot: { atMs: number; byTokenId: Record<string, any>; lastError: string | null; lastAttemptAtMs: number; lastAttemptError: string | null };
    crypto15mMarketInFlight: Promise<void> | null;
    crypto15mBooksInFlight: Promise<void> | null;
    crypto15mMarketBackoffMs: number;
    crypto15mMarketNextAllowedAtMs: number;
    crypto15mBooksBackoffMs: number;
    crypto15mBooksNextAllowedAtMs: number;

    cryptoAllMarketSnapshot: { atMs: number; markets: any[]; lastError: string | null; lastAttemptAtMs: number; lastAttemptError: string | null; key?: string };
    cryptoAllBooksSnapshot: { atMs: number; byTokenId: Record<string, any>; lastError: string | null; lastAttemptAtMs: number; lastAttemptError: string | null; key?: string };
    cryptoAllMarketInFlight: Promise<void> | null;
    cryptoAllBooksInFlight: Promise<void> | null;
    cryptoAllMarketBackoffMs: number;
    cryptoAllMarketNextAllowedAtMs: number;
    cryptoAllBooksBackoffMs: number;
    cryptoAllBooksNextAllowedAtMs: number;
};

const key = '__polymarket_shared_market_data_v1__';

export const getSharedMarketData = (): SharedMarketData => {
    const g = globalThis as any;
    if (g[key]) return g[key] as SharedMarketData;
    const init: SharedMarketData = {
        crypto15mMarketSnapshot: { atMs: 0, markets: [], lastError: null },
        crypto15mBooksSnapshot: { atMs: 0, byTokenId: {}, lastError: null, lastAttemptAtMs: 0, lastAttemptError: null },
        crypto15mMarketInFlight: null,
        crypto15mBooksInFlight: null,
        crypto15mMarketBackoffMs: 0,
        crypto15mMarketNextAllowedAtMs: 0,
        crypto15mBooksBackoffMs: 0,
        crypto15mBooksNextAllowedAtMs: 0,

        cryptoAllMarketSnapshot: { atMs: 0, markets: [], lastError: null, lastAttemptAtMs: 0, lastAttemptError: null },
        cryptoAllBooksSnapshot: { atMs: 0, byTokenId: {}, lastError: null, lastAttemptAtMs: 0, lastAttemptError: null },
        cryptoAllMarketInFlight: null,
        cryptoAllBooksInFlight: null,
        cryptoAllMarketBackoffMs: 0,
        cryptoAllMarketNextAllowedAtMs: 0,
        cryptoAllBooksBackoffMs: 0,
        cryptoAllBooksNextAllowedAtMs: 0,
    };
    g[key] = init;
    return init;
};

