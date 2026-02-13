import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Checkbox, Collapse, Input, InputNumber, Select, Space, Table, Tag, Typography, message } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { followActivityApi, walletApi, versionApi } from '../api/client';

const { Title, Text } = Typography;

type QueryMode = 'user' | 'proxyWallet' | 'auto';
type ActivityType = 'TRADE' | 'REDEEM' | 'SPLIT' | 'MERGE' | 'CONVERSION';
type ActivitySide = 'BUY' | 'SELL';
type SuggestionMode = 'copytrade' | 'allTrades' | 'mirror' | 'custom';

type WatchEntry = {
    address: string;
    label: string;
    pollMs: number;
    limit: number;
    queryMode: QueryMode;
    types: ActivityType[];
    sides: ActivitySide[];
    includeKeywordsRaw: string;
    excludeKeywordsRaw: string;
    ratio: number;
    maxUsdcPerOrder: number;
    maxUsdcPerDay: number;
    watchedCategories: string[];
    allowConditionIds: string[];
    denyConditionIds: string[];
    lastConfirmAt?: string | null;
    updatedAt: string;
    createdAt: string;
};

const parseKeywords = (raw: string) => {
    return String(raw || '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
};

const toMs = (ts: any) => {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n < 1e12 ? n * 1000 : n;
};

const isHexAddress = (s: string) => /^0x[a-fA-F0-9]{40}$/.test(String(s || '').trim());

const WATCHLIST_KEY = 'follow_activity_watchlist_v1';
const TRACKING_KEY_PREFIX = 'follow_activity_tracking_v1:';
const LAST_SETTINGS_KEY = 'follow_activity_last_settings_v1';

type TrackingMem = {
    watchedCategories: string[];
    allowConditionIds: string[];
    denyConditionIds: string[];
    updatedAt: string;
};

type LastSettings = {
    address: string;
    queryMode: QueryMode;
    pollMs: number;
    limit: number;
    types: ActivityType[];
    sides: ActivitySide[];
    includeKeywordsRaw: string;
    excludeKeywordsRaw: string;
    ratio: number;
    maxUsdcPerOrder: number;
    maxUsdcPerDay: number;
    autoRefresh: boolean;
    suggestionMode: SuggestionMode;
    minLeaderUsdc: number;
    maxLeaderUsdc: number | null;
    minPrice: number;
    maxPrice: number;
    trackedCategories: string[];
    executionStyle: 'copy' | 'sweep';
    priceBufferCents: number;
    maxOrdersPerHour: number;
    paperTradeEnabled: boolean;
    paperFillRule: 'touch' | 'sweep';
    paperBookLevels: number;
    paperMinFillPct: number;
    sweepPriceCapCents: number;
    sweepMinTriggerCents: number;
    sweepMaxUsdcPerEvent: number;
    sweepMaxOrdersPerEvent: number;
    sweepMinIntervalMs: number;
    savedAt: string;
};

const readWatchlist = (): WatchEntry[] => {
    try {
        const raw = localStorage.getItem(WATCHLIST_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
};

const writeWatchlist = (list: WatchEntry[]) => {
    try {
        localStorage.setItem(WATCHLIST_KEY, JSON.stringify(Array.isArray(list) ? list : []));
    } catch {
    }
};

const normalizeStringList = (v: any) => {
    const arr = Array.isArray(v) ? v : [];
    return arr.map((x) => String(x || '').trim()).filter(Boolean);
};

const catTagColor = (v: any) => {
    const c = String(v || 'other').toLowerCase();
    if (c === 'crypto') return 'geekblue';
    if (c === 'sports') return 'orange';
    if (c === 'politics') return 'volcano';
    return 'default';
};

const trackingKey = (address: string) => `${TRACKING_KEY_PREFIX}${String(address || '').toLowerCase()}`;

const readTracking = (address: string): TrackingMem | null => {
    try {
        const key = trackingKey(address);
        const raw = localStorage.getItem(key);
        const parsed = raw ? JSON.parse(raw) : null;
        if (!parsed || typeof parsed !== 'object') return null;
        return {
            watchedCategories: normalizeStringList((parsed as any).watchedCategories),
            allowConditionIds: normalizeStringList((parsed as any).allowConditionIds),
            denyConditionIds: normalizeStringList((parsed as any).denyConditionIds),
            updatedAt: String((parsed as any).updatedAt || ''),
        };
    } catch {
        return null;
    }
};

const writeTracking = (address: string, mem: Omit<TrackingMem, 'updatedAt'>) => {
    try {
        const key = trackingKey(address);
        const payload: TrackingMem = {
            watchedCategories: normalizeStringList(mem.watchedCategories),
            allowConditionIds: normalizeStringList(mem.allowConditionIds),
            denyConditionIds: normalizeStringList(mem.denyConditionIds),
            updatedAt: new Date().toISOString(),
        };
        localStorage.setItem(key, JSON.stringify(payload));
    } catch {
    }
};

const readLastSettings = (): Partial<LastSettings> | null => {
    try {
        const raw = localStorage.getItem(LAST_SETTINGS_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (!parsed || typeof parsed !== 'object') return null;
        return parsed as any;
    } catch {
        return null;
    }
};

const writeLastSettings = (next: Partial<LastSettings>) => {
    try {
        const prev = readLastSettings() || {};
        const payload: Partial<LastSettings> = { ...prev, ...next, savedAt: new Date().toISOString() };
        localStorage.setItem(LAST_SETTINGS_KEY, JSON.stringify(payload));
    } catch {
    }
};

function FollowActivity() {
    const pageSize = 100;
    const [running, setRunning] = useState(false);
    const [status, setStatus] = useState<any>(null);
    const [activities, setActivities] = useState<any[]>([]);
    const [suggestions, setSuggestions] = useState<any[]>([]);
    const [loading, setLoading] = useState(false);
    const [confirmLoading, setConfirmLoading] = useState(false);
    const [trackLoading, setTrackLoading] = useState(false);
    const [stopLoading, setStopLoading] = useState(false);
    const [apiOk, setApiOk] = useState<boolean | null>(null);
    const [apiInfo, setApiInfo] = useState<{ api?: string; sdk?: string } | null>(null);
    const [uiError, setUiError] = useState<string | null>(null);
    const [autoTradeLoading, setAutoTradeLoading] = useState(false);
    const [autoTradeEnabled, setAutoTradeEnabled] = useState(false);
    const [autoTradeMode, setAutoTradeMode] = useState<'queue' | 'auto'>('queue');
    const [executionStyle, setExecutionStyle] = useState<'copy' | 'sweep'>('copy');
    const [priceBufferCents, setPriceBufferCents] = useState<number>(1);
    const [maxOrdersPerHour, setMaxOrdersPerHour] = useState<number>(6);
    const [sweepPriceCapCents, setSweepPriceCapCents] = useState<number>(99.9);
    const [sweepMinTriggerCents, setSweepMinTriggerCents] = useState<number>(99.0);
    const [sweepMaxUsdcPerEvent, setSweepMaxUsdcPerEvent] = useState<number>(500);
    const [sweepMaxOrdersPerEvent, setSweepMaxOrdersPerEvent] = useState<number>(6);
    const [sweepMinIntervalMs, setSweepMinIntervalMs] = useState<number>(200);
    const [pendingAutoTrades, setPendingAutoTrades] = useState<any[]>([]);
    const [autoTradeHistory, setAutoTradeHistory] = useState<any[]>([]);
    const [autoTradeError, setAutoTradeError] = useState<string | null>(null);
    const [autoTradeHasKey, setAutoTradeHasKey] = useState<boolean | null>(null);
    const [paperTradeEnabled, setPaperTradeEnabled] = useState(false);
    const [paperFillRule, setPaperFillRule] = useState<'touch' | 'sweep'>('sweep');
    const [paperBookLevels, setPaperBookLevels] = useState<number>(10);
    const [paperMinFillPct, setPaperMinFillPct] = useState<number>(90);
    const [paperTradeHistory, setPaperTradeHistory] = useState<any[]>([]);
    const [paperTradeError, setPaperTradeError] = useState<string | null>(null);
    const [serverAllowCategories, setServerAllowCategories] = useState<string[]>([]);

    const [leaderboardLoading, setLeaderboardLoading] = useState(false);
    const [leaderboard, setLeaderboard] = useState<Array<{ address: string; pnl?: number; volume?: number; userName?: string }>>([]);

    const [watchlist, setWatchlist] = useState<WatchEntry[]>([]);
    const [watchLabel, setWatchLabel] = useState('');
    const [watchedCategories, setWatchedCategories] = useState<string[]>([]);

    const [address, setAddress] = useState('');
    const [queryMode, setQueryMode] = useState<QueryMode>('auto');
    const [pollMs, setPollMs] = useState(2000);
    const [limit, setLimit] = useState(100);

    const [types, setTypes] = useState<ActivityType[]>(['TRADE']);
    const [sides, setSides] = useState<ActivitySide[]>(['BUY']);
    const [includeKeywordsRaw, setIncludeKeywordsRaw] = useState('');
    const [excludeKeywordsRaw, setExcludeKeywordsRaw] = useState('');
    const [suggestionMode, setSuggestionMode] = useState<SuggestionMode>('copytrade');

    const [ratio, setRatio] = useState(0.02);
    const [maxUsdcPerOrder, setMaxUsdcPerOrder] = useState(50);
    const [maxUsdcPerDay, setMaxUsdcPerDay] = useState(500);
    const [allowConditionIds, setAllowConditionIds] = useState<string[]>([]);
    const [denyConditionIds, setDenyConditionIds] = useState<string[]>([]);
    const [minLeaderUsdc, setMinLeaderUsdc] = useState<number>(0);
    const [maxLeaderUsdc, setMaxLeaderUsdc] = useState<number | null>(null);
    const [minPrice, setMinPrice] = useState<number>(0);
    const [maxPrice, setMaxPrice] = useState<number>(1);

    const [activitiesPinned, setActivitiesPinned] = useState(false);
    const [suggestionsPinned, setSuggestionsPinned] = useState(false);
    const [activitiesOffset, setActivitiesOffset] = useState(0);
    const [suggestionsOffset, setSuggestionsOffset] = useState(0);
    const [activitiesHasMore, setActivitiesHasMore] = useState(true);
    const [suggestionsHasMore, setSuggestionsHasMore] = useState(true);
    const [activitiesPageStart, setActivitiesPageStart] = useState(0);
    const [suggestionsPageStart, setSuggestionsPageStart] = useState(0);

    const [autoRefresh, setAutoRefresh] = useState(true);
    const [liveTrackingEnabled, setLiveTrackingEnabled] = useState(false);
    const [activitySearch, setActivitySearch] = useState('');
    const [load11hLoading, setLoad11hLoading] = useState(false);
    const [activitiesAutoLoad, setActivitiesAutoLoad] = useState(true);
    const [suggestionsAutoLoad, setSuggestionsAutoLoad] = useState(true);
    const [activitiesLoadingMore, setActivitiesLoadingMore] = useState(false);
    const [suggestionsLoadingMore, setSuggestionsLoadingMore] = useState(false);
    const activitiesCardRef = useRef<HTMLDivElement | null>(null);
    const suggestionsCardRef = useRef<HTMLDivElement | null>(null);

    const addressTrim = String(address || '').trim();
    const addressValid = isHexAddress(addressTrim);

    useEffect(() => {
        const saved = readLastSettings();
        if (!saved) return;
        if (saved.address != null) setAddress(String(saved.address || ''));
        if (saved.queryMode != null) setQueryMode(String(saved.queryMode) === 'user' ? 'user' : String(saved.queryMode) === 'proxyWallet' ? 'proxyWallet' : 'auto');
        if (saved.pollMs != null) setPollMs(Math.max(500, Math.floor(Number(saved.pollMs) || 2000)));
        if (saved.limit != null) setLimit(Math.max(1, Math.min(1000, Math.floor(Number(saved.limit) || 100))));
        if (saved.types != null) setTypes((Array.isArray(saved.types) ? saved.types : []).filter((x) => ['TRADE', 'REDEEM', 'SPLIT', 'MERGE', 'CONVERSION'].includes(String(x))) as any);
        if (saved.sides != null) setSides((Array.isArray(saved.sides) ? saved.sides : []).filter((x) => ['BUY', 'SELL'].includes(String(x))) as any);
        if (saved.includeKeywordsRaw != null) setIncludeKeywordsRaw(String(saved.includeKeywordsRaw || ''));
        if (saved.excludeKeywordsRaw != null) setExcludeKeywordsRaw(String(saved.excludeKeywordsRaw || ''));
        if (saved.ratio != null) setRatio(Math.max(0, Number(saved.ratio) || 0));
        if (saved.maxUsdcPerOrder != null) setMaxUsdcPerOrder(Math.max(0, Number(saved.maxUsdcPerOrder) || 0));
        if (saved.maxUsdcPerDay != null) setMaxUsdcPerDay(Math.max(0, Number(saved.maxUsdcPerDay) || 0));
        if (saved.autoRefresh != null) setAutoRefresh(!!saved.autoRefresh);
        if (saved.suggestionMode != null) setSuggestionMode(String(saved.suggestionMode) === 'allTrades' ? 'allTrades' : String(saved.suggestionMode) === 'mirror' ? 'mirror' : String(saved.suggestionMode) === 'custom' ? 'custom' : 'copytrade');
        if (saved.minLeaderUsdc != null) setMinLeaderUsdc(Math.max(0, Number(saved.minLeaderUsdc) || 0));
        if (saved.maxLeaderUsdc !== undefined) setMaxLeaderUsdc(saved.maxLeaderUsdc == null ? null : Math.max(0, Number(saved.maxLeaderUsdc) || 0));
        if (saved.minPrice != null) setMinPrice(Math.max(0, Number(saved.minPrice) || 0));
        if (saved.maxPrice != null) setMaxPrice(Math.max(0, Number(saved.maxPrice) || 1));
        if (saved.trackedCategories != null) setWatchedCategories(normalizeStringList(saved.trackedCategories));
        if (saved.executionStyle != null) setExecutionStyle(String(saved.executionStyle) === 'sweep' ? 'sweep' : 'copy');
        if (saved.priceBufferCents != null) setPriceBufferCents(Math.max(0, Number(saved.priceBufferCents) || 0));
        if (saved.maxOrdersPerHour != null) setMaxOrdersPerHour(Math.max(0, Math.floor(Number(saved.maxOrdersPerHour) || 0)));
        if (saved.paperTradeEnabled != null) setPaperTradeEnabled(!!saved.paperTradeEnabled);
        if (saved.paperFillRule != null) setPaperFillRule(String(saved.paperFillRule) === 'touch' ? 'touch' : 'sweep');
        if (saved.paperBookLevels != null) setPaperBookLevels(Math.max(1, Math.min(50, Math.floor(Number(saved.paperBookLevels) || 10))));
        if (saved.paperMinFillPct != null) setPaperMinFillPct(Math.max(0, Math.min(100, Number(saved.paperMinFillPct) || 0)));
        if (saved.sweepPriceCapCents != null) setSweepPriceCapCents(Math.max(0.1, Math.min(99.9, Number(saved.sweepPriceCapCents) || 99.9)));
        if (saved.sweepMinTriggerCents != null) setSweepMinTriggerCents(Math.max(0, Math.min(99.9, Number(saved.sweepMinTriggerCents) || 99.0)));
        if (saved.sweepMaxUsdcPerEvent != null) setSweepMaxUsdcPerEvent(Math.max(0, Number(saved.sweepMaxUsdcPerEvent) || 0));
        if (saved.sweepMaxOrdersPerEvent != null) setSweepMaxOrdersPerEvent(Math.max(1, Math.floor(Number(saved.sweepMaxOrdersPerEvent) || 1)));
        if (saved.sweepMinIntervalMs != null) setSweepMinIntervalMs(Math.max(0, Math.floor(Number(saved.sweepMinIntervalMs) || 0)));
    }, []);

    useEffect(() => {
        setWatchlist(readWatchlist());
    }, []);

    useEffect(() => {
        if (!addressValid) return;
        const fromWatch = watchlist.find((x) => String(x.address).toLowerCase() === String(addressTrim).toLowerCase()) || null;
        const fromMem = readTracking(addressTrim);
        const mergedCats = Array.from(new Set([...(Array.isArray(fromWatch?.watchedCategories) ? fromWatch?.watchedCategories : []), ...(fromMem?.watchedCategories || [])]));
        const mergedAllow = Array.from(new Set([...(Array.isArray(fromWatch?.allowConditionIds) ? fromWatch?.allowConditionIds : []), ...(fromMem?.allowConditionIds || [])]));
        const mergedDeny = Array.from(new Set([...(Array.isArray(fromWatch?.denyConditionIds) ? fromWatch?.denyConditionIds : []), ...(fromMem?.denyConditionIds || [])]));
        setWatchedCategories(mergedCats);
        setAllowConditionIds(mergedAllow);
        setDenyConditionIds(mergedDeny);
    }, [addressValid, addressTrim, watchlist]);

    useEffect(() => {
        if (!addressValid) return;
        writeTracking(addressTrim, { watchedCategories, allowConditionIds, denyConditionIds });
    }, [addressValid, addressTrim, watchedCategories, allowConditionIds, denyConditionIds]);

    useEffect(() => {
        writeLastSettings({
            address,
            queryMode,
            pollMs,
            limit,
            types,
            sides,
            includeKeywordsRaw,
            excludeKeywordsRaw,
            ratio,
            maxUsdcPerOrder,
            maxUsdcPerDay,
            autoRefresh,
            suggestionMode,
            minLeaderUsdc,
            maxLeaderUsdc,
            minPrice,
            maxPrice,
            trackedCategories: watchedCategories,
            executionStyle,
            priceBufferCents,
            maxOrdersPerHour,
            paperTradeEnabled,
            paperFillRule,
            paperBookLevels,
            paperMinFillPct,
            sweepPriceCapCents,
            sweepMinTriggerCents,
            sweepMaxUsdcPerEvent,
            sweepMaxOrdersPerEvent,
            sweepMinIntervalMs,
        });
    }, [address, queryMode, pollMs, limit, types, sides, includeKeywordsRaw, excludeKeywordsRaw, ratio, maxUsdcPerOrder, maxUsdcPerDay, autoRefresh, suggestionMode, minLeaderUsdc, maxLeaderUsdc, minPrice, maxPrice, watchedCategories, executionStyle, priceBufferCents, maxOrdersPerHour, paperTradeEnabled, paperFillRule, paperBookLevels, paperMinFillPct, sweepPriceCapCents, sweepMinTriggerCents, sweepMaxUsdcPerEvent, sweepMaxOrdersPerEvent, sweepMinIntervalMs]);

    const upsertWatch = useCallback((entry: WatchEntry) => {
        setWatchlist((prev) => {
            const list = Array.isArray(prev) ? prev.slice() : [];
            const idx = list.findIndex((x) => String(x.address).toLowerCase() === String(entry.address).toLowerCase());
            if (idx >= 0) list[idx] = entry;
            else list.unshift(entry);
            const deduped = Array.from(new Map(list.map((x) => [String(x.address).toLowerCase(), x])).values());
            writeWatchlist(deduped);
            return deduped;
        });
    }, []);

    const removeWatch = useCallback((addr: string) => {
        const key = String(addr || '').toLowerCase();
        setWatchlist((prev) => {
            const next = (Array.isArray(prev) ? prev : []).filter((x) => String(x.address).toLowerCase() !== key);
            writeWatchlist(next);
            return next;
        });
    }, []);

    const saveCurrentToWatchlist = useCallback(() => {
        if (!addressValid) {
            message.error('地址格式錯');
            return;
        }
        const now = new Date().toISOString();
        const existing = watchlist.find((x) => String(x.address).toLowerCase() === String(addressTrim).toLowerCase());
        const createdAt = existing?.createdAt || now;
        const next: WatchEntry = {
            address: addressTrim,
            label: String(watchLabel || existing?.label || '').trim(),
            pollMs,
            limit,
            queryMode,
            types,
            sides,
            includeKeywordsRaw,
            excludeKeywordsRaw,
            ratio,
            maxUsdcPerOrder,
            maxUsdcPerDay,
            watchedCategories,
            allowConditionIds,
            denyConditionIds,
            lastConfirmAt: existing?.lastConfirmAt ?? null,
            createdAt,
            updatedAt: now,
        };
        upsertWatch(next);
        message.success('已保存到監察名單');
    }, [addressValid, addressTrim, watchLabel, pollMs, limit, queryMode, types, sides, includeKeywordsRaw, excludeKeywordsRaw, ratio, maxUsdcPerOrder, maxUsdcPerDay, watchedCategories, allowConditionIds, denyConditionIds, watchlist, upsertWatch]);

    const loadFromWatchlist = useCallback((addr: string) => {
        const entry = watchlist.find((x) => String(x.address).toLowerCase() === String(addr || '').toLowerCase());
        if (!entry) return;
        setAddress(entry.address);
        setWatchLabel(entry.label || '');
        setPollMs(Number(entry.pollMs) || 2000);
        setLimit(Number(entry.limit) || 200);
        setQueryMode(entry.queryMode || 'auto');
        setTypes(Array.isArray(entry.types) && entry.types.length ? entry.types : ['TRADE']);
        setSides(Array.isArray(entry.sides) && entry.sides.length ? entry.sides : ['BUY']);
        setIncludeKeywordsRaw(String(entry.includeKeywordsRaw || ''));
        setExcludeKeywordsRaw(String(entry.excludeKeywordsRaw || ''));
        setRatio(Number(entry.ratio) || 0.02);
        setMaxUsdcPerOrder(Number(entry.maxUsdcPerOrder) || 50);
        setMaxUsdcPerDay(Number(entry.maxUsdcPerDay) || 500);
        setWatchedCategories(Array.isArray(entry.watchedCategories) ? entry.watchedCategories : []);
        setAllowConditionIds(Array.isArray(entry.allowConditionIds) ? entry.allowConditionIds : []);
        setDenyConditionIds(Array.isArray(entry.denyConditionIds) ? entry.denyConditionIds : []);
        message.success('已載入監察設定');
    }, [watchlist]);

    const allowSet = useMemo(() => new Set((Array.isArray(allowConditionIds) ? allowConditionIds : []).map((x) => String(x || '').toLowerCase()).filter(Boolean)), [allowConditionIds]);
    const denySet = useMemo(() => new Set((Array.isArray(denyConditionIds) ? denyConditionIds : []).map((x) => String(x || '').toLowerCase()).filter(Boolean)), [denyConditionIds]);

    const persistAllowDeny = useCallback((nextAllow: string[], nextDeny: string[]) => {
        const existing = watchlist.find((x) => String(x.address).toLowerCase() === String(addressTrim).toLowerCase());
        if (!existing) return;
        const now = new Date().toISOString();
        upsertWatch({ ...existing, allowConditionIds: nextAllow, denyConditionIds: nextDeny, updatedAt: now });
    }, [watchlist, addressTrim, upsertWatch]);

    const persistWatchedCategories = useCallback((nextCats: string[]) => {
        const existing = watchlist.find((x) => String(x.address).toLowerCase() === String(addressTrim).toLowerCase());
        if (!existing) return;
        const now = new Date().toISOString();
        upsertWatch({ ...existing, watchedCategories: nextCats, updatedAt: now });
    }, [watchlist, addressTrim, upsertWatch]);

    const loadLatestPages = useCallback(async () => {
        if (!addressValid) return;
        setActivitiesPageStart(0);
        setSuggestionsPageStart(0);
        const maxAutoPages = 6;
        const minAutoItems = 250;

        const a1 = await followActivityApi.getActivitiesPage({ address: addressTrim, limit: pageSize, offset: 0, queryMode });
        let acts = Array.isArray(a1.data?.activities) ? a1.data.activities : [];
        let nextA = a1.data?.nextOffset != null ? Number(a1.data.nextOffset) : acts.length;
        let hasMoreA = a1.data?.hasMore != null ? !!a1.data.hasMore : acts.length >= pageSize;
        if (activitiesAutoLoad) {
            for (let i = 1; i < maxAutoPages && hasMoreA && acts.length < minAutoItems; i += 1) {
                const res = await followActivityApi.getActivitiesPage({ address: addressTrim, limit: pageSize, offset: nextA, queryMode });
                const rows = Array.isArray(res.data?.activities) ? res.data.activities : [];
                if (!rows.length) { hasMoreA = false; break; }
                acts = acts.concat(rows);
                nextA = res.data?.nextOffset != null ? Number(res.data.nextOffset) : (nextA + rows.length);
                hasMoreA = res.data?.hasMore != null ? !!res.data.hasMore : rows.length >= pageSize;
                await new Promise((r) => setTimeout(r, 80));
            }
        }
        const seenA = new Set<string>();
        const dedupActs: any[] = [];
        for (const r of acts) {
            const k = String(r?.transactionHash || '') + ':' + String(r?.conditionId || '') + ':' + String(r?.asset || '') + ':' + String(r?.side || '') + ':' + String(r?.price || '') + ':' + String(r?.timestamp || '');
            if (seenA.has(k)) continue;
            seenA.add(k);
            dedupActs.push(r);
        }

        const s2 = await followActivityApi.getSuggestionsPage({
            address: addressTrim,
            limit: pageSize,
            offset: 0,
            queryMode,
            types,
            sides,
            includeKeywords: parseKeywords(includeKeywordsRaw),
            excludeKeywords: parseKeywords(excludeKeywordsRaw),
            ratio,
            maxUsdcPerOrder,
            maxUsdcPerDay,
        });
        let sugs = Array.isArray(s2.data?.suggestions) ? s2.data.suggestions : [];
        let nextS = s2.data?.nextOffset != null ? Number(s2.data.nextOffset) : sugs.length;
        let hasMoreS = s2.data?.hasMore != null ? !!s2.data.hasMore : true;
        if (suggestionsAutoLoad) {
            for (let i = 1; i < maxAutoPages && hasMoreS && sugs.length < minAutoItems; i += 1) {
                const res = await followActivityApi.getSuggestionsPage({
                    address: addressTrim,
                    limit: pageSize,
                    offset: nextS,
                    queryMode,
                    types,
                    sides,
                    includeKeywords: parseKeywords(includeKeywordsRaw),
                    excludeKeywords: parseKeywords(excludeKeywordsRaw),
                    ratio,
                    maxUsdcPerOrder,
                    maxUsdcPerDay,
                });
                const rows = Array.isArray(res.data?.suggestions) ? res.data.suggestions : [];
                if (!rows.length && !(res.data?.hasMore != null ? !!res.data.hasMore : false)) { hasMoreS = false; break; }
                sugs = sugs.concat(rows);
                nextS = res.data?.nextOffset != null ? Number(res.data.nextOffset) : (nextS + (Array.isArray(res.data?.suggestions) ? res.data.suggestions.length : 0));
                hasMoreS = res.data?.hasMore != null ? !!res.data.hasMore : hasMoreS;
                await new Promise((r) => setTimeout(r, 80));
            }
        }
        const seenS = new Set<string>();
        const dedupSugs: any[] = [];
        for (const r of sugs) {
            const k = String(r?.id || '') || (String(r?.at || '') + ':' + String(r?.conditionId || '') + ':' + String(r?.asset || ''));
            if (seenS.has(k)) continue;
            seenS.add(k);
            dedupSugs.push(r);
        }

        setActivities(dedupActs);
        setSuggestions(dedupSugs);
        setActivitiesOffset(Number.isFinite(nextA) ? Math.max(0, Math.floor(nextA)) : dedupActs.length);
        setSuggestionsOffset(Number.isFinite(nextS) ? Math.max(0, Math.floor(nextS)) : dedupSugs.length);
        setActivitiesHasMore(hasMoreA);
        setSuggestionsHasMore(hasMoreS);
        setActivitiesPinned(false);
        setSuggestionsPinned(false);
    }, [addressValid, addressTrim, pageSize, queryMode, types, sides, includeKeywordsRaw, excludeKeywordsRaw, ratio, maxUsdcPerOrder, maxUsdcPerDay, activitiesAutoLoad, suggestionsAutoLoad]);

    const loadOlderActivities = useCallback(async () => {
        if (!addressValid) return;
        if (!activitiesHasMore) return;
        if (activitiesLoadingMore) return;
        setActivitiesLoadingMore(true);
        const reqOffset = activitiesOffset;
        try {
            const a1 = await followActivityApi.getActivitiesPage({ address: addressTrim, limit: pageSize, offset: activitiesOffset, queryMode });
            const nextA = a1.data?.nextOffset != null ? Number(a1.data.nextOffset) : (activitiesOffset + pageSize);
            const rows = Array.isArray(a1.data?.activities) ? a1.data.activities : [];
            if (!rows.length) {
                message.info('No older activities');
                setActivitiesHasMore(false);
                return;
            }
            setActivitiesPageStart(reqOffset);
            setActivities((prev) => {
                const base = Array.isArray(prev) ? prev : [];
                const merged = [...base, ...rows];
                const seen = new Set<string>();
                const out: any[] = [];
                for (const r of merged) {
                    const k = String(r?.transactionHash || '') + ':' + String(r?.conditionId || '') + ':' + String(r?.asset || '') + ':' + String(r?.side || '') + ':' + String(r?.price || '') + ':' + String(r?.timestamp || '');
                    if (seen.has(k)) continue;
                    seen.add(k);
                    out.push(r);
                }
                return out;
            });
            setActivitiesOffset(Number.isFinite(nextA) ? Math.max(0, Math.floor(nextA)) : (activitiesOffset + pageSize));
            setActivitiesHasMore(a1.data?.hasMore != null ? !!a1.data.hasMore : rows.length >= pageSize);
            setActivitiesPinned(true);
        } finally {
            setActivitiesLoadingMore(false);
        }
    }, [addressValid, activitiesHasMore, addressTrim, pageSize, activitiesOffset, queryMode, activitiesLoadingMore]);

    const loadLastHours = useCallback(async (hours: number) => {
        if (!addressValid) return;
        const cutoffMs = Date.now() - Math.max(1, Math.floor(Number(hours) || 11)) * 60 * 60 * 1000;
        try {
            setLoad11hLoading(true);
            setActivities([]);
            setActivitiesPinned(false);
            setActivitiesHasMore(true);
            setActivitiesOffset(0);
            setActivitiesPageStart(0);

            let offset = 0;
            let hasMore = true;
            let nextOffset = 0;
            for (let i = 0; i < 50; i += 1) {
                const a1 = await followActivityApi.getActivitiesPage({ address: addressTrim, limit: pageSize, offset, queryMode });
                const rows = Array.isArray(a1.data?.activities) ? a1.data.activities : [];
                nextOffset = a1.data?.nextOffset != null ? Number(a1.data.nextOffset) : (offset + rows.length);
                hasMore = a1.data?.hasMore != null ? !!a1.data.hasMore : rows.length >= pageSize;
                if (!rows.length) break;
                setActivities((prev) => {
                    const base = Array.isArray(prev) ? prev : [];
                    const merged = [...base, ...rows];
                    const seen = new Set<string>();
                    const out: any[] = [];
                    for (const r of merged) {
                        const k = String(r?.transactionHash || '') + ':' + String(r?.conditionId || '') + ':' + String(r?.asset || '') + ':' + String(r?.side || '') + ':' + String(r?.price || '') + ':' + String(r?.timestamp || '');
                        if (seen.has(k)) continue;
                        seen.add(k);
                        out.push(r);
                    }
                    return out;
                });
                const oldest = rows[rows.length - 1];
                if (toMs(oldest?.timestamp) <= cutoffMs) break;
                offset = Number.isFinite(nextOffset) ? Math.max(0, Math.floor(nextOffset)) : (offset + rows.length);
                if (!hasMore) break;
            }

            setActivitiesOffset(Number.isFinite(nextOffset) ? Math.max(0, Math.floor(nextOffset)) : offset);
            setActivitiesHasMore(hasMore);
            message.success(`Loaded last ${hours}h`);
        } catch (e: any) {
            message.error(e?.response?.data?.error || e?.message || 'Load failed');
        } finally {
            setLoad11hLoading(false);
        }
    }, [addressValid, addressTrim, pageSize, queryMode]);

    const loadOlderSuggestions = useCallback(async () => {
        if (!addressValid) return;
        if (!suggestionsHasMore) return;
        if (suggestionsLoadingMore) return;
        setSuggestionsLoadingMore(true);
        const maxSkipPages = 5;
        let reqOffset = suggestionsOffset;
        let nextOffset = suggestionsOffset;
        let hasMore = true;
        let rows: any[] = [];

        for (let i = 0; i < maxSkipPages; i += 1) {
            const s1 = await followActivityApi.getSuggestionsPage({
                address: addressTrim,
                limit: pageSize,
                offset: reqOffset,
                queryMode,
                types,
                sides,
                includeKeywords: parseKeywords(includeKeywordsRaw),
                excludeKeywords: parseKeywords(excludeKeywordsRaw),
                ratio,
                maxUsdcPerOrder,
                maxUsdcPerDay,
            });
            nextOffset = s1.data?.nextOffset != null ? Number(s1.data.nextOffset) : (reqOffset + pageSize);
            hasMore = s1.data?.hasMore != null ? !!s1.data.hasMore : true;
            rows = Array.isArray(s1.data?.suggestions) ? s1.data.suggestions : [];
            if (rows.length) break;
            if (!hasMore) break;
            reqOffset = Number.isFinite(nextOffset) ? Math.max(0, Math.floor(nextOffset)) : (reqOffset + pageSize);
        }

        setSuggestionsHasMore(hasMore);
        if (!rows.length) {
            message.info(hasMore ? 'This range has no matching suggestions (skipped)' : 'No older suggestions');
            setSuggestionsOffset(Number.isFinite(nextOffset) ? Math.max(0, Math.floor(nextOffset)) : (suggestionsOffset + pageSize));
            setSuggestionsLoadingMore(false);
            return;
        }

        setSuggestionsPageStart(reqOffset);
        setSuggestions((prev) => {
            const base = Array.isArray(prev) ? prev : [];
            const merged = [...base, ...rows];
            const seen = new Set<string>();
            const out: any[] = [];
            for (const r of merged) {
                const k = String(r?.id || '') || (String(r?.at || '') + ':' + String(r?.conditionId || '') + ':' + String(r?.asset || ''));
                if (seen.has(k)) continue;
                seen.add(k);
                out.push(r);
            }
            return out;
        });
        setSuggestionsOffset(Number.isFinite(nextOffset) ? Math.max(0, Math.floor(nextOffset)) : (suggestionsOffset + pageSize));
        setSuggestionsPinned(true);
        setSuggestionsLoadingMore(false);
    }, [addressValid, suggestionsHasMore, addressTrim, pageSize, suggestionsOffset, queryMode, types, sides, includeKeywordsRaw, excludeKeywordsRaw, ratio, maxUsdcPerOrder, maxUsdcPerDay, suggestionsLoadingMore]);

    useEffect(() => {
        if (!addressValid) return;
        const onScroll = () => {
            if (activitiesAutoLoad && activitiesHasMore && !activitiesLoadingMore && !load11hLoading) {
                const el = activitiesCardRef.current;
                if (el) {
                    const rect = el.getBoundingClientRect();
                    if (rect.bottom - window.innerHeight < 220) {
                        loadOlderActivities();
                    }
                }
            }
            if (suggestionsAutoLoad && suggestionsHasMore && !suggestionsLoadingMore) {
                const el = suggestionsCardRef.current;
                if (el) {
                    const rect = el.getBoundingClientRect();
                    if (rect.bottom - window.innerHeight < 220) {
                        loadOlderSuggestions();
                    }
                }
            }
        };
        window.addEventListener('scroll', onScroll, { passive: true });
        onScroll();
        return () => {
            window.removeEventListener('scroll', onScroll as any);
        };
    }, [addressValid, activitiesAutoLoad, activitiesHasMore, activitiesLoadingMore, suggestionsAutoLoad, suggestionsHasMore, suggestionsLoadingMore, loadOlderActivities, loadOlderSuggestions, load11hLoading]);

    const toggleAllow = useCallback((conditionId: string) => {
        const cid = String(conditionId || '').trim();
        if (!cid) return;
        const key = cid.toLowerCase();
        const nextAllow = allowSet.has(key)
            ? (Array.isArray(allowConditionIds) ? allowConditionIds : []).filter((x) => String(x || '').toLowerCase() !== key)
            : [cid, ...(Array.isArray(allowConditionIds) ? allowConditionIds : []).filter((x) => String(x || '').toLowerCase() !== key)];
        const nextDeny = (Array.isArray(denyConditionIds) ? denyConditionIds : []).filter((x) => String(x || '').toLowerCase() !== key);
        setAllowConditionIds(nextAllow);
        setDenyConditionIds(nextDeny);
        persistAllowDeny(nextAllow, nextDeny);
    }, [allowSet, allowConditionIds, denyConditionIds, persistAllowDeny]);

    const toggleDeny = useCallback((conditionId: string) => {
        const cid = String(conditionId || '').trim();
        if (!cid) return;
        const key = cid.toLowerCase();
        const nextDeny = denySet.has(key)
            ? (Array.isArray(denyConditionIds) ? denyConditionIds : []).filter((x) => String(x || '').toLowerCase() !== key)
            : [cid, ...(Array.isArray(denyConditionIds) ? denyConditionIds : []).filter((x) => String(x || '').toLowerCase() !== key)];
        const nextAllow = (Array.isArray(allowConditionIds) ? allowConditionIds : []).filter((x) => String(x || '').toLowerCase() !== key);
        setAllowConditionIds(nextAllow);
        setDenyConditionIds(nextDeny);
        persistAllowDeny(nextAllow, nextDeny);
    }, [denySet, allowConditionIds, denyConditionIds, persistAllowDeny]);

    const loadLeaderboard = useCallback(async () => {
        try {
            setLeaderboardLoading(true);
            const res = await walletApi.getLeaderboard(200, 'ALL');
            setLeaderboard(Array.isArray(res.data) ? res.data : []);
        } catch {
            setLeaderboard([]);
        } finally {
            setLeaderboardLoading(false);
        }
    }, []);

    const checkApi = useCallback(async (options?: { silent?: boolean }) => {
        const silent = options?.silent === true;
        try {
            const v = await versionApi.getVersion();
            const info = v?.data || null;
            setApiInfo(info);
            setApiOk(true);
            return true;
        } catch (e: any) {
            setApiInfo(null);
            setApiOk(false);
            if (!silent) {
                const msg = e?.message || 'API unreachable';
                setUiError(`API unreachable: ${msg}`);
            }
            return false;
        }
    }, []);

    const refresh = useCallback(async (options?: { silent?: boolean }) => {
        const silent = options?.silent === true;
        try {
            if (!silent) setLoading(true);
            if (!silent) setUiError(null);
            const ok = await checkApi({ silent });
            if (!ok) return;

            const s1 = await followActivityApi.getStatus();
            const st = s1.data?.status || null;
            setStatus(st);
            const isRunning = !!st?.running;
            setRunning(isRunning);

            if (isRunning) {
                if (!activitiesPinned) {
                    const a1 = await followActivityApi.getActivitiesPage({ address: addressTrim, limit: pageSize, offset: 0, queryMode });
                    setActivities(Array.isArray(a1.data?.activities) ? a1.data.activities : []);
                    const nextA = a1.data?.nextOffset != null ? Number(a1.data.nextOffset) : pageSize;
                    setActivitiesOffset(Number.isFinite(nextA) ? Math.max(0, Math.floor(nextA)) : pageSize);
                    setActivitiesHasMore(a1.data?.hasMore != null ? !!a1.data.hasMore : true);
                }
                if (!suggestionsPinned) {
                    const s2 = await followActivityApi.getSuggestionsPage({
                        address: addressTrim,
                        limit: pageSize,
                        offset: 0,
                        queryMode,
                        types,
                        sides,
                        includeKeywords: parseKeywords(includeKeywordsRaw),
                        excludeKeywords: parseKeywords(excludeKeywordsRaw),
                        ratio,
                        maxUsdcPerOrder,
                        maxUsdcPerDay,
                    });
                    setSuggestions(Array.isArray(s2.data?.suggestions) ? s2.data.suggestions : []);
                    const nextS = s2.data?.nextOffset != null ? Number(s2.data.nextOffset) : pageSize;
                    setSuggestionsOffset(Number.isFinite(nextS) ? Math.max(0, Math.floor(nextS)) : pageSize);
                    setSuggestionsHasMore(s2.data?.hasMore != null ? !!s2.data.hasMore : true);
                }
            }
        } catch (e: any) {
            const msg = e?.response?.data?.error || e?.message || 'Refresh failed';
            if (!silent) setUiError(String(msg));
        } finally {
            if (!silent) setLoading(false);
        }
    }, [checkApi, activitiesPinned, suggestionsPinned, pageSize, addressTrim, addressValid, queryMode, types, sides, includeKeywordsRaw, excludeKeywordsRaw, ratio, maxUsdcPerOrder, maxUsdcPerDay]);

    const refreshAutoTrade = useCallback(async (options?: { silent?: boolean }) => {
        const silent = options?.silent === true;
        try {
            if (!silent) setAutoTradeLoading(true);
            const ok = await checkApi({ silent: true });
            if (!ok) return;
            const st = await followActivityApi.getAutoTradeStatus();
            const s = st.data?.status || null;
            const cfg = st.data?.config || null;
            setAutoTradeEnabled(!!cfg?.enabled);
            setAutoTradeMode(String(cfg?.mode) === 'auto' ? 'auto' : 'queue');
            setExecutionStyle(String(cfg?.executionStyle) === 'sweep' ? 'sweep' : 'copy');
            setServerAllowCategories(Array.isArray(cfg?.allowCategories) ? cfg.allowCategories.map((x: any) => String(x || '').toLowerCase()).filter(Boolean) : []);
            setPriceBufferCents(cfg?.priceBufferCents != null ? Number(cfg.priceBufferCents) : 1);
            setMaxOrdersPerHour(cfg?.maxOrdersPerHour != null ? Number(cfg.maxOrdersPerHour) : 6);
            setPaperTradeEnabled(!!cfg?.paperTradeEnabled);
            setPaperFillRule(String(cfg?.paperFillRule) === 'touch' ? 'touch' : 'sweep');
            setPaperBookLevels(cfg?.paperBookLevels != null ? Number(cfg.paperBookLevels) : 10);
            setPaperMinFillPct(cfg?.paperMinFillPct != null ? Number(cfg.paperMinFillPct) : 90);
            setSweepPriceCapCents(cfg?.sweepPriceCapCents != null ? Number(cfg.sweepPriceCapCents) : 99.9);
            setSweepMinTriggerCents(cfg?.sweepMinTriggerCents != null ? Number(cfg.sweepMinTriggerCents) : 99.0);
            setSweepMaxUsdcPerEvent(cfg?.sweepMaxUsdcPerEvent != null ? Number(cfg.sweepMaxUsdcPerEvent) : 500);
            setSweepMaxOrdersPerEvent(cfg?.sweepMaxOrdersPerEvent != null ? Number(cfg.sweepMaxOrdersPerEvent) : 6);
            setSweepMinIntervalMs(cfg?.sweepMinIntervalMs != null ? Number(cfg.sweepMinIntervalMs) : 200);
            setAutoTradeError(s?.lastError != null ? String(s.lastError) : null);
            setAutoTradeHasKey(s?.hasPrivateKey != null ? !!s.hasPrivateKey : null);
            const [p, h, ph] = await Promise.all([
                followActivityApi.getAutoTradePending(200),
                followActivityApi.getAutoTradeHistory(200),
                followActivityApi.getPaperTradeHistory(200),
            ]);
            setPendingAutoTrades(Array.isArray(p.data?.pending) ? p.data.pending : []);
            setAutoTradeHistory(Array.isArray(h.data?.history) ? h.data.history : []);
            setPaperTradeHistory(Array.isArray(ph.data?.history) ? ph.data.history : []);
            setPaperTradeError(null);
        } catch (e: any) {
            const msg = e?.response?.data?.error || e?.message || 'autotrade refresh failed';
            if (!silent) setAutoTradeError(msg);
            if (!silent) setPaperTradeError(msg);
        } finally {
            if (!silent) setAutoTradeLoading(false);
        }
    }, [checkApi]);

    const syncAutoTradeConfig = useCallback(async (overrides?: Partial<{ enabled: boolean; paperTradeEnabled: boolean }>) => {
        try {
            setAutoTradeLoading(true);
            setAutoTradeError(null);
            await followActivityApi.updateAutoTradeConfig({
                enabled: overrides?.enabled != null ? overrides.enabled : autoTradeEnabled,
                mode: autoTradeMode,
                executionStyle,
                allowConditionIds,
                allowCategories: watchedCategories,
                denyConditionIds,
                priceBufferCents,
                maxOrdersPerHour,
                paperTradeEnabled: overrides?.paperTradeEnabled != null ? overrides.paperTradeEnabled : paperTradeEnabled,
                paperFillRule,
                paperBookLevels,
                paperMinFillPct,
                sweepPriceCapCents,
                sweepMinTriggerCents,
                sweepMaxUsdcPerEvent,
                sweepMaxOrdersPerEvent,
                sweepMinIntervalMs,
            });
            await refreshAutoTrade({ silent: true });
            message.success('AutoTrade 已同步');
        } catch (e: any) {
            setAutoTradeError(e?.response?.data?.error || e?.message || 'AutoTrade sync failed');
        } finally {
            setAutoTradeLoading(false);
        }
    }, [autoTradeEnabled, autoTradeMode, executionStyle, allowConditionIds, watchedCategories, denyConditionIds, priceBufferCents, maxOrdersPerHour, paperTradeEnabled, paperFillRule, paperBookLevels, paperMinFillPct, sweepPriceCapCents, sweepMinTriggerCents, sweepMaxUsdcPerEvent, sweepMaxOrdersPerEvent, sweepMinIntervalMs, refreshAutoTrade]);

    const autoSyncTimerRef = useRef<any>(null);
    const lastAutoSyncKeyRef = useRef<string>('');
    const autoSyncKey = useMemo(() => {
        const norm = (arr: any) => Array.from(new Set((Array.isArray(arr) ? arr : []).map((x) => String(x || '').toLowerCase()).filter(Boolean))).sort();
        const payload = {
            enabled: !!autoTradeEnabled,
            mode: autoTradeMode,
            executionStyle,
            allowConditionIds: norm(allowConditionIds),
            allowCategories: norm(watchedCategories),
            denyConditionIds: norm(denyConditionIds),
            priceBufferCents: Number(priceBufferCents) || 0,
            maxOrdersPerHour: Math.floor(Number(maxOrdersPerHour) || 0),
            paperTradeEnabled: !!paperTradeEnabled,
            paperFillRule,
            paperBookLevels: Math.floor(Number(paperBookLevels) || 0),
            paperMinFillPct: Number(paperMinFillPct) || 0,
            sweepPriceCapCents: Number(sweepPriceCapCents) || 0,
            sweepMinTriggerCents: Number(sweepMinTriggerCents) || 0,
            sweepMaxUsdcPerEvent: Number(sweepMaxUsdcPerEvent) || 0,
            sweepMaxOrdersPerEvent: Math.floor(Number(sweepMaxOrdersPerEvent) || 0),
            sweepMinIntervalMs: Math.floor(Number(sweepMinIntervalMs) || 0),
        };
        return JSON.stringify(payload);
    }, [autoTradeEnabled, autoTradeMode, executionStyle, allowConditionIds, watchedCategories, denyConditionIds, priceBufferCents, maxOrdersPerHour, paperTradeEnabled, paperFillRule, paperBookLevels, paperMinFillPct, sweepPriceCapCents, sweepMinTriggerCents, sweepMaxUsdcPerEvent, sweepMaxOrdersPerEvent, sweepMinIntervalMs]);

    useEffect(() => {
        if (!paperTradeEnabled && !autoTradeEnabled) return;
        if (autoSyncKey === lastAutoSyncKeyRef.current) return;
        if (autoSyncTimerRef.current) clearTimeout(autoSyncTimerRef.current);
        autoSyncTimerRef.current = setTimeout(async () => {
            lastAutoSyncKeyRef.current = autoSyncKey;
            try {
                const parsed = JSON.parse(autoSyncKey);
                await followActivityApi.updateAutoTradeConfig(parsed);
                await refreshAutoTrade({ silent: true });
            } catch {
            }
        }, 700);
        return () => {
            if (autoSyncTimerRef.current) clearTimeout(autoSyncTimerRef.current);
        };
    }, [autoSyncKey, paperTradeEnabled, autoTradeEnabled, refreshAutoTrade]);

    const clearPaperTrade = useCallback(async () => {
        try {
            setAutoTradeLoading(true);
            await followActivityApi.clearPaperTradeHistory(50);
            await refreshAutoTrade({ silent: true });
            message.success('已清理舊 Demo 記錄（保留最近50）');
        } catch (e: any) {
            setPaperTradeError(e?.response?.data?.error || e?.message || 'Clear demo failed');
        } finally {
            setAutoTradeLoading(false);
        }
    }, [refreshAutoTrade]);

    const executePending = useCallback(async (id: string) => {
        try {
            setAutoTradeLoading(true);
            await followActivityApi.executeAutoTradePending(id);
            await refreshAutoTrade({ silent: true });
            message.success('已執行');
        } catch (e: any) {
            setAutoTradeError(e?.response?.data?.error || e?.message || 'Execute failed');
        } finally {
            setAutoTradeLoading(false);
        }
    }, [refreshAutoTrade]);

    const clearPending = useCallback(async () => {
        try {
            setAutoTradeLoading(true);
            await followActivityApi.clearAutoTradePending(50);
            await refreshAutoTrade({ silent: true });
            message.success('已清理舊 Pending（保留最近50）');
        } catch (e: any) {
            setAutoTradeError(e?.response?.data?.error || e?.message || 'Clear failed');
        } finally {
            setAutoTradeLoading(false);
        }
    }, [refreshAutoTrade]);

    const copyText = useCallback(async (text: string) => {
        try {
            await navigator.clipboard.writeText(String(text || ''));
            message.success('Copied');
        } catch (e: any) {
            message.error(e?.message || 'Copy failed');
        }
    }, []);

    const paperLogsJson = useMemo(() => JSON.stringify((Array.isArray(paperTradeHistory) ? paperTradeHistory : []).slice(0, 100), null, 2), [paperTradeHistory]);
    const autoTradeLogsJson = useMemo(() => JSON.stringify((Array.isArray(autoTradeHistory) ? autoTradeHistory : []).slice(0, 100), null, 2), [autoTradeHistory]);

    useEffect(() => {
        refresh();
    }, [refresh]);

    useEffect(() => {
        if (!autoRefresh) return;
        const t = setInterval(() => {
            refresh({ silent: true });
            refreshAutoTrade({ silent: true });
        }, Math.max(500, Math.floor(Number(pollMs) || 2000)));
        return () => clearInterval(t);
    }, [autoRefresh, refresh, refreshAutoTrade, pollMs]);

    const confirmOnce = useCallback(async () => {
        try {
            setConfirmLoading(true);
            setUiError(null);
            const ok = await checkApi();
            if (!ok) return;
            const payload = {
                address: addressTrim,
                limit,
                queryMode,
                types,
                sides,
                includeKeywords: parseKeywords(includeKeywordsRaw),
                excludeKeywords: parseKeywords(excludeKeywordsRaw),
                ratio,
                maxUsdcPerOrder,
                maxUsdcPerDay,
            };
            const res = await followActivityApi.confirm(payload);
            const acts = Array.isArray(res.data?.activities) ? res.data.activities : [];
            const sugs = Array.isArray(res.data?.suggestions) ? res.data.suggestions : [];
            const actsPage = acts.slice(0, pageSize);
            const sugsPage = sugs.slice(0, pageSize);
            setActivities(actsPage);
            setSuggestions(sugsPage);
            setActivitiesOffset(pageSize);
            setSuggestionsOffset(pageSize);
            setActivitiesHasMore(true);
            setSuggestionsHasMore(true);
            setActivitiesPinned(false);
            setSuggestionsPinned(false);
            const s1 = await followActivityApi.getStatus();
            const st = s1.data?.status || null;
            setStatus(st);
            setRunning(!!st?.running);
            const now = new Date().toISOString();
            const existing = watchlist.find((x) => String(x.address).toLowerCase() === String(addressTrim).toLowerCase());
            if (existing) {
                upsertWatch({ ...existing, lastConfirmAt: now, updatedAt: now });
            }
            message.success('Confirmed');
        } catch (e: any) {
            const msg = e?.response?.data?.error || e?.message || 'Confirm failed';
            setUiError(String(msg));
        } finally {
            setConfirmLoading(false);
        }
    }, [addressTrim, limit, queryMode, types, sides, includeKeywordsRaw, excludeKeywordsRaw, ratio, maxUsdcPerOrder, maxUsdcPerDay, checkApi, watchlist, upsertWatch, pageSize]);

    const startTracking = useCallback(async () => {
        try {
            setTrackLoading(true);
            setUiError(null);
            const ok = await checkApi();
            if (!ok) return;
            const payload = {
                address: addressTrim,
                pollMs,
                limit,
                queryMode,
                types,
                sides,
                includeKeywords: parseKeywords(includeKeywordsRaw),
                excludeKeywords: parseKeywords(excludeKeywordsRaw),
                ratio,
                maxUsdcPerOrder,
                maxUsdcPerDay,
            };
            const res = await followActivityApi.start(payload);
            const st = res.data?.status || null;
            setStatus(st);
            setRunning(!!st?.running);
            message.success('Tracking started');
            refresh();
        } catch (e: any) {
            const msg = e?.response?.data?.error || e?.message || 'Start tracking failed';
            setUiError(String(msg));
        } finally {
            setTrackLoading(false);
        }
    }, [addressTrim, pollMs, limit, queryMode, types, sides, includeKeywordsRaw, excludeKeywordsRaw, ratio, maxUsdcPerOrder, maxUsdcPerDay, checkApi, refresh]);

    const stop = useCallback(async () => {
        try {
            setStopLoading(true);
            const res = await followActivityApi.stop();
            const st = res.data?.status || null;
            setStatus(st);
            setRunning(!!st?.running);
            message.success('Stopped tracking');
            refresh();
        } catch (e: any) {
            const msg = e?.response?.data?.error || e?.message || 'Stop failed';
            setUiError(String(msg));
        } finally {
            setStopLoading(false);
        }
    }, [refresh]);

    const suggestionsView = useMemo(() => {
        const list = Array.isArray(suggestions) ? suggestions : [];
        const track = new Set((Array.isArray(watchedCategories) ? watchedCategories : []).map((x) => String(x || '').toLowerCase()).filter(Boolean));
        const filteredByCat = track.size
            ? list.filter((x) => track.has(String(x?.category || 'other').toLowerCase()))
            : list;

        const maxL = maxLeaderUsdc != null && Number.isFinite(Number(maxLeaderUsdc)) ? Number(maxLeaderUsdc) : null;
        const minL = Number(minLeaderUsdc) || 0;
        const minP = Number(minPrice);
        const maxP = Number(maxPrice);

        return filteredByCat.filter((x) => {
            const leader = Number(x?.leaderUsdc);
            const price = Number(x?.leaderPrice);
            if (!(Number.isFinite(leader) && leader >= minL)) return false;
            if (maxL != null && Number.isFinite(maxL) && leader > maxL) return false;
            if (!(Number.isFinite(price) && price >= minP && price <= maxP)) return false;
            const cid = String(x?.conditionId || '').toLowerCase();
            if (denySet.has(cid)) return false;
            return true;
        });
    }, [suggestions, watchedCategories, minLeaderUsdc, maxLeaderUsdc, minPrice, maxPrice, denySet]);

    const marketSummary = useMemo(() => {
        const grouped = new Map<string, any>();
        for (const s of suggestionsView) {
            const cid = String(s?.conditionId || '').trim();
            if (!cid) continue;
            const prev = grouped.get(cid) || {
                conditionId: cid,
                title: s?.title || null,
                slug: s?.slug || null,
                category: s?.category || 'other',
                count: 0,
                totalLeaderUsdc: 0,
                avgPrice: 0,
                lastAt: 0,
            };
            const leader = Number(s?.leaderUsdc) || 0;
            const price = Number(s?.leaderPrice) || 0;
            const at = Number(s?.at) || 0;
            const nextCount = Number(prev.count || 0) + 1;
            const nextTotal = Number(prev.totalLeaderUsdc || 0) + leader;
            const nextAvg = nextTotal > 0 ? ((prev.avgPrice * (nextCount - 1) + price) / nextCount) : 0;
            grouped.set(cid, {
                ...prev,
                count: nextCount,
                totalLeaderUsdc: nextTotal,
                avgPrice: nextAvg,
                lastAt: Math.max(Number(prev.lastAt || 0), at),
                title: prev.title || s?.title || null,
                slug: prev.slug || s?.slug || null,
                category: prev.category || s?.category || 'other',
            });
        }
        return Array.from(grouped.values()).sort((a, b) => Number(b.totalLeaderUsdc) - Number(a.totalLeaderUsdc));
    }, [suggestionsView]);

    const activitiesView = useMemo(() => {
        const list = Array.isArray(activities) ? activities : [];
        const q = String(activitySearch || '').trim().toLowerCase();
        const filtered = q ? list.filter((r) => {
            const hay = `${r?.title || ''} ${r?.slug || ''} ${r?.outcome || ''} ${r?.conditionId || ''} ${r?.transactionHash || ''}`.toLowerCase();
            return hay.includes(q);
        }) : list;
        return filtered.slice(0, 3000);
    }, [activities, activitySearch]);

    return (
        <div>
            <Title level={3} style={{ color: '#fff', marginBottom: 16 }}>FollowActivity</Title>
            <div style={{ marginBottom: 10 }}>
                <Text style={{ color: '#777' }}>
                    Direct: <Text copyable style={{ color: '#777' }}>{typeof window !== 'undefined' ? `${window.location.origin}/follow-activity` : '/follow-activity'}</Text>
                </Text>
            </div>

            <Card size="small" style={{ background: '#1f1f1f', borderColor: '#333' }}>
                <Space wrap style={{ marginBottom: 10 }}>
                    <span style={{ color: '#aaa' }}>Watchlist</span>
                    <Select
                        showSearch
                        allowClear
                        placeholder="Load from watchlist"
                        style={{ width: 360 }}
                        value={undefined}
                        onChange={(v) => v ? loadFromWatchlist(String(v)) : null}
                        options={watchlist.map((x) => ({
                            value: x.address,
                            label: `${x.label ? `${x.label} ` : ''}${x.address.slice(0, 10)}…${x.lastConfirmAt ? ` (${String(x.lastConfirmAt).slice(0, 19)})` : ''}`,
                        }))}
                    />
                    <Input style={{ width: 160 }} placeholder="label" value={watchLabel} onChange={(e) => setWatchLabel(e.target.value)} />
                    <Button disabled={!addressValid} onClick={saveCurrentToWatchlist}>Save</Button>
                    <Button danger disabled={!addressValid} onClick={() => { removeWatch(addressTrim); message.success('已移除'); }}>Remove</Button>
                </Space>
                <Space wrap>
                    <span style={{ color: '#aaa' }}>Target</span>
                    <Input
                        style={{ width: 360 }}
                        status={addressTrim && !addressValid ? 'error' : undefined}
                        placeholder="0x... wallet address"
                        value={address}
                        onChange={(e) => setAddress(e.target.value)}
                        onPressEnter={() => { confirmOnce(); }}
                    />
                    <Button loading={leaderboardLoading} onClick={loadLeaderboard}>Load Top</Button>
                    <Select
                        showSearch
                        allowClear
                        placeholder="Pick from leaderboard"
                        style={{ width: 360 }}
                        value={undefined}
                        onChange={(v) => setAddress(String(v || ''))}
                        options={leaderboard.map((x) => ({ value: x.address, label: `${x.userName ? `${x.userName} ` : ''}${x.address.slice(0, 10)}…` }))}
                    />
                    <span style={{ color: '#aaa' }}>Query</span>
                    <Select
                        value={queryMode}
                        onChange={(v) => setQueryMode(v as QueryMode)}
                        style={{ width: 140 }}
                        options={[
                            { value: 'auto', label: 'auto' },
                            { value: 'user', label: 'user' },
                            { value: 'proxyWallet', label: 'proxyWallet' },
                        ]}
                    />
                    <span style={{ color: '#aaa' }}>Poll(ms)</span>
                    <InputNumber min={250} max={120000} value={pollMs} onChange={(v) => setPollMs(Number(v))} />
                    <span style={{ color: '#aaa' }}>Limit</span>
                    <InputNumber min={1} max={500} value={limit} onChange={(v) => setLimit(Number(v))} />
                    <Button type="primary" loading={confirmLoading} disabled={!addressValid} onClick={confirmOnce}>Confirm</Button>
                    <Checkbox checked={liveTrackingEnabled} onChange={(e) => setLiveTrackingEnabled(e.target.checked)}>Live Tracking</Checkbox>
                    {liveTrackingEnabled ? (
                        <>
                            <Button loading={trackLoading} disabled={!addressValid} onClick={startTracking}>Track Live</Button>
                            <Button danger loading={stopLoading} disabled={!running} onClick={stop}>Stop Tracking</Button>
                        </>
                    ) : null}
                    <Button icon={<ReloadOutlined />} loading={loading} onClick={() => refresh()}>Refresh</Button>
                    <Checkbox checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)}>Auto Refresh</Checkbox>
                    <Tag color={running ? 'green' : 'default'}>{running ? 'RUNNING' : 'STOPPED'}</Tag>
                    <Tag color={apiOk === true ? 'green' : apiOk === false ? 'red' : 'default'}>{apiOk === true ? 'API OK' : apiOk === false ? 'API DOWN' : 'API ?'}</Tag>
                </Space>
                <div style={{ marginTop: 6 }}>
                    <Text style={{ color: '#aaa' }}>Confirm 只會抓取活動數據做分析；不會下單。</Text>
                    {apiInfo?.api ? <Text style={{ color: '#555' }}> API v{String(apiInfo.api)} / SDK v{String(apiInfo.sdk || '-')}</Text> : null}
                </div>
                {addressTrim && !addressValid ? (
                    <div style={{ marginTop: 6 }}>
                        <Text style={{ color: '#ff7875' }}>地址格式錯：需要 0x + 40 hex</Text>
                    </div>
                ) : null}
                {uiError ? (
                    <div style={{ marginTop: 6 }}>
                        <Text style={{ color: '#ff7875' }}>{uiError}</Text>
                    </div>
                ) : null}
                <div style={{ marginTop: 10 }}>
                    <Space wrap>
                        <span style={{ color: '#aaa' }}>Sug Mode</span>
                        <Select
                            value={suggestionMode}
                            onChange={(v) => {
                                const m = v as SuggestionMode;
                                setSuggestionMode(m);
                                if (m === 'copytrade') {
                                    setTypes(['TRADE']);
                                    setSides(['BUY']);
                                } else if (m === 'allTrades') {
                                    setTypes(['TRADE']);
                                    setSides(['BUY', 'SELL']);
                                } else if (m === 'mirror') {
                                    setTypes(['TRADE', 'REDEEM', 'SPLIT', 'MERGE', 'CONVERSION']);
                                    setSides(['BUY', 'SELL']);
                                }
                            }}
                            style={{ width: 160 }}
                            options={[
                                { value: 'copytrade', label: 'CopyTrade' },
                                { value: 'allTrades', label: 'All Trades' },
                                { value: 'mirror', label: 'Mirror' },
                                { value: 'custom', label: 'Custom' },
                            ]}
                        />
                        <span style={{ color: '#aaa' }}>Types</span>
                        <Select
                            mode="multiple"
                            value={types}
                            onChange={(v) => { setTypes(v as ActivityType[]); setSuggestionMode('custom'); }}
                            style={{ width: 320 }}
                            options={['TRADE', 'REDEEM', 'SPLIT', 'MERGE', 'CONVERSION'].map((x) => ({ value: x, label: x }))}
                        />
                        <span style={{ color: '#aaa' }}>Sides</span>
                        <Select
                            mode="multiple"
                            value={sides}
                            onChange={(v) => { setSides(v as ActivitySide[]); setSuggestionMode('custom'); }}
                            style={{ width: 240 }}
                            options={['BUY', 'SELL'].map((x) => ({ value: x, label: x }))}
                        />
                        <span style={{ color: '#aaa' }}>Include</span>
                        <Input style={{ width: 260 }} placeholder="btc,eth,..." value={includeKeywordsRaw} onChange={(e) => setIncludeKeywordsRaw(e.target.value)} />
                        <span style={{ color: '#aaa' }}>Exclude</span>
                        <Input style={{ width: 260 }} placeholder="rug,..." value={excludeKeywordsRaw} onChange={(e) => setExcludeKeywordsRaw(e.target.value)} />
                    </Space>
                </div>
                <div style={{ marginTop: 10 }}>
                    <Space wrap>
                        <span style={{ color: '#aaa' }}>Ratio</span>
                        <InputNumber min={0} max={1} step={0.01} value={ratio} onChange={(v) => setRatio(Number(v))} />
                        <span style={{ color: '#aaa' }}>Max/Order</span>
                        <InputNumber min={0} max={100000} value={maxUsdcPerOrder} onChange={(v) => setMaxUsdcPerOrder(Number(v))} />
                        <span style={{ color: '#aaa' }}>Max/Day</span>
                        <InputNumber min={0} max={10000000} value={maxUsdcPerDay} onChange={(v) => setMaxUsdcPerDay(Number(v))} />
                        <span style={{ color: '#aaa' }}>Min leader$</span>
                        <InputNumber min={0} max={100000000} value={minLeaderUsdc} onChange={(v) => setMinLeaderUsdc(Number(v))} />
                        <span style={{ color: '#aaa' }}>Max leader$</span>
                        <InputNumber min={0} max={100000000} value={maxLeaderUsdc} onChange={(v) => setMaxLeaderUsdc(v == null ? null : Number(v))} />
                        <span style={{ color: '#aaa' }}>Price</span>
                        <InputNumber min={0} max={1} step={0.01} value={minPrice} onChange={(v) => setMinPrice(Number(v))} />
                        <span style={{ color: '#aaa' }}>to</span>
                        <InputNumber min={0} max={1} step={0.01} value={maxPrice} onChange={(v) => setMaxPrice(Number(v))} />
                        <span style={{ color: '#aaa' }}>追蹤類別</span>
                        <Select
                            mode="multiple"
                            value={watchedCategories}
                            onChange={(v) => { setWatchedCategories(v as any); persistWatchedCategories(v as any); }}
                            style={{ width: 260 }}
                            options={[
                                { value: 'crypto', label: 'crypto' },
                                { value: 'sports', label: 'sports' },
                                { value: 'politics', label: 'politics' },
                                { value: 'other', label: 'other' },
                            ]}
                        />
                        <Text style={{ color: '#aaa' }}>
                            Polls: {status?.counters?.polls ?? '-'} | New: {status?.counters?.newEvents ?? '-'} | Sug: {status?.counters?.suggestions ?? '-'} | Fail: {status?.failCount ?? '-'} | Next(ms): {status?.nextDelayMs ?? '-'} | Err: {status?.lastError ?? '-'}
                        </Text>
                        <Text style={{ color: '#555' }}>
                            Allow: {allowConditionIds.length} | Cat: {watchedCategories.length} | Deny: {denyConditionIds.length}
                        </Text>
                    </Space>
                </div>
            </Card>

            <div style={{ height: 12 }} />

            <Card size="small" title={<span style={{ color: '#fff' }}>Tracking</span>} style={{ background: '#1f1f1f', borderColor: '#333' }}>
                <div style={{ marginBottom: 10 }}>
                    <Space wrap>
                        <Text style={{ color: '#aaa' }}>Allowed Categories</Text>
                        {watchedCategories.length ? watchedCategories.map((c) => (
                            <Tag
                                key={c}
                                closable
                                onClose={(e) => {
                                    e.preventDefault();
                                    setWatchedCategories((prev) => (Array.isArray(prev) ? prev : []).filter((x) => String(x) !== String(c)));
                                }}
                            >
                                {String(c)}
                            </Tag>
                        )) : <Text style={{ color: '#555' }}>None</Text>}
                    </Space>
                </div>
                <div style={{ marginBottom: 10 }}>
                    <Space wrap>
                        <Text style={{ color: '#aaa' }}>Allowed Markets</Text>
                        {allowConditionIds.length ? allowConditionIds.map((cid) => (
                            <Tag
                                key={cid}
                                closable
                                onClose={(e) => {
                                    e.preventDefault();
                                    setAllowConditionIds((prev) => (Array.isArray(prev) ? prev : []).filter((x) => String(x || '').toLowerCase() !== String(cid || '').toLowerCase()));
                                }}
                            >
                                <Text copyable style={{ color: '#fff' }}>{String(cid).slice(0, 12)}</Text>
                            </Tag>
                        )) : <Text style={{ color: '#555' }}>None</Text>}
                    </Space>
                </div>
                <div>
                    <Space wrap>
                        <Text style={{ color: '#aaa' }}>Denied Markets</Text>
                        {denyConditionIds.length ? denyConditionIds.map((cid) => (
                            <Tag
                                key={cid}
                                closable
                                onClose={(e) => {
                                    e.preventDefault();
                                    setDenyConditionIds((prev) => (Array.isArray(prev) ? prev : []).filter((x) => String(x || '').toLowerCase() !== String(cid || '').toLowerCase()));
                                }}
                            >
                                <Text copyable style={{ color: '#fff' }}>{String(cid).slice(0, 12)}</Text>
                            </Tag>
                        )) : <Text style={{ color: '#555' }}>None</Text>}
                        <Button
                            danger
                            disabled={!watchedCategories.length && !allowConditionIds.length && !denyConditionIds.length}
                            onClick={() => {
                                setWatchedCategories([]);
                                setAllowConditionIds([]);
                                setDenyConditionIds([]);
                            }}
                        >
                            Clear Tracking
                        </Button>
                    </Space>
                </div>
            </Card>

            <div style={{ height: 12 }} />

            <Card size="small" title={<span style={{ color: '#fff' }}>Real Auto Trade（真落單）</span>} style={{ background: '#1f1f1f', borderColor: '#333' }}>
                <Space wrap>
                    <Checkbox
                        checked={autoTradeEnabled}
                        onChange={(e) => {
                            const next = e.target.checked;
                            setAutoTradeEnabled(next);
                            syncAutoTradeConfig({ enabled: next });
                        }}
                    >
                        Enable Real
                    </Checkbox>
                    <Select
                        value={autoTradeMode}
                        onChange={(v) => setAutoTradeMode(v)}
                        style={{ width: 140 }}
                        options={[
                            { value: 'queue', label: 'Queue' },
                            { value: 'auto', label: 'Auto' },
                        ]}
                    />
                    <Select
                        value={executionStyle}
                        onChange={(v) => setExecutionStyle(v)}
                        style={{ width: 140 }}
                        options={[
                            { value: 'copy', label: 'Copy' },
                            { value: 'sweep', label: 'Sweep' },
                        ]}
                    />
                    <span style={{ color: '#aaa' }}>Buffer(c)</span>
                    <InputNumber min={0} max={50} value={priceBufferCents} onChange={(v) => setPriceBufferCents(Number(v))} />
                    <span style={{ color: '#aaa' }}>Max/hr</span>
                    <InputNumber min={0} max={1000} value={maxOrdersPerHour} onChange={(v) => setMaxOrdersPerHour(Number(v))} />
                    {executionStyle === 'sweep' ? (
                        <>
                            <span style={{ color: '#aaa' }}>Cap(c)</span>
                            <InputNumber min={0.1} max={99.9} step={0.1} value={sweepPriceCapCents} onChange={(v) => setSweepPriceCapCents(Number(v))} />
                            <span style={{ color: '#aaa' }}>Trigger(c)</span>
                            <InputNumber min={0} max={99.9} step={0.1} value={sweepMinTriggerCents} onChange={(v) => setSweepMinTriggerCents(Number(v))} />
                            <span style={{ color: '#aaa' }}>$/Event</span>
                            <InputNumber min={0} max={50000} value={sweepMaxUsdcPerEvent} onChange={(v) => setSweepMaxUsdcPerEvent(Number(v))} />
                            <span style={{ color: '#aaa' }}>Orders</span>
                            <InputNumber min={1} max={200} value={sweepMaxOrdersPerEvent} onChange={(v) => setSweepMaxOrdersPerEvent(Number(v))} />
                            <span style={{ color: '#aaa' }}>Gap(ms)</span>
                            <InputNumber min={0} max={30000} value={sweepMinIntervalMs} onChange={(v) => setSweepMinIntervalMs(Number(v))} />
                        </>
                    ) : null}
                    <Button loading={autoTradeLoading} onClick={() => syncAutoTradeConfig()}>Sync</Button>
                    <Button loading={autoTradeLoading} onClick={() => refreshAutoTrade()}>Refresh</Button>
                    <Button danger loading={autoTradeLoading} onClick={clearPending}>Clear Queue</Button>
                    <Tag color={autoTradeHasKey === true ? 'green' : autoTradeHasKey === false ? 'red' : 'default'}>
                        {autoTradeHasKey === true ? 'KEY OK' : autoTradeHasKey === false ? 'NO KEY' : 'KEY ?'}
                    </Tag>
                    <Text style={{ color: '#aaa' }}>真落單功能；只會處理你揀咗 Allow 嘅 market。唔想有風險就唔好開 Enable Real。</Text>
                    <Text style={{ color: '#555' }}>Server Cats: {serverAllowCategories.length ? serverAllowCategories.join(',') : '-'}</Text>
                </Space>
                {autoTradeError ? (
                    <div style={{ marginTop: 6 }}>
                        <Text style={{ color: '#ff7875' }}>{autoTradeError}</Text>
                    </div>
                ) : null}
                <div style={{ height: 10 }} />
                <Card size="small" title={<span style={{ color: '#fff' }}>Logs</span>} style={{ background: '#141414', borderColor: '#333' }}>
                    <Collapse
                        ghost
                        items={[
                            {
                                key: 'paper',
                                label: `PaperTrade (${paperTradeHistory.length})`,
                                children: (
                                    <div>
                                        <Space wrap>
                                            <Button size="small" onClick={() => copyText(paperLogsJson)}>Copy JSON</Button>
                                            <Text style={{ color: '#777' }}>最新 100 條</Text>
                                        </Space>
                                        <pre style={{ marginTop: 8, maxHeight: 360, overflow: 'auto', background: '#0f0f0f', color: '#ddd', padding: 10, border: '1px solid #333' }}>{paperLogsJson}</pre>
                                    </div>
                                ),
                            },
                            {
                                key: 'auto',
                                label: `AutoTrade History (${autoTradeHistory.length})`,
                                children: (
                                    <div>
                                        <Space wrap>
                                            <Button size="small" onClick={() => copyText(autoTradeLogsJson)}>Copy JSON</Button>
                                            <Text style={{ color: '#777' }}>最新 100 條</Text>
                                        </Space>
                                        <pre style={{ marginTop: 8, maxHeight: 360, overflow: 'auto', background: '#0f0f0f', color: '#ddd', padding: 10, border: '1px solid #333' }}>{autoTradeLogsJson}</pre>
                                    </div>
                                ),
                            },
                        ]}
                    />
                </Card>
                <div style={{ height: 10 }} />
                <Card size="small" title={<span style={{ color: '#fff' }}>Demo (PaperTrade)</span>} style={{ background: '#141414', borderColor: '#333' }}>
                    <Space wrap>
                        <Checkbox
                            checked={paperTradeEnabled}
                            onChange={(e) => {
                                const next = e.target.checked;
                                setPaperTradeEnabled(next);
                                syncAutoTradeConfig({ paperTradeEnabled: next });
                            }}
                        >
                            Enable Demo
                        </Checkbox>
                        <Select
                            value={paperFillRule}
                            onChange={(v) => setPaperFillRule(v)}
                            style={{ width: 140 }}
                            options={[
                                { value: 'sweep', label: 'Sweep' },
                                { value: 'touch', label: 'Touch' },
                            ]}
                        />
                        <span style={{ color: '#aaa' }}>Levels</span>
                        <InputNumber min={1} max={50} value={paperBookLevels} onChange={(v) => setPaperBookLevels(Number(v))} />
                        <span style={{ color: '#aaa' }}>MinFill%</span>
                        <InputNumber min={0} max={100} value={paperMinFillPct} onChange={(v) => setPaperMinFillPct(Number(v))} />
                        <Button loading={autoTradeLoading} onClick={clearPaperTrade}>Clear Demo</Button>
                        <Tag color={paperTradeEnabled ? 'green' : 'default'}>{paperTradeEnabled ? 'DEMO ON' : 'DEMO OFF'}</Tag>
                        <Text style={{ color: '#aaa' }}>Demo 只係對盤模擬（唔會落單）；開咗 Demo 就會跑模擬，唔需要開 Enable Real。</Text>
                    </Space>
                    {paperTradeError ? (
                        <div style={{ marginTop: 6 }}>
                            <Text style={{ color: '#ff7875' }}>{paperTradeError}</Text>
                        </div>
                    ) : null}
                    <div style={{ height: 10 }} />
                    <Table
                        rowKey={(r) => String(r.id || `${r.at}-${r.conditionId}`)}
                        size="small"
                        pagination={false}
                        dataSource={paperTradeHistory}
                        columns={[
                            { title: 'At', dataIndex: 'at', key: 'at', width: 180, render: (v) => String(v || '-') },
                            { title: 'Res', dataIndex: 'result', key: 'result', width: 140, render: (v) => <Tag>{String(v || '-')}</Tag> },
                            { title: 'Fill%', dataIndex: 'fillPct', key: 'fillPct', width: 90, render: (v) => v != null ? `${Number(v).toFixed(1)}%` : '-' },
                            { title: 'Target$', dataIndex: 'targetUsdc', key: 'targetUsdc', width: 90, render: (v) => v != null ? Number(v).toFixed(2) : '-' },
                            { title: 'Limit', dataIndex: 'limitPrice', key: 'limitPrice', width: 90, render: (v) => v != null ? `${(Number(v) * 100).toFixed(1)}c` : '-' },
                            { title: 'BestAsk', dataIndex: 'bestAsk', key: 'bestAsk', width: 90, render: (v) => v != null ? `${(Number(v) * 100).toFixed(1)}c` : '-' },
                            { title: 'Filled$', dataIndex: 'sweepFilledUsdc', key: 'sweepFilledUsdc', width: 90, render: (v) => v != null ? Number(v).toFixed(2) : '-' },
                            { title: 'FilledSz', dataIndex: 'sweepFilledShares', key: 'sweepFilledShares', width: 90, render: (v) => v != null ? Number(v).toFixed(2) : '-' },
                            { title: 'AvgPx', dataIndex: 'sweepAvgFillPrice', key: 'sweepAvgFillPrice', width: 90, render: (v) => v != null ? `${(Number(v) * 100).toFixed(2)}c` : '-' },
                            { title: 'ms', dataIndex: 'sweepLatencyMs', key: 'sweepLatencyMs', width: 70, render: (v) => v != null ? String(Math.floor(Number(v))) : '-' },
                            { title: 'Stop', dataIndex: 'sweepStopReason', key: 'sweepStopReason', width: 120, render: (v: any, r: any) => {
                                const reason = v ? String(v) : '';
                                const cat = String(r?.category || 'other').toLowerCase();
                                if (reason === 'not_allowed') {
                                    const tip = `not_allowed: cat=${cat} not in serverCats=[${serverAllowCategories.join(',') || '-'}]`;
                                    return <Text title={tip} style={{ color: '#ff7875' }}>{reason}</Text>;
                                }
                                return reason ? String(reason).slice(0, 18) : '-';
                            } },
                            { title: 'Cat', dataIndex: 'category', key: 'category', width: 90, render: (v) => <Tag color={catTagColor(v)}>{String(v || '-')}</Tag> },
                            { title: 'Market', key: 'market', render: (_: any, r: any) => (r?.title || r?.conditionId || '-') },
                            { title: 'Err', dataIndex: 'error', key: 'error', width: 200, render: (v) => v ? String(v).slice(0, 60) : '-' },
                        ]}
                    />
                </Card>
                <div style={{ height: 10 }} />
                <Card size="small" title={<span style={{ color: '#fff' }}>Queue</span>} style={{ background: '#141414', borderColor: '#333' }}>
                    <Table
                        rowKey={(r) => String(r.id)}
                        size="small"
                        pagination={false}
                        dataSource={pendingAutoTrades}
                        columns={[
                            { title: 'At', dataIndex: 'createdAt', key: 'createdAt', width: 180, render: (v) => String(v || '-') },
                            { title: 'Status', dataIndex: 'status', key: 'status', width: 90, render: (v) => <Tag>{String(v || '-')}</Tag> },
                            { title: 'My$', dataIndex: 'amountUsdc', key: 'amountUsdc', width: 90, render: (v) => v != null ? Number(v).toFixed(2) : '-' },
                            { title: 'Px', dataIndex: 'limitPrice', key: 'limitPrice', width: 90, render: (v) => v != null ? `${(Number(v) * 100).toFixed(1)}c` : '-' },
                            { title: 'Cat', key: 'category', width: 90, render: (_: any, r: any) => <Tag color={catTagColor(r?.suggestion?.category)}>{String(r?.suggestion?.category || '-')}</Tag> },
                            { title: 'Market', key: 'market', render: (_: any, r: any) => (r?.suggestion?.title || r?.suggestion?.slug || r?.suggestion?.conditionId || '-') },
                            { title: 'Order', dataIndex: 'orderId', key: 'orderId', width: 140, render: (v) => v ? String(v).slice(0, 10) : '-' },
                            { title: 'Err', dataIndex: 'error', key: 'error', width: 160, render: (v: any, r: any) => {
                                const err = v ? String(v) : '';
                                if (err === 'not_allowed') {
                                    const cat = String(r?.suggestion?.category || 'other').toLowerCase();
                                    const tip = `not_allowed: cat=${cat} not in serverCats=[${serverAllowCategories.join(',') || '-'}]`;
                                    return <Text title={tip} style={{ color: '#ff7875' }}>{err}</Text>;
                                }
                                return err ? err.slice(0, 24) : '-';
                            } },
                            { title: 'Act', key: 'act', width: 100, render: (_: any, r: any) => <Button size="small" disabled={String(r?.status) !== 'pending'} onClick={() => executePending(String(r?.id || ''))}>Execute</Button> },
                        ]}
                    />
                </Card>
                <div style={{ height: 10 }} />
                <Card size="small" title={<span style={{ color: '#fff' }}>History</span>} style={{ background: '#141414', borderColor: '#333' }}>
                    <Table
                        rowKey={(_, i) => String(i)}
                        size="small"
                        pagination={false}
                        dataSource={autoTradeHistory}
                        columns={[
                            { title: 'At', dataIndex: 'at', key: 'at', width: 180, render: (v) => String(v || '-') },
                            { title: 'Action', dataIndex: 'action', key: 'action', width: 90, render: (v) => <Tag>{String(v || '-')}</Tag> },
                            { title: 'CID', dataIndex: 'conditionId', key: 'conditionId', width: 140, render: (v) => v ? String(v).slice(0, 12) : '-' },
                            { title: 'My$', dataIndex: 'amountUsdc', key: 'amountUsdc', width: 90, render: (v) => v != null ? Number(v).toFixed(2) : '-' },
                            { title: 'Px', dataIndex: 'limitPrice', key: 'limitPrice', width: 90, render: (v) => v != null ? `${(Number(v) * 100).toFixed(1)}c` : '-' },
                            { title: 'Order', dataIndex: 'orderId', key: 'orderId', width: 140, render: (v) => v ? String(v).slice(0, 10) : '-' },
                            { title: 'Err', dataIndex: 'error', key: 'error', width: 200, render: (v) => v ? String(v).slice(0, 40) : '-' },
                        ]}
                    />
                </Card>
            </Card>

            <div style={{ height: 12 }} />

            <Card size="small" title={<span style={{ color: '#fff' }}>Market Summary</span>} style={{ background: '#1f1f1f', borderColor: '#333' }}>
                <Table
                    rowKey={(r) => String(r.conditionId)}
                    size="small"
                    pagination={false}
                    tableLayout="fixed"
                    scroll={{ x: 1200 }}
                    dataSource={marketSummary}
                    columns={[
                        { title: 'Cat', dataIndex: 'category', key: 'category', width: 100, render: (v) => <Tag color={catTagColor(v)}>{String(v || '-')}</Tag> },
                        { title: 'Count', dataIndex: 'count', key: 'count', width: 80, render: (v) => Number(v || 0) },
                        { title: 'Leader$', dataIndex: 'totalLeaderUsdc', key: 'totalLeaderUsdc', width: 110, render: (v) => Number(v || 0).toFixed(2) },
                        { title: 'AvgPx', dataIndex: 'avgPrice', key: 'avgPrice', width: 90, render: (v) => `${(Number(v || 0) * 100).toFixed(1)}c` },
                        { title: 'Last', dataIndex: 'lastAt', key: 'lastAt', width: 200, render: (v) => <span style={{ whiteSpace: 'nowrap' }}>{v ? new Date(Number(v)).toISOString() : '-'}</span> },
                        {
                            title: 'Market',
                            key: 'market',
                            width: 420,
                            ellipsis: true,
                            render: (_: any, r: any) => {
                                const slug = String(r?.slug || '').trim();
                                const text = String(r?.title || slug || r?.conditionId || '-');
                                if (!slug) return <span style={{ whiteSpace: 'nowrap' }}>{text}</span>;
                                const href = `https://polymarket.com/event/${encodeURIComponent(slug)}`;
                                return <a href={href} target="_blank" rel="noreferrer" style={{ whiteSpace: 'nowrap' }}>{text}</a>;
                            }
                        },
                        {
                            title: 'Select',
                            key: 'select',
                            width: 220,
                            render: (_: any, r: any) => {
                                const cid = String(r?.conditionId || '');
                                const key = cid.toLowerCase();
                                const allowed = allowSet.has(key);
                                const denied = denySet.has(key);
                                return (
                                    <Space>
                                        <Button size="small" type={allowed ? 'primary' : 'default'} onClick={() => toggleAllow(cid)}>Allow</Button>
                                        <Button size="small" danger={denied} onClick={() => toggleDeny(cid)}>Deny</Button>
                                    </Space>
                                );
                            }
                        },
                    ]}
                />
            </Card>

            <div style={{ height: 12 }} />

            <div ref={suggestionsCardRef}>
                <Card
                    size="small"
                    title={
                        <Space>
                            <span style={{ color: '#fff' }}>Suggestions</span>
                            {suggestionsPinned ? <Tag>OLDER</Tag> : <Tag color="green">LATEST</Tag>}
                            <Tag>offset {suggestionsPageStart}</Tag>
                            <Tag>next {suggestionsOffset}</Tag>
                            <Tag color={suggestionsHasMore ? 'blue' : 'default'}>{suggestionsHasMore ? 'MORE' : 'END'}</Tag>
                            <Checkbox checked={suggestionsAutoLoad} onChange={(e) => setSuggestionsAutoLoad(e.target.checked)}>Auto Load</Checkbox>
                            <Button size="small" onClick={() => loadLatestPages()}>Latest 100</Button>
                            <Button size="small" disabled={!addressValid || !suggestionsHasMore || suggestionsLoadingMore} loading={suggestionsLoadingMore} onClick={() => loadOlderSuggestions()}>Older 100</Button>
                        </Space>
                    }
                    style={{ background: '#1f1f1f', borderColor: '#333' }}
                >
                <Table
                    rowKey={(r) => String(r.id || `${r.at}-${r.conditionId}`)}
                    size="small"
                    pagination={false}
                    tableLayout="fixed"
                    scroll={{ x: 1500 }}
                    dataSource={suggestionsView}
                    locale={{
                        emptyText: (
                            <div style={{ color: '#777' }}>
                                No suggestions. Click “Latest 100”, or run “Confirm / Track Live”.
                            </div>
                        )
                    }}
                    columns={[
                        { title: 'Time', dataIndex: 'at', key: 'at', width: 200, render: (v) => <span style={{ whiteSpace: 'nowrap' }}>{v ? new Date(Number(v)).toISOString() : '-'}</span> },
                        { title: 'Type', dataIndex: 'type', key: 'type', width: 90, render: (v) => <Tag>{String(v || '-')}</Tag> },
                        { title: 'Side', dataIndex: 'side', key: 'side', width: 90, render: (v) => <Tag color={String(v) === 'BUY' ? 'green' : 'red'}>{String(v || '-')}</Tag> },
                        { title: 'Cat', dataIndex: 'category', key: 'category', width: 100, render: (v) => <Tag color={catTagColor(v)}>{String(v || '-')}</Tag> },
                        { title: 'Outcome', dataIndex: 'outcome', key: 'outcome', width: 120, ellipsis: true, render: (v) => <span style={{ whiteSpace: 'nowrap' }}>{String(v || '-')}</span> },
                        { title: 'Leader$', dataIndex: 'leaderUsdc', key: 'leaderUsdc', width: 110, render: (v) => v != null ? Number(v).toFixed(2) : '-' },
                        { title: 'My$', dataIndex: 'myUsdc', key: 'myUsdc', width: 110, render: (v, r) => v != null ? <span>{Number(v).toFixed(2)}{r?.cappedByOrder ? ' (cap)' : r?.cappedByDay ? ' (day)' : ''}</span> : '-' },
                        { title: 'Price', dataIndex: 'leaderPrice', key: 'leaderPrice', width: 90, render: (v) => v != null ? `${(Number(v) * 100).toFixed(1)}c` : '-' },
                        {
                            title: 'Pick',
                            key: 'pick',
                            width: 180,
                            fixed: 'right',
                            render: (_: any, r: any) => {
                                const cid = String(r?.conditionId || '');
                                const key = cid.toLowerCase();
                                const allowed = allowSet.has(key);
                                const denied = denySet.has(key);
                                return (
                                    <Space>
                                        <Button size="small" type={allowed ? 'primary' : 'default'} onClick={() => toggleAllow(cid)}>Allow</Button>
                                        <Button size="small" danger={denied} onClick={() => toggleDeny(cid)}>Deny</Button>
                                    </Space>
                                );
                            }
                        },
                        {
                            title: 'Market',
                            key: 'market',
                            width: 360,
                            ellipsis: true,
                            render: (_: any, r: any) => {
                                const slug = String(r?.slug || '').trim();
                                const text = String(r?.title || slug || r?.conditionId || '-');
                                if (!slug) return <span style={{ whiteSpace: 'nowrap' }}>{text}</span>;
                                const href = `https://polymarket.com/event/${encodeURIComponent(slug)}`;
                                return <a href={href} target="_blank" rel="noreferrer" style={{ whiteSpace: 'nowrap' }}>{text}</a>;
                            }
                        },
                        { title: 'CID', dataIndex: 'conditionId', key: 'conditionId', width: 140, ellipsis: true, render: (v) => <span style={{ whiteSpace: 'nowrap' }}>{v ? String(v).slice(0, 12) : '-'}</span> },
                    ]}
                />
                </Card>
            </div>

            <div style={{ height: 12 }} />

            <div ref={activitiesCardRef}>
                <Card
                    size="small"
                    title={
                        <Space>
                            <span style={{ color: '#fff' }}>Activities</span>
                            {activitiesPinned ? <Tag>OLDER</Tag> : <Tag color="green">LATEST</Tag>}
                            <Tag>offset {activitiesPageStart}</Tag>
                            <Tag>next {activitiesOffset}</Tag>
                            <Tag color={activitiesHasMore ? 'blue' : 'default'}>{activitiesHasMore ? 'MORE' : 'END'}</Tag>
                            <Checkbox checked={activitiesAutoLoad} onChange={(e) => setActivitiesAutoLoad(e.target.checked)}>Auto Load</Checkbox>
                            <Button size="small" disabled={!addressValid} loading={load11hLoading} onClick={() => loadLastHours(11)}>Load last 11h</Button>
                            <Button size="small" onClick={() => loadLatestPages()}>Latest 100</Button>
                            <Button size="small" disabled={!addressValid || !activitiesHasMore || activitiesLoadingMore} loading={activitiesLoadingMore} onClick={() => loadOlderActivities()}>Older 100</Button>
                        </Space>
                    }
                    style={{ background: '#1f1f1f', borderColor: '#333' }}
                >
                <div style={{ marginBottom: 10 }}>
                    <Space wrap>
                        <span style={{ color: '#aaa' }}>Search</span>
                        <Input style={{ width: 420 }} placeholder="super bowl / seattle / slug / conditionId / tx..." value={activitySearch} onChange={(e) => setActivitySearch(e.target.value)} />
                        <Button onClick={() => setActivitySearch('')}>Clear</Button>
                    </Space>
                </div>
                <Table
                    rowKey={(r) => String(`${r.transactionHash}-${r.conditionId}-${r.asset}-${r.side}-${r.price}`)}
                    size="small"
                    pagination={false}
                    tableLayout="fixed"
                    scroll={{ x: 1200 }}
                    dataSource={activitiesView}
                    locale={{
                        emptyText: (
                            <div style={{ color: '#777' }}>
                                No activities. Run “Confirm / Track Live” first.
                            </div>
                        )
                    }}
                    columns={[
                        { title: 'Time', dataIndex: 'timestamp', key: 'timestamp', width: 200, render: (v) => <span style={{ whiteSpace: 'nowrap' }}>{v ? new Date(Number(v)).toISOString() : '-'}</span> },
                        { title: 'Type', dataIndex: 'type', key: 'type', width: 90, render: (v) => <Tag>{String(v || '-')}</Tag> },
                        { title: 'Side', dataIndex: 'side', key: 'side', width: 90, render: (v) => <Tag color={String(v) === 'BUY' ? 'green' : 'red'}>{String(v || '-')}</Tag> },
                        { title: 'Outcome', dataIndex: 'outcome', key: 'outcome', width: 120, ellipsis: true, render: (v) => <span style={{ whiteSpace: 'nowrap' }}>{String(v || '-')}</span> },
                        { title: '$', dataIndex: 'usdcSize', key: 'usdcSize', width: 100, render: (v, r) => (v != null ? Number(v).toFixed(2) : (Number(r.size) * Number(r.price)).toFixed(2)) },
                        { title: 'Price', dataIndex: 'price', key: 'price', width: 90, render: (v) => v != null ? `${(Number(v) * 100).toFixed(1)}c` : '-' },
                        {
                            title: 'Market',
                            key: 'market',
                            width: 420,
                            ellipsis: true,
                            render: (_: any, r: any) => {
                                const slug = String(r?.slug || '').trim();
                                const text = String(r?.title || slug || r?.conditionId || '-');
                                if (!slug) return <span style={{ whiteSpace: 'nowrap' }}>{text}</span>;
                                const href = `https://polymarket.com/event/${encodeURIComponent(slug)}`;
                                return <a href={href} target="_blank" rel="noreferrer" style={{ whiteSpace: 'nowrap' }}>{text}</a>;
                            }
                        },
                        { title: 'Hash', dataIndex: 'transactionHash', key: 'transactionHash', width: 140, ellipsis: true, render: (v) => <span style={{ whiteSpace: 'nowrap' }}>{v ? String(v).slice(0, 12) : '-'}</span> },
                    ]}
                />
                </Card>
            </div>
        </div>
    );
}

export default FollowActivity;
