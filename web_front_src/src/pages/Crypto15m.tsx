import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, Collapse, InputNumber, Modal, Select, Space, Table, Tag, Tooltip, Typography, message } from 'antd';
import { PlayCircleOutlined, PauseCircleOutlined, ReloadOutlined, ShoppingCartOutlined, SafetyCertificateOutlined, DeleteOutlined } from '@ant-design/icons';
import axios from 'axios';
import { createChart } from 'lightweight-charts';
import { useAccountApiPath } from '../api/apiPath';

const { Title, Text } = Typography;

const api = axios.create({
    baseURL: '/api',
    timeout: 120000,
});

let crypto15mNowSec = Math.floor(Date.now() / 1000);
const crypto15mNowListeners = new Set<() => void>();
const crypto15mNowKey = '__fktools_crypto15m_now_timer__';
const ensureCrypto15mNowTimer = () => {
    const existing: any = (globalThis as any)[crypto15mNowKey];
    const lastTickAtMs = existing && typeof existing === 'object' ? Number(existing.lastTickAtMs || 0) : 0;
    const id = existing && typeof existing === 'object' ? existing.id : existing;
    const stale = lastTickAtMs > 0 ? (Date.now() - lastTickAtMs) > 2500 : false;
    if (stale && id) {
        try { clearInterval(id); } catch {}
        (globalThis as any)[crypto15mNowKey] = null;
    }
    const cur: any = (globalThis as any)[crypto15mNowKey];
    if (cur) return;
    const state: any = { id: null as any, lastTickAtMs: Date.now() };
    state.id = setInterval(() => {
        crypto15mNowSec = Math.floor(Date.now() / 1000);
        state.lastTickAtMs = Date.now();
        for (const fn of Array.from(crypto15mNowListeners)) {
            try { fn(); } catch {}
        }
    }, 1000);
    (globalThis as any)[crypto15mNowKey] = state;
};
ensureCrypto15mNowTimer();

const useNowSec = () => {
    const [v, setV] = useState<number>(() => crypto15mNowSec);
    useEffect(() => {
        ensureCrypto15mNowTimer();
        const fn = () => setV(crypto15mNowSec);
        crypto15mNowListeners.add(fn);
        return () => {
            crypto15mNowListeners.delete(fn);
        };
    }, []);
    return v;
};

function Crypto15m(props: { variant?: 'crypto15m' | 'all'; title?: string; settingsKey?: string } = {}) {
    const safeMode = useMemo(() => {
        try {
            return new URLSearchParams(window.location.search).get('safe') === '1';
        } catch {
            return false;
        }
    }, []);
    const variant: 'crypto15m' | 'all' = props.variant === 'all' ? 'all' : 'crypto15m';
    const settingsKey = String(props.settingsKey || 'crypto15m_settings_v1');
    const pageTitle = String(props.title || '⏱️ 15mins Crypto Trade');
    const apiPath = useAccountApiPath();
    const abortersRef = useRef<Map<string, AbortController>>(new Map());
    const apiGet = useCallback((key: string, p: string, config?: any) => {
        const prev = abortersRef.current.get(key);
        if (prev) prev.abort();
        const controller = new AbortController();
        abortersRef.current.set(key, controller);
        return api.get(apiPath(p), { ...(config || {}), signal: controller.signal }).finally(() => {
            const cur = abortersRef.current.get(key);
            if (cur === controller) abortersRef.current.delete(key);
        });
    }, [apiPath]);
    const apiPost = useCallback((key: string, p: string, data?: any, config?: any) => {
        const prev = abortersRef.current.get(key);
        if (prev) prev.abort();
        const controller = new AbortController();
        abortersRef.current.set(key, controller);
        return api.post(apiPath(p), data, { ...(config || {}), signal: controller.signal }).finally(() => {
            const cur = abortersRef.current.get(key);
            if (cur === controller) abortersRef.current.delete(key);
        });
    }, [apiPath]);
    const [candidates, setCandidates] = useState<any[]>([]);
    const [candidatesMeta, setCandidatesMeta] = useState<{ count: number; eligible: number } | null>(null);
    const [status, setStatus] = useState<any>(null);
    const [watchdog, setWatchdog] = useState<any>(null);
    const [health, setHealth] = useState<any>(null);
    const [history, setHistory] = useState<any[]>([]);
    const [configEvents, setConfigEvents] = useState<any[]>([]);
    const [historyStrategy, setHistoryStrategy] = useState<'crypto15m' | 'cryptoall' | 'all'>('crypto15m');
    const [autoRefresh, setAutoRefresh] = useState(() => !safeMode);
    const [showPendingOnly, setShowPendingOnly] = useState(false);
    const [editing, setEditing] = useState(false);
    const [pollMs, setPollMs] = useState<number>(() => safeMode ? 5000 : 1000);
    const [minProb, setMinProb] = useState<number>(0.9);
    const [expiresWithinSec, setExpiresWithinSec] = useState<number>(180);
    const [expiresWithinSecByTimeframe, setExpiresWithinSecByTimeframe] = useState<Record<'5m' | '15m' | '1h' | '4h' | '1d', number>>(() => ({
        '5m': 180,
        '15m': 180,
        '1h': 180,
        '4h': 180,
        '1d': 180,
    }));
    const [amountUsd, setAmountUsd] = useState<number>(1);
    const [buySizingMode, setBuySizingMode] = useState<'fixed' | 'orderbook_max' | 'all_capital'>('fixed');
    const [sweepEnabled, setSweepEnabled] = useState<boolean>(true);
    const [sweepWindowSec, setSweepWindowSec] = useState<number>(30);
    const [sweepMaxOrdersPerMarket, setSweepMaxOrdersPerMarket] = useState<number>(10);
    const [sweepMaxTotalUsdPerMarket, setSweepMaxTotalUsdPerMarket] = useState<number>(600);
    const [sweepMinIntervalMs, setSweepMinIntervalMs] = useState<number>(400);
    const [trendEnabled, setTrendEnabled] = useState<boolean>(true);
    const [trendMinutes, setTrendMinutes] = useState<number>(1);
    const [staleMsThreshold, setStaleMsThreshold] = useState<number>(5000);
    const [btcMinDelta, setBtcMinDelta] = useState<number>(600);
    const [ethMinDelta, setEthMinDelta] = useState<number>(30);
    const [solMinDelta, setSolMinDelta] = useState<number>(0.8);
    const [xrpMinDelta, setXrpMinDelta] = useState<number>(0.0065);
    const [cryptoAllDeltaByTimeframe, setCryptoAllDeltaByTimeframe] = useState<Record<'5m' | '15m' | '1h' | '4h' | '1d', { btcMinDelta: number; ethMinDelta: number; solMinDelta: number; xrpMinDelta: number }>>(() => ({
        '5m': { btcMinDelta: 600, ethMinDelta: 30, solMinDelta: 0.8, xrpMinDelta: 0.0065 },
        '15m': { btcMinDelta: 600, ethMinDelta: 30, solMinDelta: 0.8, xrpMinDelta: 0.0065 },
        '1h': { btcMinDelta: 600, ethMinDelta: 30, solMinDelta: 0.8, xrpMinDelta: 0.0065 },
        '4h': { btcMinDelta: 600, ethMinDelta: 30, solMinDelta: 0.8, xrpMinDelta: 0.0065 },
        '1d': { btcMinDelta: 600, ethMinDelta: 30, solMinDelta: 0.8, xrpMinDelta: 0.0065 },
    }));
    const [savedDeltaThresholds, setSavedDeltaThresholds] = useState<any>(null);
    const [allSettingsOpen, setAllSettingsOpen] = useState(false);
    const [savedCryptoAllThresholds, setSavedCryptoAllThresholds] = useState<any>(null);
    const [savedCryptoAllThresholdsLoading, setSavedCryptoAllThresholdsLoading] = useState(false);
    const [stoplossEnabled, setStoplossEnabled] = useState(false);
    const [stoplossCut1DropCents, setStoplossCut1DropCents] = useState<number>(1);
    const [stoplossCut1SellPct, setStoplossCut1SellPct] = useState<number>(50);
    const [stoplossCut2DropCents, setStoplossCut2DropCents] = useState<number>(2);
    const [stoplossCut2SellPct, setStoplossCut2SellPct] = useState<number>(100);
    const [stoplossMinSecToExit, setStoplossMinSecToExit] = useState<number>(25);
    const [adaptiveDeltaEnabled, setAdaptiveDeltaEnabled] = useState(true);
    const [adaptiveDeltaBigMoveMultiplier, setAdaptiveDeltaBigMoveMultiplier] = useState<number>(2);
    const [adaptiveDeltaRevertNoBuyCount, setAdaptiveDeltaRevertNoBuyCount] = useState<number>(4);
    const [historySummary, setHistorySummary] = useState<any>(null);
    const [stoplossOpen, setStoplossOpen] = useState(false);
    const [stoplossLoading, setStoplossLoading] = useState(false);
    const [stoplossHistory, setStoplossHistory] = useState<any[]>([]);
    const [stoplossSummary, setStoplossSummary] = useState<any>(null);
    const [analysisOpen, setAnalysisOpen] = useState(false);
    const [analysisLoading, setAnalysisLoading] = useState(false);
    const [analysisData, setAnalysisData] = useState<any>(null);
    const [analysisTradeId, setAnalysisTradeId] = useState<number | null>(null);
    const [startLoading, setStartLoading] = useState(false);
    const [stopLoading, setStopLoading] = useState(false);
    const [refreshLoading, setRefreshLoading] = useState(false);
    const [healthLoading, setHealthLoading] = useState(false);
    const [resetLoading, setResetLoading] = useState(false);
    const [, setThresholdsLoading] = useState(false);
    const [thresholdsSaving, setThresholdsSaving] = useState(false);
    const [settingsHydrated, setSettingsHydrated] = useState(false);
    const [watchdogStartLoading, setWatchdogStartLoading] = useState(false);
    const [watchdogStopLoading, setWatchdogStopLoading] = useState(false);
    const [bidLoadingId, setBidLoadingId] = useState<string | null>(null);
    const [wsConnected, setWsConnected] = useState(false);
    const [wsLastAt, setWsLastAt] = useState<string | null>(null);
    const [wsError, setWsError] = useState<string | null>(null);
    const [historyPanels, setHistoryPanels] = useState<string[]>([]);
    const [allSymbols, setAllSymbols] = useState<Array<'BTC' | 'ETH' | 'SOL' | 'XRP'>>([]);
    const [allTimeframes, setAllTimeframes] = useState<Array<'5m' | '15m' | '1h' | '4h' | '1d'>>([]);
    const [deltaBoxLoading, setDeltaBoxLoading] = useState(false);
    const [deltaBoxData, setDeltaBoxData] = useState<any>(null);
    const [deltaBoxQuickTf, setDeltaBoxQuickTf] = useState<'5m' | '15m' | '1h' | '4h' | '1d'>('15m');
    const [deltaBoxViewMode, setDeltaBoxViewMode] = useState<'single' | 'grid'>('grid');
    const [expiryBulkOpen, setExpiryBulkOpen] = useState(false);
    const [deltaBoxApplyBySymbol, setDeltaBoxApplyBySymbol] = useState<Record<string, { enabled: boolean; timeframe: '5m' | '15m' | '1h' | '4h' | '1d'; mode: 'A' | 'C' | 'Manual'; n: 10 | 20 | 50; cIndex: 1 | 2 | 3; pct: number; manualValue: number }>>(() => ({
        BTC: { enabled: false, timeframe: '15m', mode: 'A', n: 20, cIndex: 1, pct: 100, manualValue: 0 },
        ETH: { enabled: false, timeframe: '15m', mode: 'A', n: 20, cIndex: 1, pct: 100, manualValue: 0 },
        SOL: { enabled: false, timeframe: '15m', mode: 'A', n: 20, cIndex: 1, pct: 100, manualValue: 0 },
        XRP: { enabled: false, timeframe: '15m', mode: 'A', n: 20, cIndex: 1, pct: 100, manualValue: 0 },
    }));
    const [deltaBoxExpireApply, setDeltaBoxExpireApply] = useState<{ enabled: boolean; symbol: 'BTC' | 'ETH' | 'SOL' | 'XRP'; timeframe: '5m' | '15m' | '1h' | '4h' | '1d'; n: 10 | 20 | 50; lastIndex: 1 | 2 | 3 }>(() => ({
        enabled: false,
        symbol: 'BTC',
        timeframe: '15m',
        n: 20,
        lastIndex: 1,
    }));
    const timerRef = useRef<any>(null);
    const timerHistoryRef = useRef<any>(null);
    const timerDeltaBoxRef = useRef<any>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const wsSessionRef = useRef(0);
    const cryptoAllStickyCandidatesRef = useRef<Map<string, any>>(new Map());
    const candidatesSigRef = useRef<string>('');
    const candidatesMetaSigRef = useRef<string>('');
    const historySigRef = useRef<string>('');
    const historyMetaSigRef = useRef<string>('');
    const analysisAggChartElRef = useRef<HTMLDivElement | null>(null);
    const analysisAggChartRef = useRef<any>(null);
    const analysisAgg980Ref = useRef<any>(null);
    const analysisAgg999Ref = useRef<any>(null);
    const analysisAggC980Ref = useRef<any>(null);
    const analysisAggC999Ref = useRef<any>(null);
    const analysisTradeChartElRef = useRef<HTMLDivElement | null>(null);
    const analysisTradeChartRef = useRef<any>(null);
    const analysisTradeAskRef = useRef<any>(null);
    const analysisTradeD999Ref = useRef<any>(null);
    const analysisTradeCapLineRef = useRef<any>(null);

    const copyText = useCallback(async (text: string) => {
        try {
            await navigator.clipboard.writeText(String(text || ''));
            message.success('Copied');
        } catch (e: any) {
            message.error(e?.message || 'Copy failed');
        }
    }, []);

    const logsOpen = historyPanels.includes('logs');
    const logsJson = useMemo(() => {
        if (!logsOpen) return '';
        return JSON.stringify({
            strategy: historyStrategy,
            status,
            watchdog,
            health,
            candidatesMeta,
            historySummary,
            history: (Array.isArray(history) ? history : []).slice(0, 50),
            configEvents: (Array.isArray(configEvents) ? configEvents : []).slice(0, 50),
        }, null, 2);
    }, [logsOpen, historyStrategy, status, watchdog, health, candidatesMeta, historySummary, history, configEvents]);
    const wsRetryRef = useRef<number>(0);
    const wsReconnectTimerRef = useRef<any>(null);

    const toCents = (p: any) => {
        const n = Number(p);
        if (!Number.isFinite(n)) return '-';
        return (n * 100).toFixed(1) + 'c';
    };

    const summarizeConfig = (cfg: any) => {
        const c = cfg || {};
        const enabled = c.enabled != null ? (c.enabled ? 'ON' : 'OFF') : '-';
        const parts = [
            `enabled=${enabled}`,
            c.amountUsd != null ? `amount=$${Number(c.amountUsd)}` : null,
            c.buySizingMode != null ? `buySizing=${String(c.buySizingMode)}` : null,
            c.minProb != null ? `minProb=${Number(c.minProb)}` : null,
            c.expiresWithinSec != null ? `exp≤${Number(c.expiresWithinSec)}s` : null,
            c.pollMs != null ? `poll=${Number(c.pollMs)}ms` : null,
            c.staleMsThreshold != null ? `stale=${Number(c.staleMsThreshold)}ms` : null,
            c.trendEnabled != null ? `trend=${c.trendEnabled ? 'ON' : 'OFF'}` : null,
            c.trendMinutes != null ? `trendMin=${Number(c.trendMinutes)}` : null,
            c.stoplossEnabled != null ? `stoploss=${c.stoplossEnabled ? 'ON' : 'OFF'}` : null,
            c.adaptiveDeltaEnabled != null ? `adaptiveΔ=${c.adaptiveDeltaEnabled ? 'ON' : 'OFF'}` : null,
            c.adaptiveDeltaBigMoveMultiplier != null ? `bigMove×=${Number(c.adaptiveDeltaBigMoveMultiplier)}` : null,
            c.adaptiveDeltaRevertNoBuyCount != null ? `revertN=${Number(c.adaptiveDeltaRevertNoBuyCount)}` : null,
        ].filter(Boolean);
        return parts.join(' • ');
    };

    const CountdownTag = memo(({ endDate, fallbackSeconds }: { endDate?: string; fallbackSeconds?: number }) => {
        const nowSec = useNowSec();
        const ms = endDate ? Date.parse(String(endDate)) : NaN;
        const sec = Number.isFinite(ms)
            ? Math.max(0, Math.floor(ms / 1000) - nowSec)
            : (() => {
                const fb = fallbackSeconds != null ? Number(fallbackSeconds) : NaN;
                return Number.isFinite(fb) ? Math.max(0, Math.floor(fb)) : 0;
            })();
        return <Tag color={sec <= 30 ? 'red' : 'gold'} style={{ display: 'inline-block', minWidth: 44, textAlign: 'center' }}>{String(sec)}</Tag>;
    });

    useEffect(() => {
        try {
            const raw = localStorage.getItem(settingsKey);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (parsed?.minProb != null) setMinProb(Number(parsed.minProb));
            if (parsed?.expiresWithinSec != null) setExpiresWithinSec(Number(parsed.expiresWithinSec));
            if (parsed?.expiresWithinSecByTimeframe && typeof parsed.expiresWithinSecByTimeframe === 'object') {
                const by = parsed.expiresWithinSecByTimeframe as any;
                const tfs = ['5m', '15m', '1h', '4h', '1d'] as const;
                const next: any = {};
                for (const tf of tfs) {
                    const v = by[tf];
                    next[tf] = Math.max(10, Math.floor(Number.isFinite(Number(v)) ? Number(v) : 180));
                }
                setExpiresWithinSecByTimeframe(next);
            }
            if (parsed?.amountUsd != null) setAmountUsd(Number(parsed.amountUsd));
            if (parsed?.buySizingMode != null) {
                const m = String(parsed.buySizingMode);
                setBuySizingMode(m === 'orderbook_max' ? 'orderbook_max' : m === 'all_capital' ? 'all_capital' : 'fixed');
            }
            if (parsed?.sweepEnabled != null) setSweepEnabled(!!parsed.sweepEnabled);
            if (parsed?.sweepWindowSec != null) setSweepWindowSec(Number(parsed.sweepWindowSec));
            if (parsed?.sweepMaxOrdersPerMarket != null) setSweepMaxOrdersPerMarket(Number(parsed.sweepMaxOrdersPerMarket));
            if (parsed?.sweepMaxTotalUsdPerMarket != null) setSweepMaxTotalUsdPerMarket(Number(parsed.sweepMaxTotalUsdPerMarket));
            if (parsed?.sweepMinIntervalMs != null) setSweepMinIntervalMs(Number(parsed.sweepMinIntervalMs));
            if (parsed?.trendEnabled != null) setTrendEnabled(!!parsed.trendEnabled);
            if (parsed?.trendMinutes != null) setTrendMinutes(Number(parsed.trendMinutes));
            if (parsed?.staleMsThreshold != null) setStaleMsThreshold(Number(parsed.staleMsThreshold));
            if (parsed?.pollMs != null) setPollMs(Number(parsed.pollMs));
            if (parsed?.btcMinDelta != null) setBtcMinDelta(Number(parsed.btcMinDelta));
            if (parsed?.ethMinDelta != null) setEthMinDelta(Number(parsed.ethMinDelta));
            if (parsed?.solMinDelta != null) setSolMinDelta(Number(parsed.solMinDelta));
            if (parsed?.xrpMinDelta != null) setXrpMinDelta(Number(parsed.xrpMinDelta));
            if (parsed?.cryptoAllDeltaByTimeframe && typeof parsed.cryptoAllDeltaByTimeframe === 'object') {
                const by = parsed.cryptoAllDeltaByTimeframe as any;
                const tfs = ['5m', '15m', '1h', '4h', '1d'] as const;
                const next: any = {};
                for (const tf of tfs) {
                    const row = by[tf] || {};
                    next[tf] = {
                        btcMinDelta: Math.max(0, Number.isFinite(Number(row.btcMinDelta)) ? Number(row.btcMinDelta) : 600),
                        ethMinDelta: Math.max(0, Number.isFinite(Number(row.ethMinDelta)) ? Number(row.ethMinDelta) : 30),
                        solMinDelta: Math.max(0, Number.isFinite(Number(row.solMinDelta)) ? Number(row.solMinDelta) : 0.8),
                        xrpMinDelta: Math.max(0, Number.isFinite(Number(row.xrpMinDelta)) ? Number(row.xrpMinDelta) : 0.0065),
                    };
                }
                setCryptoAllDeltaByTimeframe(next);
            }
            if (parsed?.stoplossEnabled != null) setStoplossEnabled(!!parsed.stoplossEnabled);
            if (parsed?.stoplossCut1DropCents != null) setStoplossCut1DropCents(Number(parsed.stoplossCut1DropCents));
            if (parsed?.stoplossCut1SellPct != null) setStoplossCut1SellPct(Number(parsed.stoplossCut1SellPct));
            if (parsed?.stoplossCut2DropCents != null) setStoplossCut2DropCents(Number(parsed.stoplossCut2DropCents));
            if (parsed?.stoplossCut2SellPct != null) setStoplossCut2SellPct(Number(parsed.stoplossCut2SellPct));
            if (parsed?.stoplossMinSecToExit != null) setStoplossMinSecToExit(Number(parsed.stoplossMinSecToExit));
            if (parsed?.adaptiveDeltaEnabled != null) setAdaptiveDeltaEnabled(!!parsed.adaptiveDeltaEnabled);
            if (parsed?.adaptiveDeltaBigMoveMultiplier != null) setAdaptiveDeltaBigMoveMultiplier(Number(parsed.adaptiveDeltaBigMoveMultiplier));
            if (parsed?.adaptiveDeltaRevertNoBuyCount != null) setAdaptiveDeltaRevertNoBuyCount(Number(parsed.adaptiveDeltaRevertNoBuyCount));
            const allowedSyms = new Set(['BTC', 'ETH', 'SOL', 'XRP']);
            const allowedTfs = new Set(['5m', '15m', '1h', '4h', '1d']);
            const persistedSymbolsRaw = Array.isArray(parsed?.allSymbols)
                ? parsed.allSymbols
                : (parsed?.allSymbol != null ? [parsed.allSymbol] : []);
            const persistedTimeframesRaw = Array.isArray(parsed?.allTimeframes)
                ? parsed.allTimeframes
                : (parsed?.allTimeframe != null ? [parsed.allTimeframe] : []);
            const persistedSymbols = (persistedSymbolsRaw || [])
                .map((x: any) => String(x || '').toUpperCase())
                .filter((x: any) => allowedSyms.has(x));
            const persistedTimeframes = (persistedTimeframesRaw || [])
                .map((x: any) => String(x || '').toLowerCase())
                .filter((x: any) => allowedTfs.has(x));
            setAllSymbols((persistedSymbols.length ? persistedSymbols : ['BTC', 'ETH', 'SOL', 'XRP']) as any);
            setAllTimeframes((persistedTimeframes.length ? persistedTimeframes : ['15m', '1h', '4h', '1d']) as any);
        } catch {
        } finally {
            setSettingsHydrated(true);
        }
    }, []);

    useEffect(() => {
        if (!settingsHydrated) return;
        try {
            localStorage.setItem(settingsKey, JSON.stringify({
                minProb,
                expiresWithinSec,
                expiresWithinSecByTimeframe,
                amountUsd,
                buySizingMode,
                sweepEnabled,
                sweepWindowSec,
                sweepMaxOrdersPerMarket,
                sweepMaxTotalUsdPerMarket,
                sweepMinIntervalMs,
                trendEnabled,
                trendMinutes,
                staleMsThreshold,
                pollMs,
                btcMinDelta,
                ethMinDelta,
                solMinDelta,
                xrpMinDelta,
                cryptoAllDeltaByTimeframe,
                stoplossEnabled,
                stoplossCut1DropCents,
                stoplossCut1SellPct,
                stoplossCut2DropCents,
                stoplossCut2SellPct,
                stoplossMinSecToExit,
                adaptiveDeltaEnabled,
                adaptiveDeltaBigMoveMultiplier,
                adaptiveDeltaRevertNoBuyCount,
                allSymbols,
                allTimeframes,
            }));
        } catch {
        }
    }, [settingsHydrated, minProb, expiresWithinSec, expiresWithinSecByTimeframe, amountUsd, buySizingMode, sweepEnabled, sweepWindowSec, sweepMaxOrdersPerMarket, sweepMaxTotalUsdPerMarket, sweepMinIntervalMs, trendEnabled, trendMinutes, staleMsThreshold, pollMs, btcMinDelta, ethMinDelta, solMinDelta, xrpMinDelta, cryptoAllDeltaByTimeframe, stoplossEnabled, stoplossCut1DropCents, stoplossCut1SellPct, stoplossCut2DropCents, stoplossCut2SellPct, stoplossMinSecToExit, adaptiveDeltaEnabled, adaptiveDeltaBigMoveMultiplier, adaptiveDeltaRevertNoBuyCount, allSymbols.join(','), allTimeframes.join(',')]);

    useEffect(() => {
        if (variant !== 'all') return;
        const max = Math.max(...Object.values(expiresWithinSecByTimeframe || { '5m': expiresWithinSec, '15m': expiresWithinSec, '1h': expiresWithinSec, '4h': expiresWithinSec, '1d': expiresWithinSec }));
        if (Number.isFinite(max) && max !== expiresWithinSec) setExpiresWithinSec(max);
    }, [variant, expiresWithinSecByTimeframe]);

    const fetchStatus = async () => {
        const endpoint = variant === 'all' ? '/group-arb/cryptoall/status' : '/group-arb/crypto15m/status';
        const res = await apiGet('status', endpoint);
        setStatus(res.data?.status);
    };

    useEffect(() => {
        if (!status?.config) return;
        if (editing) return;
        if (variant !== 'all') return;
        const cfg = status.config || {};
        const by = (cfg.expiresWithinSecByTimeframe && typeof cfg.expiresWithinSecByTimeframe === 'object') ? cfg.expiresWithinSecByTimeframe : null;
        const base = cfg.expiresWithinSec != null ? Number(cfg.expiresWithinSec) : 180;
        const tfs = ['5m', '15m', '1h', '4h', '1d'] as const;
        const next: any = {};
        for (const tf of tfs) {
            const v = by && (by as any)[tf] != null ? Number((by as any)[tf]) : base;
            next[tf] = Math.max(10, Math.min(3600, Math.floor(Number.isFinite(v) ? v : base)));
        }
        setExpiresWithinSecByTimeframe(next);
    }, [variant, editing, status?.config?.expiresWithinSec, status?.config?.expiresWithinSecByTimeframe]);

    const sortCandidates = (list: any[]) => {
        return (Array.isArray(list) ? list : [])
            .slice()
            .sort((a: any, b: any) => {
                if (variant === 'all') {
                    const monitorWindowSec = 1800;
                    const as = a?.secondsToExpire != null ? Number(a.secondsToExpire) : NaN;
                    const bs = b?.secondsToExpire != null ? Number(b.secondsToExpire) : NaN;
                    const aFinite = Number.isFinite(as);
                    const bFinite = Number.isFinite(bs);
                    if (aFinite !== bFinite) return aFinite ? -1 : 1;
                    if (aFinite && bFinite) {
                        const aIn = as <= monitorWindowSec;
                        const bIn = bs <= monitorWindowSec;
                        if (aIn !== bIn) return aIn ? -1 : 1;
                        if (as !== bs) return as - bs;
                    }
                    const ap = Number(a?.chosenPrice);
                    const bp = Number(b?.chosenPrice);
                    if (Number.isFinite(ap) && Number.isFinite(bp) && ap !== bp) return bp - ap;
                    return String(a?.symbol || '').localeCompare(String(b?.symbol || ''));
                }
                const as = a?.secondsToExpire != null ? Number(a.secondsToExpire) : NaN;
                const bs = b?.secondsToExpire != null ? Number(b.secondsToExpire) : NaN;
                if (Number.isFinite(as) && Number.isFinite(bs) && as !== bs) return as - bs;
                const aTitle = String(a?.title || a?.question || a?.slug || '');
                const bTitle = String(b?.title || b?.question || b?.slug || '');
                if (aTitle && bTitle && aTitle !== bTitle) return aTitle.localeCompare(bTitle);
                return String(a?.symbol || '').localeCompare(String(b?.symbol || ''));
            });
    };

    const fetchCandidates = async () => {
        if (variant === 'all') {
            if (!allSymbols.length || !allTimeframes.length) {
                candidatesSigRef.current = '';
                candidatesMetaSigRef.current = '';
                setCandidates([]);
                setCandidatesMeta(null);
                return;
            }
            const rr = await apiGet('candidates_all', '/group-arb/cryptoall/candidates', {
                params: {
                    symbols: allSymbols.join(','),
                    timeframes: allTimeframes.join(','),
                    minProb,
                    expiresWithinSec,
                    limit: 17,
                }
            });
            const rawList = Array.isArray(rr.data?.candidates) ? rr.data.candidates : [];
            const mapped = rawList.map((c: any) => {
                const sec = c?.secondsToExpire != null ? Number(c.secondsToExpire) : NaN;
                const secOk = Number.isFinite(sec) ? Math.max(0, Math.floor(sec)) : null;
                const endDateIso = c?.endDateIso != null ? String(c.endDateIso) : null;
                const endMs = endDateIso ? Date.parse(endDateIso) : NaN;
                const computedEndDateIso = (!Number.isFinite(endMs) && secOk != null) ? new Date(Date.now() + secOk * 1000).toISOString() : null;
                const upPrice = c?.upPrice != null ? Number(c.upPrice) : null;
                const downPrice = c?.downPrice != null ? Number(c.downPrice) : null;
                const upAsk = upPrice != null && Number.isFinite(upPrice) ? 1 : 0;
                const downAsk = downPrice != null && Number.isFinite(downPrice) ? 1 : 0;
                const meetsMinProb = c?.meetsMinProb === true;
                const eligibleByExpiry = c?.eligibleByExpiry === true;
                return {
                    symbol: String(c?.symbol || '').toUpperCase() || '-',
                    timeframe: String(c?.timeframe || ''),
                    title: c?.question ?? c?.title ?? null,
                    slug: c?.slug ?? null,
                    conditionId: c?.conditionId ?? null,
                    endDate: endDateIso || computedEndDateIso,
                    secondsToExpire: secOk,
                    eligibleByExpiry,
                    meetsMinProb,
                    outcomes: ['Up', 'Down'],
                    prices: [upPrice, downPrice],
                    asksCount: [upAsk, downAsk],
                    chosenIndex: c?.chosenIndex ?? null,
                    chosenOutcome: c?.chosenOutcome ?? null,
                    chosenPrice: c?.chosenPrice ?? null,
                    reason: !eligibleByExpiry ? 'expiry' : !meetsMinProb ? 'price' : null,
                    snapshotAt: null,
                    staleMs: null,
                    booksAttemptError: c?.riskError ?? null,
                };
            });
            const sorted = sortCandidates(mapped);
            const nowMs = Date.now();
            const monitorWindowSec = 1800;
            const sticky = cryptoAllStickyCandidatesRef.current;
            const seen = new Set<string>();
            for (const r of sorted) {
                const cid = String(r?.conditionId || '');
                const tf = String(r?.timeframe || '');
                const k = cid ? `${tf}:${cid}` : `${tf}:${String(r?.slug || '')}:${String(r?.symbol || '')}`;
                seen.add(k);
                const prev = sticky.get(k) || {};
                sticky.set(k, { ...prev, ...r, _lastSeenAtMs: nowMs });
            }
            for (const [k, v] of Array.from(sticky.entries())) {
                if (!v) { sticky.delete(k); continue; }
                const endMs = v?.endDate ? Date.parse(String(v.endDate)) : NaN;
                if (Number.isFinite(endMs)) {
                    const sec = Math.floor((endMs - nowMs) / 1000);
                    v.secondsToExpire = Math.max(0, sec);
                }
                const secNum = v?.secondsToExpire != null ? Number(v.secondsToExpire) : NaN;
                const expired = Number.isFinite(endMs) ? endMs <= nowMs : (Number.isFinite(secNum) ? secNum <= 0 : false);
                if (expired) { sticky.delete(k); continue; }
                const inWindow = Number.isFinite(secNum) ? secNum <= monitorWindowSec : (Number.isFinite(endMs) ? (endMs - nowMs) <= monitorWindowSec * 1000 : false);
                if (!seen.has(k) && !inWindow) sticky.delete(k);
            }
            const merged = sortCandidates(Array.from(sticky.values()));
            const count = Number(rr.data?.count ?? sorted.length);
            const eligible = Number(sorted.filter((c: any) => c?.meetsMinProb === true && c?.eligibleByExpiry === true).length);
            const nextSig = merged.slice(0, 120).map((r: any) => `${String(r?.timeframe || '')}:${String(r?.conditionId || '')}:${String(r?.slug || '')}:${String(r?.symbol || '')}:${String(r?.secondsToExpire ?? '')}:${String(r?.chosenPrice ?? '')}:${r?.meetsMinProb === true ? 1 : 0}:${r?.eligibleByExpiry === true ? 1 : 0}`).join('|');
            const nextMetaSig = `${count}:${eligible}`;
            if (nextSig !== candidatesSigRef.current) {
                candidatesSigRef.current = nextSig;
                startTransition(() => setCandidates(merged));
            }
            if (nextMetaSig !== candidatesMetaSigRef.current) {
                candidatesMetaSigRef.current = nextMetaSig;
                setCandidatesMeta({ count, eligible });
            }
            return;
        }
        const res = await apiGet('candidates_15m', '/group-arb/crypto15m/candidates', { params: { minProb, expiresWithinSec, limit: 20 } });
        const list = Array.isArray(res.data?.candidates) ? res.data.candidates : [];
        const sorted = sortCandidates(list);
        const count = Number(res.data?.count ?? sorted.length);
        const eligible = Number(res.data?.countEligible ?? sorted.filter((c: any) => c?.meetsMinProb === true && c?.eligibleByExpiry === true).length);
        const nextSig = sorted.slice(0, 60).map((r: any) => `${String(r?.conditionId || '')}:${String(r?.secondsToExpire ?? '')}:${String(r?.chosenPrice ?? '')}:${r?.meetsMinProb === true ? 1 : 0}:${r?.eligibleByExpiry === true ? 1 : 0}`).join('|');
        const nextMetaSig = `${count}:${eligible}`;
        if (nextSig !== candidatesSigRef.current) {
            candidatesSigRef.current = nextSig;
            startTransition(() => setCandidates(sorted));
        }
        if (nextMetaSig !== candidatesMetaSigRef.current) {
            candidatesMetaSigRef.current = nextMetaSig;
            setCandidatesMeta({ count, eligible });
        }
    };

    const fetchDeltaBox = async () => {
        const baseSymbols = ['BTC', 'ETH', 'SOL', 'XRP'] as Array<'BTC' | 'ETH' | 'SOL' | 'XRP'>;
        const baseTimeframes = ['5m', '15m', '1h', '4h', '1d'] as Array<'5m' | '15m' | '1h' | '4h' | '1d'>;
        const symbols = variant === 'all' ? (allSymbols.length ? allSymbols : baseSymbols) : baseSymbols;
        const timeframes = variant === 'all' ? (allTimeframes.length ? allTimeframes : baseTimeframes) : baseTimeframes;
        if (!symbols.length || !timeframes.length) {
            setDeltaBoxData(null);
            return;
        }
        setDeltaBoxLoading(true);
        try {
            const r = await apiGet('delta_box', '/group-arb/crypto/delta-box', {
                params: {
                    symbols: symbols.join(','),
                    timeframes: timeframes.join(','),
                }
            });
            setDeltaBoxData(r.data || null);
        } finally {
            setDeltaBoxLoading(false);
        }
    };

    const fetchHistory = async () => {
        if (historyStrategy === 'crypto15m') {
            const res = await apiGet('history_15m', '/group-arb/crypto15m/history', { params: { refresh: true, intervalMs: 1000, maxEntries: 50 } });
            const h = Array.isArray(res.data?.history) ? res.data.history : [];
            const nextHistory = h.map((x: any) => ({ ...x, strategy: 'crypto15m' }));
            const nextSig = nextHistory.slice(0, 120).map((x: any) => `${String(x?.id ?? '')}:${String(x?.orderStatus ?? '')}:${String(x?.filledSize ?? '')}:${String(x?.result ?? '')}:${String(x?.state ?? '')}`).join('|');
            const nextSummary = res.data?.summary || null;
            const nextConfig = Array.isArray(res.data?.configEvents) ? res.data.configEvents : [];
            const nextMetaSig = `${String(nextSummary?.count ?? '')}:${String(nextSummary?.pnlTotalUsdc ?? '')}:${String(nextConfig.length)}`;
            if (nextSig !== historySigRef.current) {
                historySigRef.current = nextSig;
                startTransition(() => setHistory(nextHistory));
            }
            if (nextMetaSig !== historyMetaSigRef.current) {
                historyMetaSigRef.current = nextMetaSig;
                setHistorySummary(nextSummary);
                setConfigEvents(nextConfig);
            }
            return;
        }
        if (historyStrategy === 'cryptoall') {
            const res = await apiGet('history_all', '/group-arb/cryptoall/history', { params: { refresh: true, intervalMs: 1000, maxEntries: 50 } });
            const h = Array.isArray(res.data?.history) ? res.data.history : [];
            const nextHistory = h.map((x: any) => ({ ...x, strategy: 'cryptoall' }));
            const nextSig = nextHistory.slice(0, 120).map((x: any) => `${String(x?.id ?? '')}:${String(x?.orderStatus ?? '')}:${String(x?.filledSize ?? '')}:${String(x?.result ?? '')}:${String(x?.state ?? '')}`).join('|');
            const nextSummary = res.data?.summary || null;
            const nextMetaSig = `${String(nextSummary?.count ?? '')}:${String(nextSummary?.pnlTotalUsdc ?? '')}:0`;
            if (nextSig !== historySigRef.current) {
                historySigRef.current = nextSig;
                startTransition(() => setHistory(nextHistory));
            }
            if (nextMetaSig !== historyMetaSigRef.current) {
                historyMetaSigRef.current = nextMetaSig;
                setHistorySummary(nextSummary);
                setConfigEvents([]);
            }
            return;
        }
        const [r15, rAll] = await Promise.all([
            apiGet('history_15m_all', '/group-arb/crypto15m/history', { params: { refresh: true, intervalMs: 1000, maxEntries: 50 } }),
            apiGet('history_all_all', '/group-arb/cryptoall/history', { params: { refresh: true, intervalMs: 1000, maxEntries: 50 } }),
        ]);
        const h15 = (Array.isArray(r15.data?.history) ? r15.data.history : []).map((x: any) => ({ ...x, strategy: 'crypto15m' }));
        const hAll = (Array.isArray(rAll.data?.history) ? rAll.data.history : []).map((x: any) => ({ ...x, strategy: 'cryptoall' }));
        const merged = h15.concat(hAll).sort((a: any, b: any) => {
            const ta = Date.parse(String(a?.timestamp || '')) || 0;
            const tb = Date.parse(String(b?.timestamp || '')) || 0;
            return tb - ta;
        }).slice(0, 80);
        const s15 = r15.data?.summary || {};
        const sAll = rAll.data?.summary || {};
        const sum = {
            count: Number(s15.count || 0) + Number(sAll.count || 0),
            totalStakeUsd: Number(s15.totalStakeUsd || 0) + Number(sAll.totalStakeUsd || 0),
            pnlTotalUsdc: Number(s15.pnlTotalUsdc || 0) + Number(sAll.pnlTotalUsdc || 0),
            winCount: Number(s15.winCount || 0) + Number(sAll.winCount || 0),
            lossCount: Number(s15.lossCount || 0) + Number(sAll.lossCount || 0),
            openCount: Number(s15.openCount || 0) + Number(sAll.openCount || 0),
            redeemableCount: Number(s15.redeemableCount || 0) + Number(sAll.redeemableCount || 0),
            redeemedCount: Number(s15.redeemedCount || 0) + Number(sAll.redeemedCount || 0),
            totalOrders1h: Number(s15.totalOrders1h || 0) + Number(sAll.totalOrders1h || 0),
            filledOrders1h: Number(s15.filledOrders1h || 0) + Number(sAll.filledOrders1h || 0),
            filledUsd1h: Number(s15.filledUsd1h || 0) + Number(sAll.filledUsd1h || 0),
        };
        (sum as any).fillRate1h = Number(sum.totalOrders1h || 0) > 0 ? (Number(sum.filledOrders1h || 0) / Number(sum.totalOrders1h || 0)) : 0;
        const nextSig = merged.slice(0, 120).map((x: any) => `${String(x?.strategy ?? '')}:${String(x?.id ?? '')}:${String(x?.orderStatus ?? '')}:${String(x?.filledSize ?? '')}:${String(x?.result ?? '')}:${String(x?.state ?? '')}`).join('|');
        const nextConfig = Array.isArray(r15.data?.configEvents) ? r15.data.configEvents : [];
        const nextMetaSig = `${String(sum.count)}:${String(sum.pnlTotalUsdc)}:${String(nextConfig.length)}`;
        if (nextSig !== historySigRef.current) {
            historySigRef.current = nextSig;
            startTransition(() => setHistory(merged));
        }
        if (nextMetaSig !== historyMetaSigRef.current) {
            historyMetaSigRef.current = nextMetaSig;
            setHistorySummary(sum);
            setConfigEvents(nextConfig);
        }
    };

    const fetchStoplossHistory = async () => {
        const endpoint = variant === 'all' ? '/group-arb/cryptoall/stoploss/history' : '/group-arb/crypto15m/stoploss/history';
        const res = await apiGet('stoploss_history', endpoint, { params: { maxEntries: 120 } });
        setStoplossHistory(Array.isArray(res.data?.history) ? res.data.history : []);
        setStoplossSummary(res.data?.summary || null);
    };

    const onOpenStoploss = async () => {
        setStoplossOpen(true);
        setStoplossLoading(true);
        try {
            await fetchStoplossHistory();
        } finally {
            setStoplossLoading(false);
        }
    };

    const fetchTradeAnalysis = async (opts?: { tradeId?: number | null }) => {
        setAnalysisLoading(true);
        try {
            const tradeId = opts?.tradeId != null ? Number(opts.tradeId) : null;
            const res = await apiGet('trade_analysis', '/group-arb/crypto15m/analysis/trades', {
                params: { limit: 100, tradeId: tradeId != null ? tradeId : undefined },
            });
            setAnalysisData(res.data || null);
            const firstId = (res.data?.trades && res.data.trades[0] && res.data.trades[0].id != null) ? Number(res.data.trades[0].id) : null;
            const nextId = tradeId != null ? tradeId : (analysisTradeId != null ? analysisTradeId : firstId);
            if (tradeId == null && nextId != null && nextId !== analysisTradeId) {
                setAnalysisTradeId(nextId);
                const res2 = await apiGet('trade_analysis_detail', '/group-arb/crypto15m/analysis/trades', { params: { limit: 100, tradeId: nextId } });
                setAnalysisData(res2.data || null);
            }
        } finally {
            setAnalysisLoading(false);
        }
    };

    const onOpenAnalysis = async () => {
        setAnalysisOpen(true);
        await fetchTradeAnalysis();
    };

    useEffect(() => {
        if (!analysisOpen) {
            try { analysisAggChartRef.current?.remove?.(); } catch {}
            try { analysisTradeChartRef.current?.remove?.(); } catch {}
            analysisAggChartRef.current = null;
            analysisAgg980Ref.current = null;
            analysisAgg999Ref.current = null;
            analysisAggC980Ref.current = null;
            analysisAggC999Ref.current = null;
            analysisTradeChartRef.current = null;
            analysisTradeAskRef.current = null;
            analysisTradeD999Ref.current = null;
            analysisTradeCapLineRef.current = null;
            return;
        }
        if (analysisAggChartElRef.current && !analysisAggChartRef.current) {
            const chart = createChart(analysisAggChartElRef.current, {
                height: 220,
                layout: { background: { color: 'transparent' }, textColor: '#E5E7EB' },
                grid: { vertLines: { color: 'rgba(255,255,255,0.06)' }, horzLines: { color: 'rgba(255,255,255,0.06)' } },
                rightPriceScale: { borderColor: 'rgba(255,255,255,0.12)' },
                leftPriceScale: { borderColor: 'rgba(255,255,255,0.12)' },
                timeScale: { borderColor: 'rgba(255,255,255,0.12)', timeVisible: true, secondsVisible: true },
                crosshair: { vertLine: { color: 'rgba(255,255,255,0.2)' }, horzLine: { color: 'rgba(255,255,255,0.2)' } },
            });
            const d980 = chart.addHistogramSeries({ color: 'rgba(59,130,246,0.55)' });
            const d999 = chart.addHistogramSeries({ color: 'rgba(168,85,247,0.55)' });
            const c980 = chart.addLineSeries({ color: '#3b82f6', lineWidth: 2, priceScaleId: 'left' });
            const c999 = chart.addLineSeries({ color: '#a855f7', lineWidth: 2, priceScaleId: 'left' });
            analysisAggChartRef.current = chart;
            analysisAgg980Ref.current = d980;
            analysisAgg999Ref.current = d999;
            analysisAggC980Ref.current = c980;
            analysisAggC999Ref.current = c999;
        }
        if (analysisTradeChartElRef.current && !analysisTradeChartRef.current) {
            const chart = createChart(analysisTradeChartElRef.current, {
                height: 220,
                layout: { background: { color: 'transparent' }, textColor: '#E5E7EB' },
                grid: { vertLines: { color: 'rgba(255,255,255,0.06)' }, horzLines: { color: 'rgba(255,255,255,0.06)' } },
                rightPriceScale: { borderColor: 'rgba(255,255,255,0.12)' },
                leftPriceScale: { borderColor: 'rgba(255,255,255,0.12)' },
                timeScale: { borderColor: 'rgba(255,255,255,0.12)', timeVisible: true, secondsVisible: true },
                crosshair: { vertLine: { color: 'rgba(255,255,255,0.2)' }, horzLine: { color: 'rgba(255,255,255,0.2)' } },
            });
            const ask = chart.addLineSeries({ color: '#22c55e', lineWidth: 2 });
            const d999 = chart.addHistogramSeries({ color: 'rgba(168,85,247,0.55)', priceScaleId: 'left' });
            analysisTradeChartRef.current = chart;
            analysisTradeAskRef.current = ask;
            analysisTradeD999Ref.current = d999;
        }
        return () => {
            try { analysisAggChartRef.current?.remove?.(); } catch {}
            try { analysisTradeChartRef.current?.remove?.(); } catch {}
            analysisAggChartRef.current = null;
            analysisAgg980Ref.current = null;
            analysisAgg999Ref.current = null;
            analysisAggC980Ref.current = null;
            analysisAggC999Ref.current = null;
            analysisTradeChartRef.current = null;
            analysisTradeAskRef.current = null;
            analysisTradeD999Ref.current = null;
            analysisTradeCapLineRef.current = null;
        };
    }, [analysisOpen]);

    useEffect(() => {
        if (!analysisOpen) return;
        const timeline = Array.isArray(analysisData?.timeline) ? analysisData.timeline : [];
        if (analysisAgg980Ref.current && analysisAgg999Ref.current && analysisAggC980Ref.current && analysisAggC999Ref.current) {
            const base = Math.floor(Date.now() / 1000);
            analysisAgg980Ref.current.setData(timeline.map((r: any) => ({ time: base + Number(r.offsetSec || 0), value: Number(r.usd980 || 0) })));
            analysisAgg999Ref.current.setData(timeline.map((r: any) => ({ time: base + Number(r.offsetSec || 0), value: Number(r.usd999 || 0) })));
            analysisAggC980Ref.current.setData(timeline.map((r: any) => ({ time: base + Number(r.offsetSec || 0), value: Number(r.count980 || 0) })));
            analysisAggC999Ref.current.setData(timeline.map((r: any) => ({ time: base + Number(r.offsetSec || 0), value: Number(r.count999 || 0) })));
            try { analysisAggChartRef.current?.timeScale?.().fitContent?.(); } catch {}
        }
        const detail = analysisData?.tradeDetail || null;
        const pts = Array.isArray(detail?.book60s) ? detail.book60s : [];
        if (analysisTradeAskRef.current && analysisTradeD999Ref.current) {
            analysisTradeAskRef.current.setData(pts.filter((p: any) => p?.sec != null && p?.bestAsk != null).map((p: any) => ({ time: Number(p.sec), value: Number(p.bestAsk) })));
            analysisTradeD999Ref.current.setData(pts.filter((p: any) => p?.sec != null && p?.depthUsd999 != null).map((p: any) => ({ time: Number(p.sec), value: Number(p.depthUsd999) })));
            try { analysisTradeChartRef.current?.timeScale?.().fitContent?.(); } catch {}
            try { analysisTradeCapLineRef.current?.remove?.(); } catch {}
            analysisTradeCapLineRef.current = null;
            if (detail?.limitPrice != null && analysisTradeAskRef.current?.createPriceLine) {
                analysisTradeCapLineRef.current = analysisTradeAskRef.current.createPriceLine({
                    price: Number(detail.limitPrice),
                    color: 'rgba(255,255,255,0.35)',
                    lineWidth: 1,
                    lineStyle: 2,
                    axisLabelVisible: true,
                    title: 'cap',
                });
            }
        }
    }, [analysisOpen, analysisData]);

    const fetchHealth = async () => {
        const [r1, r2] = await Promise.all([
            apiGet('health_relayer', '/group-arb/relayer/status'),
            apiGet('health_autoredeem', '/group-arb/auto-redeem/status'),
        ]);
        setHealth({
            relayer: r1.data?.status,
            autoRedeem: r2.data?.status,
        });
    };

    const fetchWatchdog = async () => {
        const endpoint = variant === 'all' ? '/group-arb/cryptoall/watchdog/status' : '/group-arb/crypto15m/watchdog/status';
        const r = await apiGet('watchdog', endpoint);
        setWatchdog(r.data?.status);
    };

    const fetchThresholds = async () => {
        setThresholdsLoading(true);
        try {
            const endpoint = variant === 'all' ? '/group-arb/cryptoall/delta-thresholds' : '/group-arb/crypto15m/delta-thresholds';
            const r = await apiGet('thresholds', endpoint);
            const t = r.data?.thresholds || {};
            setSavedDeltaThresholds(t);
            if (variant === 'all') {
                const legacy = (t?.legacy && typeof t.legacy === 'object')
                    ? t.legacy
                    : { btcMinDelta: t?.btcMinDelta, ethMinDelta: t?.ethMinDelta, solMinDelta: t?.solMinDelta, xrpMinDelta: t?.xrpMinDelta };
                if (legacy?.btcMinDelta != null) setBtcMinDelta(Number(legacy.btcMinDelta));
                if (legacy?.ethMinDelta != null) setEthMinDelta(Number(legacy.ethMinDelta));
                if (legacy?.solMinDelta != null) setSolMinDelta(Number(legacy.solMinDelta));
                if (legacy?.xrpMinDelta != null) setXrpMinDelta(Number(legacy.xrpMinDelta));
                const by = (t?.byTimeframe && typeof t.byTimeframe === 'object') ? t.byTimeframe : null;
                const tfs = ['5m', '15m', '1h', '4h', '1d'] as const;
                const next: any = {};
                for (const tf of tfs) {
                    const row = (by && (by as any)[tf]) ? (by as any)[tf] : legacy;
                    next[tf] = {
                        btcMinDelta: Math.max(0, Number(row?.btcMinDelta ?? legacy?.btcMinDelta ?? 600)),
                        ethMinDelta: Math.max(0, Number(row?.ethMinDelta ?? legacy?.ethMinDelta ?? 30)),
                        solMinDelta: Math.max(0, Number(row?.solMinDelta ?? legacy?.solMinDelta ?? 0.8)),
                        xrpMinDelta: Math.max(0, Number(row?.xrpMinDelta ?? legacy?.xrpMinDelta ?? 0.0065)),
                    };
                }
                setCryptoAllDeltaByTimeframe(next);
            } else {
                if (t?.btcMinDelta != null) setBtcMinDelta(Number(t.btcMinDelta));
                if (t?.ethMinDelta != null) setEthMinDelta(Number(t.ethMinDelta));
                if (t?.solMinDelta != null) setSolMinDelta(Number(t.solMinDelta));
                if (t?.xrpMinDelta != null) setXrpMinDelta(Number(t.xrpMinDelta));
            }
        } finally {
            setThresholdsLoading(false);
        }
    };

    const fetchCryptoAllThresholdsForModal = async () => {
        setSavedCryptoAllThresholdsLoading(true);
        try {
            const r = await apiGet('thresholds_cryptoall_modal', '/group-arb/cryptoall/delta-thresholds');
            setSavedCryptoAllThresholds(r.data?.thresholds || null);
        } finally {
            setSavedCryptoAllThresholdsLoading(false);
        }
    };

    const saveAllSettings = async () => {
        setThresholdsSaving(true);
        try {
            if (variant === 'all') {
                await Promise.all([
                    apiPost('save_deltas_all', '/group-arb/cryptoall/delta-thresholds', { btcMinDelta, ethMinDelta, solMinDelta, xrpMinDelta, byTimeframe: cryptoAllDeltaByTimeframe }),
                    apiPost('save_config_all', '/group-arb/cryptoall/config', {
                        amountUsd,
                        minProb,
                        expiresWithinSec: Math.max(...Object.values(expiresWithinSecByTimeframe || { '5m': expiresWithinSec, '15m': expiresWithinSec, '1h': expiresWithinSec, '4h': expiresWithinSec, '1d': expiresWithinSec })),
                        expiresWithinSecByTimeframe,
                        pollMs,
                        symbols: allSymbols,
                        timeframes: allTimeframes,
                        stoplossEnabled,
                        stoplossCut1DropCents,
                        stoplossCut1SellPct,
                        stoplossCut2DropCents,
                        stoplossCut2SellPct,
                        stoplossMinSecToExit,
                        adaptiveDeltaEnabled,
                        adaptiveDeltaBigMoveMultiplier,
                        adaptiveDeltaRevertNoBuyCount,
                    }),
                ]);
            } else {
                await Promise.all([
                    apiPost('save_deltas_15m', '/group-arb/crypto15m/delta-thresholds', { btcMinDelta, ethMinDelta, solMinDelta, xrpMinDelta }),
                    apiPost('save_config_15m', '/group-arb/crypto15m/config', {
                        amountUsd,
                        buySizingMode,
                        minProb,
                        expiresWithinSec,
                        pollMs,
                        sweepEnabled,
                        sweepWindowSec,
                        sweepMaxOrdersPerMarket,
                        sweepMaxTotalUsdPerMarket,
                        sweepMinIntervalMs,
                        trendEnabled,
                        trendMinutes,
                        staleMsThreshold,
                        stoplossEnabled,
                        stoplossCut1DropCents,
                        stoplossCut1SellPct,
                        stoplossCut2DropCents,
                        stoplossCut2SellPct,
                        stoplossMinSecToExit,
                        adaptiveDeltaEnabled,
                        adaptiveDeltaBigMoveMultiplier,
                        adaptiveDeltaRevertNoBuyCount,
                    }),
                ]);
            }
            await fetchThresholds();
            if (allSettingsOpen || variant === 'all') await fetchCryptoAllThresholdsForModal();
            message.success('Saved');
        } catch (e: any) {
            const msg = e?.response?.data?.error || e?.message || String(e);
            message.error(String(msg));
        } finally {
            setThresholdsSaving(false);
        }
        refreshAll().catch(() => {});
    };

    const refreshAll = async () => {
        await Promise.allSettled([
            fetchStatus(),
            fetchCandidates(),
            fetchHistory(),
            fetchWatchdog(),
            fetchThresholds(),
            ...(allSettingsOpen || variant === 'all' ? [fetchCryptoAllThresholdsForModal()] : []),
        ]);
    };

    useEffect(() => {
        for (const c of abortersRef.current.values()) {
            try { c.abort(); } catch {}
        }
        abortersRef.current.clear();
        candidatesSigRef.current = '';
        candidatesMetaSigRef.current = '';
        historySigRef.current = '';
        historyMetaSigRef.current = '';
        cryptoAllStickyCandidatesRef.current.clear();
        setCandidates([]);
        setCandidatesMeta(null);
        setStatus(null);
        setWatchdog(null);
        setHealth(null);
        setHistory([]);
        setHistorySummary(null);
        setConfigEvents([]);
        setStoplossHistory([]);
        setStoplossSummary(null);
        setWsError(null);
        setWsConnected(false);
        setWsLastAt(null);
        wsSessionRef.current += 1;
        if (wsReconnectTimerRef.current) clearTimeout(wsReconnectTimerRef.current);
        const prevWs = wsRef.current;
        if (prevWs) {
            try {
                (prevWs as any).onopen = null;
                (prevWs as any).onmessage = null;
                (prevWs as any).onerror = null;
                (prevWs as any).onclose = null;
            } catch {}
            try { prevWs.close(); } catch {}
            wsRef.current = null;
        }
        fetchThresholds().catch(() => {});
        refreshAll().catch(() => {});
    }, [apiPath, variant]);

    useEffect(() => {
        if (variant !== 'all') return;
        if (!allSymbols.length || !allTimeframes.length) return;
        fetchCandidates().catch(() => {});
    }, [apiPath, variant, allSymbols.join(','), allTimeframes.join(','), minProb, expiresWithinSec]);

    useEffect(() => {
        if (timerRef.current) clearInterval(timerRef.current);
        if (wsConnected) return;
        const urgent = candidates.some((c: any) => c?.meetsMinProb === true && c?.eligibleByExpiry === true);
        const effectivePollMs = urgent ? Math.min(1000, Math.max(500, Math.floor(pollMs))) : Math.max(500, Math.floor(pollMs));
        timerRef.current = setInterval(() => {
            if (!autoRefresh) return;
            if (editing) return;
            Promise.allSettled([fetchStatus(), fetchCandidates(), fetchWatchdog()]).catch(() => {});
        }, effectivePollMs);
        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [apiPath, autoRefresh, editing, minProb, expiresWithinSec, pollMs, candidates.length, wsConnected]);

    useEffect(() => {
        if (timerHistoryRef.current) clearInterval(timerHistoryRef.current);
        timerHistoryRef.current = setInterval(() => {
            if (!autoRefresh) return;
            if (editing) return;
            fetchHistory().catch(() => {});
        }, 10000);
        return () => {
            if (timerHistoryRef.current) clearInterval(timerHistoryRef.current);
        };
    }, [apiPath, autoRefresh, editing, historyStrategy]);

    useEffect(() => {
        if (timerDeltaBoxRef.current) clearInterval(timerDeltaBoxRef.current);
        const run = () => {
            if (!autoRefresh) return;
            if (editing) return;
            fetchDeltaBox().catch(() => {});
        };
        run();
        timerDeltaBoxRef.current = setInterval(run, 8000);
        return () => {
            if (timerDeltaBoxRef.current) clearInterval(timerDeltaBoxRef.current);
        };
    }, [apiPath, autoRefresh, editing, variant, allSymbols.join(','), allTimeframes.join(',')]);

    useEffect(() => {
        fetchHistory().catch(() => {});
    }, [historyStrategy]);

    useEffect(() => {
        if (safeMode || variant === 'all') {
            wsSessionRef.current += 1;
            if (wsReconnectTimerRef.current) clearTimeout(wsReconnectTimerRef.current);
            const prevWs = wsRef.current;
            if (prevWs) {
                try {
                    (prevWs as any).onopen = null;
                    (prevWs as any).onmessage = null;
                    (prevWs as any).onerror = null;
                    (prevWs as any).onclose = null;
                } catch {}
                try { prevWs.close(); } catch {}
                wsRef.current = null;
            }
            setWsConnected(false);
            return;
        }
        if (!autoRefresh) {
            wsSessionRef.current += 1;
            if (wsReconnectTimerRef.current) clearTimeout(wsReconnectTimerRef.current);
            const prevWs = wsRef.current;
            if (prevWs) {
                try {
                    (prevWs as any).onopen = null;
                    (prevWs as any).onmessage = null;
                    (prevWs as any).onerror = null;
                    (prevWs as any).onclose = null;
                } catch {}
                try { prevWs.close(); } catch {}
                wsRef.current = null;
            }
            setWsConnected(false);
            return;
        }
        const connect = () => {
            if (wsReconnectTimerRef.current) clearTimeout(wsReconnectTimerRef.current);
            const sessionId = ++wsSessionRef.current;
            const prevWs = wsRef.current;
            if (prevWs) {
                try {
                    (prevWs as any).onopen = null;
                    (prevWs as any).onmessage = null;
                    (prevWs as any).onerror = null;
                    (prevWs as any).onclose = null;
                } catch {}
                try { prevWs.close(); } catch {}
                wsRef.current = null;
            }
            const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
            const wsPath = apiPath('/group-arb/crypto15m/ws');
            const wsUrl = `${protocol}://${window.location.host}/api${wsPath}?minProb=${encodeURIComponent(String(minProb))}&expiresWithinSec=${encodeURIComponent(String(expiresWithinSec))}&limit=20`;
            const ws = new WebSocket(wsUrl);
            wsRef.current = ws;
            setWsError(null);
            ws.onopen = () => {
                if (wsSessionRef.current !== sessionId) return;
                wsRetryRef.current = 0;
                setWsConnected(true);
            };
            ws.onclose = () => {
                if (wsSessionRef.current !== sessionId) return;
                setWsConnected(false);
                if (!autoRefresh) return;
                const retry = Math.min(8, wsRetryRef.current + 1);
                wsRetryRef.current = retry;
                const delayMs = Math.min(10_000, 300 * Math.pow(2, retry));
                wsReconnectTimerRef.current = setTimeout(connect, delayMs);
            };
            ws.onerror = () => {
                if (wsSessionRef.current !== sessionId) return;
                setWsError('ws error');
                setWsConnected(false);
                try {
                    (ws as any).onopen = null;
                    (ws as any).onmessage = null;
                    (ws as any).onerror = null;
                    (ws as any).onclose = null;
                } catch {}
                try { ws.close(); } catch {}
            };
            ws.onmessage = (evt) => {
                if (wsSessionRef.current !== sessionId) return;
                try {
                    const msg = JSON.parse(String(evt.data || '{}'));
                    if (msg?.type === 'snapshot') {
                        if (msg?.status) setStatus(msg.status);
                        if (msg?.candidates) {
                            const payload = msg.candidates;
                            const list = Array.isArray(payload?.candidates) ? payload.candidates : [];
                            const sorted = sortCandidates(list);
                            const count = Number(payload?.count ?? sorted.length);
                            const eligible = Number(payload?.countEligible ?? sorted.filter((c: any) => c?.meetsMinProb === true && c?.eligibleByExpiry === true).length);
                            const nextSig = sorted.slice(0, 60).map((r: any) => `${String(r?.conditionId || '')}:${String(r?.secondsToExpire ?? '')}:${String(r?.chosenPrice ?? '')}:${r?.meetsMinProb === true ? 1 : 0}:${r?.eligibleByExpiry === true ? 1 : 0}`).join('|');
                            const nextMetaSig = `${count}:${eligible}`;
                            if (nextSig !== candidatesSigRef.current) {
                                candidatesSigRef.current = nextSig;
                                startTransition(() => setCandidates(sorted));
                            }
                            if (nextMetaSig !== candidatesMetaSigRef.current) {
                                candidatesMetaSigRef.current = nextMetaSig;
                                setCandidatesMeta({ count, eligible });
                            }
                        }
                        setWsLastAt(String(msg?.at || new Date().toISOString()));
                        setWsError(null);
                    }
                    if (msg?.type === 'error') {
                        setWsError(String(msg?.message || 'ws error'));
                    }
                } catch {
                }
            };
        };
        connect();
        return () => {
            wsSessionRef.current += 1;
            if (wsReconnectTimerRef.current) clearTimeout(wsReconnectTimerRef.current);
            const prevWs = wsRef.current;
            if (prevWs) {
                try {
                    (prevWs as any).onopen = null;
                    (prevWs as any).onmessage = null;
                    (prevWs as any).onerror = null;
                    (prevWs as any).onclose = null;
                } catch {}
                try { prevWs.close(); } catch {}
                wsRef.current = null;
            }
        };
    }, [apiPath, autoRefresh, minProb, expiresWithinSec, safeMode, variant]);

    const onStart = async () => {
        setStartLoading(true);
        try {
            if (variant === 'all') {
                await apiPost('auto_start_all', '/group-arb/cryptoall/auto/start', {
                    amountUsd,
                    minProb,
                    expiresWithinSec,
                    pollMs,
                    symbols: allSymbols,
                    timeframes: allTimeframes,
                    stoplossEnabled,
                    stoplossCut1DropCents,
                    stoplossCut1SellPct,
                    stoplossCut2DropCents,
                    stoplossCut2SellPct,
                    stoplossMinSecToExit,
                    adaptiveDeltaEnabled,
                    adaptiveDeltaBigMoveMultiplier,
                    adaptiveDeltaRevertNoBuyCount,
                });
            } else {
                await apiPost('auto_start_15m', '/group-arb/crypto15m/auto/start', {
                    amountUsd,
                    minProb,
                    expiresWithinSec,
                    pollMs,
                    buySizingMode,
                    sweepEnabled,
                    sweepWindowSec,
                    sweepMaxOrdersPerMarket,
                    sweepMaxTotalUsdPerMarket,
                    sweepMinIntervalMs,
                    trendEnabled,
                    trendMinutes,
                    staleMsThreshold,
                    stoplossEnabled,
                    stoplossCut1DropCents,
                    stoplossCut1SellPct,
                    stoplossCut2DropCents,
                    stoplossCut2SellPct,
                    stoplossMinSecToExit,
                    adaptiveDeltaEnabled,
                    adaptiveDeltaBigMoveMultiplier,
                    adaptiveDeltaRevertNoBuyCount,
                });
            }
        } finally {
            setStartLoading(false);
        }
        refreshAll().catch(() => {});
    };

    const onStop = async () => {
        setStopLoading(true);
        try {
            const endpoint = variant === 'all' ? '/group-arb/cryptoall/auto/stop' : '/group-arb/crypto15m/auto/stop';
            await apiPost('auto_stop', endpoint);
        } finally {
            setStopLoading(false);
        }
        refreshAll().catch(() => {});
    };

    const onStartWatchdog = async () => {
        setWatchdogStartLoading(true);
        try {
            const endpoint = variant === 'all' ? '/group-arb/cryptoall/watchdog/start' : '/group-arb/crypto15m/watchdog/start';
            await apiPost('watchdog_start', endpoint, { durationHours: 12, pollMs: 30000 });
        } finally {
            setWatchdogStartLoading(false);
        }
        refreshAll().catch(() => {});
    };

    const onStopWatchdog = async () => {
        setWatchdogStopLoading(true);
        try {
            const endpoint = variant === 'all' ? '/group-arb/cryptoall/watchdog/stop' : '/group-arb/crypto15m/watchdog/stop';
            await apiPost('watchdog_stop', endpoint, { reason: 'manual_ui_stop', stopAuto: true });
        } finally {
            setWatchdogStopLoading(false);
        }
        refreshAll().catch(() => {});
    };

    const onBid = async (row: any) => {
        setBidLoadingId(String(row?.conditionId || ''));
        try {
            const endpoint = variant === 'all' ? '/group-arb/cryptoall/order' : '/group-arb/crypto15m/order';
            const body: any = {
                conditionId: row.conditionId,
                outcomeIndex: row.chosenIndex,
                amountUsd,
                minPrice: minProb,
                stoplossEnabled,
                stoplossCut1DropCents,
                stoplossCut1SellPct,
                stoplossCut2DropCents,
                stoplossCut2SellPct,
                stoplossMinSecToExit,
            };
            if (variant === 'all') {
                body.symbol = row.symbol;
                body.timeframe = row.timeframe;
                body.adaptiveDeltaEnabled = adaptiveDeltaEnabled;
                body.adaptiveDeltaBigMoveMultiplier = adaptiveDeltaBigMoveMultiplier;
                body.adaptiveDeltaRevertNoBuyCount = adaptiveDeltaRevertNoBuyCount;
            } else {
                body.trendEnabled = trendEnabled;
                body.trendMinutes = trendMinutes;
            }
            const res = await apiPost('order', endpoint, body);
            const data = res.data || {};
            if (data?.success === true) {
                message.success('Order placed');
            } else if (data?.skipped === true) {
                message.warning(`Skipped: ${String(data?.reason || 'skipped')}`);
            } else {
                message.error(String(data?.error || data?.reason || 'Order failed'));
            }
        } catch (e: any) {
            const msg = e?.response?.data?.error || e?.message || String(e);
            message.error(String(msg));
        } finally {
            setBidLoadingId(null);
        }
        refreshAll().catch(() => {});
    };

    const onResetActive = async () => {
        setResetLoading(true);
        try {
            const endpoint = variant === 'all' ? '/group-arb/cryptoall/active/reset' : '/group-arb/crypto15m/active/reset';
            await apiPost('reset_active', endpoint);
        } finally {
            setResetLoading(false);
        }
        refreshAll().catch(() => {});
    };

    const columns = useMemo(() => {
        const base = [
            {
                title: 'Symbol',
                dataIndex: 'symbol',
                key: 'symbol',
                width: 90,
                render: (v: any) => <Tag color="blue">{String(v || '').toUpperCase() || '-'}</Tag>,
            },
            ...(variant === 'all' ? [{
                title: 'TF',
                dataIndex: 'timeframe',
                key: 'timeframe',
                width: 70,
                render: (v: any) => v ? <Tag>{String(v).toUpperCase()}</Tag> : '-',
            }] : []),
            {
                title: 'Market',
                dataIndex: 'title',
                key: 'title',
                width: 360,
                render: (_: any, r: any) => {
                    const t = String(r?.title || r?.slug || r?.conditionId || '');
                    const cid = String(r?.conditionId || '');
                    return (
                        <div style={{ maxWidth: '100%' }}>
                            <Text style={{ color: '#fff', fontWeight: 600, display: 'block' }} ellipsis={{ tooltip: t }}>{t}</Text>
                            <Text style={{ color: '#aaa', fontSize: 12, display: 'block' }} ellipsis={{ tooltip: cid }}>{cid}</Text>
                        </div>
                    );
                },
            },
            {
                title: 'Expire(s)',
                dataIndex: 'secondsToExpire',
                key: 'secondsToExpire',
                width: 110,
                render: (_: any, r: any) => <CountdownTag endDate={r.endDate} fallbackSeconds={r.secondsToExpire} />,
            },
            {
                title: 'Outcomes',
                key: 'outcomes',
                render: (_: any, r: any) => {
                    const o = Array.isArray(r.outcomes) ? r.outcomes : [];
                    const p = Array.isArray(r.prices) ? r.prices : [];
                    const a = Array.isArray(r.asksCount) ? r.asksCount : [];
                    return (
                        <Space direction="vertical" size={2}>
                            <div style={{ color: '#ddd' }}>{o[0]}: {toCents(p[0])} {a[0] > 0 ? null : <Tag>no-asks</Tag>}</div>
                            <div style={{ color: '#ddd' }}>{o[1]}: {toCents(p[1])} {a[1] > 0 ? null : <Tag>no-asks</Tag>}</div>
                        </Space>
                    );
                },
            },
            {
                title: 'Pick',
                key: 'pick',
                width: 140,
                render: (_: any, r: any) => {
                    const okPrice = r?.meetsMinProb === true;
                    const okExp = r?.eligibleByExpiry === true;
                    const ok = okPrice && okExp;
                    const reason = r?.reason || (ok ? null : !okExp ? 'expiry' : !okPrice ? 'price' : 'n/a');
                    return (
                        <Space direction="vertical" size={2}>
                            <Tag color={ok ? 'green' : 'default'}>{r?.chosenOutcome ? String(r.chosenOutcome) : '-'} {toCents(r.chosenPrice)}</Tag>
                            {reason ? <Tag>{String(reason)}</Tag> : null}
                            <Tag>snapshot {r?.snapshotAt || '-'} • stale {r?.staleMs != null ? `${Math.floor(Number(r.staleMs) / 1000)}s` : '-'}</Tag>
                            {r?.booksAttemptError ? <Tag color="red">{String(r.booksAttemptError).slice(0, 80)}</Tag> : null}
                        </Space>
                    );
                },
            },
            {
                title: 'Action',
                key: 'action',
                width: 160,
                render: (_: any, r: any) => (
                    <Button
                        icon={<ShoppingCartOutlined />}
                        onClick={() => onBid(r)}
                        disabled={!!status?.actives?.[String(r.symbol || '').toUpperCase()]}
                        loading={bidLoadingId === String(r.conditionId)}
                    >
                        Bid ${amountUsd}
                    </Button>
                ),
            },
        ];
        return base;
    }, [variant, amountUsd, status?.actives, bidLoadingId]);

    const historyColumns = useMemo(() => {
        return [
            {
                title: 'Strat',
                dataIndex: 'strategy',
                key: 'strategy',
                width: 90,
                render: (v: any) => {
                    const s = String(v || '');
                    const label = s === 'cryptoall' ? 'ALL' : s === 'crypto15m' ? '15M' : s || '-';
                    return <Tag color={s === 'cryptoall' ? 'purple' : 'blue'}>{label}</Tag>;
                }
            },
            { title: 'Time', dataIndex: 'timestamp', key: 'timestamp', width: 190, render: (v: any) => String(v || '').replace('T', ' ').replace('Z', '') },
            { title: 'TF', dataIndex: 'timeframe', key: 'timeframe', width: 70, render: (v: any) => v ? <Tag>{String(v).toUpperCase()}</Tag> : '-' },
            { title: 'Symbol', dataIndex: 'symbol', key: 'symbol', width: 90, render: (v: any) => <Tag color="blue">{String(v || '').toUpperCase()}</Tag> },
            {
                title: 'Market',
                dataIndex: 'title',
                key: 'title',
                width: 360,
                render: (v: any, r: any) => {
                    const slug = String(r?.slug || '').trim();
                    const text = String(v || slug || r?.conditionId || '');
                    const style: any = { display: 'inline-block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
                    if (!slug) return <span title={text} style={style}>{text}</span>;
                    const href = `https://polymarket.com/event/${encodeURIComponent(slug)}`;
                    return <a href={href} target="_blank" rel="noreferrer" title={text} style={style}>{text}</a>;
                }
            },
            { title: 'Pick', dataIndex: 'outcome', key: 'outcome', width: 90, render: (v: any) => String(v || '') },
            { title: 'Amount', dataIndex: 'amountUsd', key: 'amountUsd', width: 120, render: (v: any, r: any) => {
                const used = v != null ? Number(v) : NaN;
                const req = r?.requestedAmountUsd != null ? Number(r.requestedAmountUsd) : NaN;
                const mode = r?.buySizingMode != null ? String(r.buySizingMode) : '';
                const depthCap = r?.sizingDepthCap != null ? Number(r.sizingDepthCap) : NaN;
                const levels = r?.sizingAskLevelsUsed != null ? Number(r.sizingAskLevelsUsed) : NaN;
                const showReq = Number.isFinite(req) && Number.isFinite(used) && Math.abs(req - used) >= 0.5;
                const label = Number.isFinite(used) ? (showReq ? `$${req.toFixed(0)} → $${used.toFixed(0)}` : `$${used.toFixed(0)}`) : '-';
                const tipLines = [
                    Number.isFinite(req) ? `requested: $${req.toFixed(2)}` : null,
                    Number.isFinite(used) ? `used: $${used.toFixed(2)}` : null,
                    mode ? `mode: ${mode}` : null,
                    Number.isFinite(depthCap) ? `depthCap: $${depthCap.toFixed(2)}` : null,
                    Number.isFinite(levels) ? `askLevels: ${Math.floor(levels)}` : null,
                ].filter(Boolean);
                return tipLines.length ? <Tooltip title={<div style={{ whiteSpace: 'pre-line' }}>{tipLines.join('\n')}</div>}><span>{label}</span></Tooltip> : <span>{label}</span>;
            } },
            { title: <Tooltip title="下單前從 CLOB /books 讀到的最低賣價（你買入的參考價）"><span>BestAsk</span></Tooltip>, dataIndex: 'bestAsk', key: 'bestAsk', width: 90, render: (v: any) => (v != null ? toCents(v) : '-') },
            { title: <Tooltip title="送單的最高買入價上限（FAK：能成交就成交，剩下直接取消）"><span>Limit</span></Tooltip>, dataIndex: 'limitPrice', key: 'limitPrice', width: 90, render: (v: any) => (v != null ? toCents(v) : '-') },
            { title: 'Order', dataIndex: 'orderStatus', key: 'orderStatus', width: 90, render: (v: any) => (v ? <Tag>{String(v)}</Tag> : '-') },
            { title: 'Filled', dataIndex: 'filledSize', key: 'filledSize', width: 80, render: (v: any) => (v != null ? Number(v).toFixed(2) : '-') },
            { title: 'Filled$', dataIndex: 'sweepFilledUsd', key: 'sweepFilledUsd', width: 90, render: (v: any) => (v != null ? Number(v).toFixed(2) : '-') },
            { title: 'AvgPx', dataIndex: 'sweepAvgFillPrice', key: 'sweepAvgFillPrice', width: 90, render: (v: any) => (v != null ? toCents(v) : '-') },
            { title: 'ms', dataIndex: 'sweepLastLatencyMs', key: 'sweepLastLatencyMs', width: 70, render: (v: any) => (v != null ? String(Math.floor(Number(v))) : '-') },
            { title: 'Stop', dataIndex: 'sweepStopReason', key: 'sweepStopReason', width: 110, render: (v: any) => (v ? String(v).slice(0, 14) : '-') },
            { title: 'Err', dataIndex: 'error', key: 'error', width: 140, render: (v: any) => (v ? String(v).slice(0, 22) : '-') },
            { title: 'Result', dataIndex: 'result', key: 'result', width: 90, render: (v: any) => <Tag color={String(v) === 'WIN' ? 'green' : String(v) === 'LOSS' ? 'red' : 'default'}>{String(v || '-')}</Tag> },
            { title: <Tooltip title="優先顯示本策略的 realizedPnL（已 redeem 才有）；否則 fallback 到 Data API 的 cashPnl。"><span>PnL</span></Tooltip>, dataIndex: 'cashPnl', key: 'cashPnl', width: 90, render: (v: any, r: any) => {
                const x = r?.realizedPnlUsdc != null ? r.realizedPnlUsdc : v;
                return x != null ? Number(x).toFixed(4) : '-';
            } },
            {
                title: <Tooltip title="部位/兌付流程狀態：open=仍持倉且未結算；redeemable=可領；✅=已領且有回款；loss=已領但 0 回款"><span>State</span></Tooltip>,
                key: 'state',
                width: 140,
                render: (_: any, r: any) => {
                    const state = String(r?.state || '');
                    if (!state) return <Tag>-</Tag>;
                    if (state === 'confirmed_paid') return <Tag color="green">✅</Tag>;
                    if (state === 'confirmed_no_payout') return <Tag color="red">loss</Tag>;
                    if (state === 'redeem_submitted') return <Tag color="blue">redeem submitted</Tag>;
                    if (state === 'redeem_failed') return <Tag color="red">redeem failed</Tag>;
                    if (state === 'redeemable') return <Tag color="gold">redeemable</Tag>;
                    if (state === 'open') return <Tag>open</Tag>;
                    if (state === 'position_missing') return <Tag>position missing</Tag>;
                    return <Tag>{state}</Tag>;
                },
            },
            { title: <Tooltip title="Redeem/Claim 交易哈希（未兌付前會顯示 -）"><span>Tx</span></Tooltip>, dataIndex: 'txHash', key: 'txHash', width: 120, render: (v: any) => (v ? <Tag>{String(v).slice(0, 6)}…{String(v).slice(-4)}</Tag> : '-') },
        ];
    }, []);

    const configColumns = useMemo(() => {
        return [
            { title: 'Time', dataIndex: 'timestamp', key: 'timestamp', width: 190, render: (v: any) => String(v || '').replace('T', ' ').replace('Z', '') },
            { title: 'Event', dataIndex: 'action', key: 'action', width: 120, render: (v: any) => <Tag color={String(v).includes('_start') ? 'green' : 'default'}>{String(v || '')}</Tag> },
            { title: 'Enabled', dataIndex: 'enabled', key: 'enabled', width: 90, render: (v: any) => <Tag color={v === true ? 'green' : v === false ? 'red' : 'default'}>{v === true ? 'ON' : v === false ? 'OFF' : '-'}</Tag> },
            { title: 'Config', dataIndex: 'config', key: 'config', render: (v: any) => <span style={{ color: '#ddd' }}>{summarizeConfig(v)}</span> },
        ];
    }, []);

    const stoplossColumns = useMemo(() => {
        return [
            { title: 'Time', dataIndex: 'timestamp', key: 'timestamp', width: 190, render: (v: any) => String(v || '').replace('T', ' ').replace('Z', '') },
            { title: 'TF', dataIndex: 'timeframe', key: 'timeframe', width: 70, render: (v: any) => v ? <Tag>{String(v).toUpperCase()}</Tag> : '-' },
            { title: 'Symbol', dataIndex: 'symbol', key: 'symbol', width: 90, render: (v: any) => <Tag color="blue">{String(v || '').toUpperCase()}</Tag> },
            { title: 'Reason', dataIndex: 'reason', key: 'reason', width: 80, render: (v: any) => <Tag color={String(v) === 'cut2' ? 'red' : String(v) === 'cut1' ? 'gold' : 'default'}>{String(v || '-')}</Tag> },
            { title: 'Target%', dataIndex: 'targetPct', key: 'targetPct', width: 90, render: (v: any) => (v != null ? Number(v).toFixed(0) : '-') },
            { title: 'Sell', dataIndex: 'sellAmount', key: 'sellAmount', width: 90, render: (v: any) => (v != null ? Number(v).toFixed(4) : '-') },
            { title: 'TargetSell', dataIndex: 'remainingToSellTarget', key: 'remainingToSellTarget', width: 90, render: (v: any) => (v != null ? Number(v).toFixed(4) : '-') },
            { title: 'Bid', dataIndex: 'currentBid', key: 'currentBid', width: 80, render: (v: any) => (v != null ? toCents(v) : '-') },
            { title: 'Ask', dataIndex: 'currentAsk', key: 'currentAsk', width: 80, render: (v: any) => (v != null ? toCents(v) : '-') },
            { title: 'Expire(s)', dataIndex: 'secondsToExpire', key: 'secondsToExpire', width: 90, render: (v: any) => (v != null ? <Tag color={Number(v) <= 30 ? 'red' : 'gold'}>{String(v)}</Tag> : '-') },
            { title: 'Result', key: 'result', width: 90, render: (_: any, r: any) => <Tag color={r?.success ? 'green' : r?.skipped ? 'default' : 'red'}>{r?.success ? 'OK' : r?.skipped ? 'SKIP' : 'FAIL'}</Tag> },
            { title: 'Error', dataIndex: 'error', key: 'error', render: (v: any) => (v ? String(v) : '-') },
        ];
    }, []);

    const historyView = useMemo(() => {
        const list = Array.isArray(history) ? history : [];
        if (!showPendingOnly) return list;
        return list.filter((x: any) => String(x?.result || '') === 'OPEN' || x?.redeemable === true || (String(x?.redeemStatus || '') && String(x?.redeemStatus || '').toLowerCase() !== 'confirmed'));
    }, [history, showPendingOnly]);
    const trackedCount = useMemo(() => {
        if (variant === 'all') return status?.trackedCount != null ? Number(status.trackedCount) : null;
        return Array.isArray(status?.tracked) ? status.tracked.length : null;
    }, [variant, status]);
    const cryptoAllTfCountsText = useMemo(() => {
        if (variant !== 'all') return null;
        const counts = new Map<string, number>();
        for (const c of Array.isArray(candidates) ? candidates : []) {
            const tf = String((c as any)?.timeframe || '').toLowerCase();
            if (!tf) continue;
            counts.set(tf, (counts.get(tf) || 0) + 1);
        }
        const order: Array<'5m' | '15m' | '1h' | '4h' | '1d'> = ['5m', '15m', '1h', '4h', '1d'];
        const wanted = order.filter((tf) => allTimeframes.includes(tf));
        if (!wanted.length) return null;
        return wanted.map((tf) => `${tf}:${counts.get(tf) || 0}`).join(' | ');
    }, [variant, candidates, allTimeframes.join(',')]);

    const deltaBoxMap = useMemo(() => {
        const rows = Array.isArray(deltaBoxData?.rows) ? deltaBoxData.rows : [];
        const map = new Map<string, any>();
        for (const r of rows) {
            const sym = String(r?.symbol || '').toUpperCase();
            const tf = String(r?.timeframe || '').toLowerCase();
            if (!sym || !tf) continue;
            map.set(`${sym}:${tf}`, r);
        }
        return map;
    }, [deltaBoxData]);

    const fmtNum = (v: any) => {
        if (v == null) return '-';
        const n = Number(v);
        if (!Number.isFinite(n)) return '-';
        const a = Math.abs(n);
        const d = a >= 100 ? 0 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
        return n.toFixed(d);
    };
    const fmtSec = (v: any) => {
        if (v == null) return '-';
        const n = Number(v);
        if (!Number.isFinite(n)) return '-';
        return String(Math.max(0, Math.round(n)));
    };

    const applyDeltaBoxSelections = () => {
        let applied = 0;
        const getRow = (sym: string, tf: string) => deltaBoxMap.get(`${sym}:${tf}`) || null;
        const pickA = (row: any, n: 10 | 20 | 50) => {
            const k = n === 10 ? 'avg10' : n === 20 ? 'avg20' : 'avg50';
            return row?.a?.[k];
        };
        const pickB = (row: any, n: 10 | 20 | 50, idx: 1 | 2 | 3) => {
            const k = n === 10 ? 'avg10' : n === 20 ? 'avg20' : 'avg50';
            const kk = idx === 1 ? 'last1' : idx === 2 ? 'last2' : 'last3';
            return row?.b?.[k]?.[kk];
        };
        const pickC = (row: any, n: 10 | 20 | 50, idx: 1 | 2 | 3) => {
            const k = n === 10 ? 'avg10' : n === 20 ? 'avg20' : 'avg50';
            const kk = idx === 1 ? 'last1' : idx === 2 ? 'last2' : 'last3';
            return row?.c?.[k]?.[kk];
        };
        const nextAllByTf: any = variant === 'all' ? { ...cryptoAllDeltaByTimeframe } : null;
        for (const sym of ['BTC', 'ETH', 'SOL', 'XRP']) {
            const cfg = deltaBoxApplyBySymbol[sym];
            if (!cfg?.enabled) continue;
            const row = getRow(sym, cfg.timeframe);
            const raw = cfg.mode === 'Manual'
                ? cfg.manualValue
                : (row ? (cfg.mode === 'A' ? pickA(row, cfg.n) : pickC(row, cfg.n, cfg.cIndex)) : null);
            const pct = Math.max(50, Math.min(200, Number(cfg.pct ?? 100)));
            const n = Number(raw) * (pct / 100);
            if (!Number.isFinite(n) || n <= 0) continue;
            if (variant === 'all') {
                const tf = cfg.timeframe;
                const prevRow = nextAllByTf[tf] || {};
                nextAllByTf[tf] = {
                    ...prevRow,
                    btcMinDelta: sym === 'BTC' ? Math.max(0, n) : Number(prevRow.btcMinDelta),
                    ethMinDelta: sym === 'ETH' ? Math.max(0, n) : Number(prevRow.ethMinDelta),
                    solMinDelta: sym === 'SOL' ? Math.max(0, n) : Number(prevRow.solMinDelta),
                    xrpMinDelta: sym === 'XRP' ? Math.max(0, n) : Number(prevRow.xrpMinDelta),
                };
            } else {
                if (sym === 'BTC') setBtcMinDelta(Math.max(0, n));
                if (sym === 'ETH') setEthMinDelta(Math.max(0, n));
                if (sym === 'SOL') setSolMinDelta(Math.max(0, n));
                if (sym === 'XRP') setXrpMinDelta(Math.max(0, n));
            }
            applied += 1;
        }
        if (variant === 'all' && nextAllByTf) setCryptoAllDeltaByTimeframe(nextAllByTf);
        if (deltaBoxExpireApply.enabled) {
            const row = getRow(deltaBoxExpireApply.symbol, deltaBoxExpireApply.timeframe);
            const raw = row ? pickB(row, deltaBoxExpireApply.n, deltaBoxExpireApply.lastIndex) : null;
            const s = Number(raw);
            if (Number.isFinite(s) && s > 0) {
                if (variant === 'all') {
                    const tf = deltaBoxExpireApply.timeframe;
                    setExpiresWithinSecByTimeframe((p) => ({ ...p, [tf]: Math.max(10, Math.min(3600, Math.floor(s))) }));
                } else {
                    setExpiresWithinSec(Math.max(10, Math.min(300, Math.floor(s))));
                }
                applied += 1;
            }
        }
        if (applied) message.success(`Applied ${applied}`);
        else message.warning('No applicable values');
    };

    return (
        <div>
            <Title level={3} style={{ color: '#fff', marginBottom: 16 }}>
                {pageTitle}
            </Title>

            {variant === 'all' ? (
                <Card style={{ marginBottom: 16, background: '#1f1f1f', border: '1px solid #333' }}>
                    <Space wrap>
                        <Tag color="blue">Pick</Tag>
                        <Select
                            allowClear
                            maxTagCount="responsive"
                            style={{ width: 280, maxWidth: '100%' }}
                            placeholder="Timeframe"
                            mode="multiple"
                            value={allTimeframes}
                            onChange={(v) => setAllTimeframes((Array.isArray(v) ? v : []) as any)}
                            options={[
                                { value: '5m', label: '5m' },
                                { value: '15m', label: '15m' },
                                { value: '1h', label: '1h' },
                                { value: '4h', label: '4h' },
                                { value: '1d', label: '1d' },
                            ]}
                        />
                        <Select
                            allowClear
                            maxTagCount="responsive"
                            style={{ width: 280, maxWidth: '100%' }}
                            placeholder="Symbol"
                            mode="multiple"
                            value={allSymbols}
                            onChange={(v) => setAllSymbols((Array.isArray(v) ? v : []) as any)}
                            options={[
                                { value: 'BTC', label: 'BTC' },
                                { value: 'ETH', label: 'ETH' },
                                { value: 'SOL', label: 'SOL' },
                                { value: 'XRP', label: 'XRP' },
                            ]}
                        />
                    </Space>
                </Card>
            ) : null}

            <Card style={{ marginBottom: 16, background: '#1f1f1f', border: '1px solid #333' }}>
                <Alert
                    style={{ marginBottom: 12 }}
                    type="warning"
                    message="請先啟動 Watchdog（只會手動停止），再啟動 Auto Order。"
                    showIcon
                />
                <Space wrap>
                    <span style={{ color: '#ddd' }}>Min Prob</span>
                    <InputNumber
                        min={0.001}
                        max={0.999}
                        step={0.001}
                        precision={3}
                        value={minProb}
                        onChange={(v) => {
                            const n = Number(v);
                            if (!Number.isFinite(n)) return;
                            setMinProb(Math.max(0.001, Math.min(0.999, Math.round(n * 1000) / 1000)));
                        }}
                    />
                    <span style={{ color: '#ddd' }}>Expire ≤ (sec)</span>
                    {variant === 'all' ? (
                        <>
                            <Button size="small" onClick={() => setExpiryBulkOpen(!expiryBulkOpen)} style={{ marginLeft: 4 }}>
                                {expiryBulkOpen ? 'Hide Bulk' : 'Edit Bulk'}
                            </Button>
                            {expiryBulkOpen && (
                                <div style={{ width: '100%', padding: '8px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                        <Tag color="gold" style={{ marginRight: 0 }}>ALL</Tag>
                                        <InputNumber
                                            min={10}
                                            max={3600}
                                            step={5}
                                            style={{ width: 96 }}
                                            value={Math.max(...Object.values(expiresWithinSecByTimeframe || { '5m': 180, '15m': 180, '1h': 180, '4h': 180, '1d': 180 }))}
                                            onChange={(v) => {
                                                const n = Math.max(10, Math.min(3600, Math.floor(Number(v))));
                                                if (!Number.isFinite(n)) return;
                                                setExpiresWithinSecByTimeframe((p) => {
                                                    const next: any = { ...p };
                                                    for (const tf of ['5m', '15m', '1h', '4h', '1d'] as const) next[tf] = n;
                                                    return next;
                                                });
                                            }}
                                        />
                                        <span style={{ color: '#666', fontSize: 12 }}>(Set ALL TFs)</span>
                                    </div>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                                        {(['5m', '15m', '1h', '4h', '1d'] as const).map((tf) => (
                                            <Space key={tf} size={4} direction="vertical" style={{ gap: 0 }}>
                                                <Tag color="geekblue" style={{ marginRight: 0, width: '100%', textAlign: 'center' }}>{String(tf).toUpperCase()}</Tag>
                                                <InputNumber
                                                    min={10}
                                                    max={3600}
                                                    step={5}
                                                    value={expiresWithinSecByTimeframe[tf]}
                                                    style={{ width: 80 }}
                                                    onChange={(v) => setExpiresWithinSecByTimeframe((p) => ({ ...p, [tf]: Math.max(10, Math.min(3600, Math.floor(Number(v)))) }))}
                                                />
                                            </Space>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </>
                    ) : (
                        <InputNumber min={10} max={300} step={5} value={expiresWithinSec} onChange={(v) => setExpiresWithinSec(Number(v))} />
                    )}
                    <span style={{ color: '#ddd' }}>Amount ($)</span>
                    <InputNumber min={1} max={1000} step={1} value={amountUsd} onChange={(v) => setAmountUsd(Math.max(1, Math.floor(Number(v))))} />
                    <span style={{ color: '#ddd' }}>Buy sizing</span>
                    <Select
                        style={{ width: 160 }}
                        value={buySizingMode}
                        onChange={(v) => setBuySizingMode(String(v) === 'orderbook_max' ? 'orderbook_max' : String(v) === 'all_capital' ? 'all_capital' : 'fixed')}
                        options={[
                            { value: 'fixed', label: 'fixed' },
                            { value: 'orderbook_max', label: 'orderbook_max' },
                            { value: 'all_capital', label: 'all_capital' },
                        ]}
                    />
                    <Checkbox checked={sweepEnabled} onChange={(e) => setSweepEnabled(e.target.checked)}>Sweep</Checkbox>
                    <span style={{ color: '#ddd' }}>Window(s)</span>
                    <InputNumber min={0} max={900} step={1} value={sweepWindowSec} onChange={(v) => setSweepWindowSec(Math.max(0, Math.min(900, Math.floor(Number(v)))))} />
                    <span style={{ color: '#ddd' }}>MaxOrders</span>
                    <InputNumber min={1} max={200} step={1} value={sweepMaxOrdersPerMarket} onChange={(v) => setSweepMaxOrdersPerMarket(Math.max(1, Math.min(200, Math.floor(Number(v)))))} />
                    <span style={{ color: '#ddd' }}>MaxTotal($)</span>
                    <InputNumber min={1} max={50000} step={1} value={sweepMaxTotalUsdPerMarket} onChange={(v) => setSweepMaxTotalUsdPerMarket(Math.max(1, Math.min(50000, Math.floor(Number(v)))))} />
                    <span style={{ color: '#ddd' }}>MinInt(ms)</span>
                    <InputNumber min={0} max={30000} step={50} value={sweepMinIntervalMs} onChange={(v) => setSweepMinIntervalMs(Math.max(0, Math.min(30000, Math.floor(Number(v)))))} />
                    <Checkbox checked={trendEnabled} onChange={(e) => setTrendEnabled(e.target.checked)}>Trend</Checkbox>
                    <span style={{ color: '#ddd' }}>Min</span>
                    <InputNumber min={1} max={10} step={1} value={trendMinutes} onChange={(v) => setTrendMinutes(Math.max(1, Math.min(10, Math.floor(Number(v)))))} disabled={!trendEnabled} />
                    <span style={{ color: '#ddd' }}>Stale(ms)</span>
                    <InputNumber min={500} max={60000} step={250} value={staleMsThreshold} onChange={(v) => setStaleMsThreshold(Math.max(500, Math.min(60000, Math.floor(Number(v)))))} />
                    <Checkbox checked={stoplossEnabled} onChange={(e) => setStoplossEnabled(e.target.checked)}>Stoploss</Checkbox>
                    <span style={{ color: '#ddd' }}>Cut1 -c</span>
                    <InputNumber min={0} max={50} step={1} value={stoplossCut1DropCents} onChange={(v) => setStoplossCut1DropCents(Math.max(0, Math.min(50, Math.floor(Number(v)))))} />
                    <span style={{ color: '#ddd' }}>%</span>
                    <InputNumber min={0} max={100} step={1} value={stoplossCut1SellPct} onChange={(v) => setStoplossCut1SellPct(Math.max(0, Math.min(100, Math.floor(Number(v)))))} />
                    <span style={{ color: '#ddd' }}>Cut2 -c</span>
                    <InputNumber min={0} max={50} step={1} value={stoplossCut2DropCents} onChange={(v) => setStoplossCut2DropCents(Math.max(0, Math.min(50, Math.floor(Number(v)))))} />
                    <span style={{ color: '#ddd' }}>%</span>
                    <InputNumber min={0} max={100} step={1} value={stoplossCut2SellPct} onChange={(v) => setStoplossCut2SellPct(Math.max(0, Math.min(100, Math.floor(Number(v)))))} />
                    <span style={{ color: '#ddd' }}>MinExit(s)</span>
                    <InputNumber min={0} max={600} step={1} value={stoplossMinSecToExit} onChange={(v) => setStoplossMinSecToExit(Math.max(0, Math.min(600, Math.floor(Number(v)))))} />
                    <Checkbox checked={adaptiveDeltaEnabled} onChange={(e) => setAdaptiveDeltaEnabled(e.target.checked)}>Adaptive Δ</Checkbox>
                    <span style={{ color: '#ddd' }}>BigMove×</span>
                    <InputNumber min={1} max={10} step={0.5} value={adaptiveDeltaBigMoveMultiplier} onChange={(v) => setAdaptiveDeltaBigMoveMultiplier(Math.max(1, Math.min(10, Number(v))))} />
                    <span style={{ color: '#ddd' }}>Revert N</span>
                    <InputNumber min={1} max={50} step={1} value={adaptiveDeltaRevertNoBuyCount} onChange={(v) => setAdaptiveDeltaRevertNoBuyCount(Math.max(1, Math.min(50, Math.floor(Number(v)))))} />
                    <Button onClick={saveAllSettings} loading={thresholdsSaving}>
                        Confirm
                    </Button>
                    <Button onClick={onStartWatchdog} loading={watchdogStartLoading} disabled={watchdog?.running === true}>
                        {watchdog?.running ? 'Watchdog: ON' : 'Start Watchdog'}
                    </Button>
                    <Tooltip title={watchdog?.running !== true ? '請先啟動 Watchdog' : status?.enabled ? 'Auto 已啟動' : String(status?.lastError || '').startsWith('books_stale:') ? '目前 books_stale 超過門檻；可能影響候選/落單。請等快照更新或調高門檻。' : undefined}>
                        <Button type="primary" icon={<PlayCircleOutlined />} onClick={onStart} loading={startLoading} disabled={!!status?.enabled || watchdog?.running !== true}>
                            Start Auto Trade
                        </Button>
                    </Tooltip>
                    <Button icon={<PauseCircleOutlined />} onClick={onStop} loading={stopLoading} disabled={!status?.enabled}>
                        Stop
                    </Button>
                    <Button danger onClick={onStopWatchdog} loading={watchdogStopLoading} disabled={watchdog?.running !== true && !status?.enabled}>
                        Stop Watchdog
                    </Button>
                    <Button
                        icon={<ReloadOutlined />}
                        onClick={async () => {
                            setRefreshLoading(true);
                            try {
                                await refreshAll();
                            } finally {
                                setRefreshLoading(false);
                            }
                        }}
                        loading={refreshLoading}
                    >
                        Refresh
                    </Button>
                    <Button onClick={() => setAutoRefresh((v) => !v)} type={autoRefresh ? 'primary' : 'default'}>
                        {autoRefresh ? 'Auto Refresh: ON' : 'Auto Refresh: OFF'}
                    </Button>
                    <span style={{ color: '#ddd' }}>Update (ms)</span>
                    <InputNumber
                        min={500}
                        max={5000}
                        step={250}
                        value={pollMs}
                        onFocus={() => setEditing(true)}
                        onBlur={() => setEditing(false)}
                        onChange={(v) => setPollMs(Math.max(500, Math.floor(Number(v))))}
                    />
                    <Button onClick={() => setShowPendingOnly((v) => !v)} type={showPendingOnly ? 'primary' : 'default'}>
                        {showPendingOnly ? 'History: Pending' : 'History: All'}
                    </Button>
                    <Select
                        value={historyStrategy}
                        style={{ width: 180 }}
                        onChange={(v) => setHistoryStrategy(v)}
                        options={[
                            { label: 'History: Crypto15m', value: 'crypto15m' },
                            { label: 'History: CryptoAll', value: 'cryptoall' },
                            { label: 'History: All', value: 'all' },
                        ]}
                    />
                    <Button onClick={onOpenStoploss}>
                        Stoploss
                    </Button>
                    <Button onClick={onOpenAnalysis} disabled={variant === 'all'}>
                        Book分析
                    </Button>
                    <Button
                        icon={<SafetyCertificateOutlined />}
                        onClick={async () => {
                            setHealthLoading(true);
                            try {
                                await fetchHealth();
                            } finally {
                                setHealthLoading(false);
                            }
                        }}
                        loading={healthLoading}
                    >
                        Health Check
                    </Button>
                    <Button danger icon={<DeleteOutlined />} onClick={onResetActive} loading={resetLoading}>
                        Reset Active
                    </Button>
                </Space>
            {status?.lastError ? (
                <Alert style={{ marginTop: 12 }} type="error" message={String(status.lastError)} description={String(status.lastError || '').startsWith('books_stale:') ? 'CLOB orderbook 快照過舊：代表後端無法抓到 clob.polymarket.com/books。Outcomes 會顯示 0.0c/no-asks 並且 Auto 會安全停單。' : undefined} showIcon />
            ) : null}
                <Alert
                    style={{ marginTop: 12 }}
                    type="info"
                    message={`WS: ${wsConnected ? 'ON' : 'OFF'} • WS Last: ${wsLastAt || '-'} • Key: ${status?.hasValidKey ? 'OK' : 'MISSING'} • Watchdog: ${watchdog?.running ? 'ON' : 'OFF'} • Auto: ${status?.enabled ? 'ON' : 'OFF'} • LastScanAt: ${status?.lastScanAt || '-'} • Tracked: ${trackedCount != null ? trackedCount : '-'} • Candidates: ${candidatesMeta?.eligible ?? '-'} eligible / ${candidatesMeta?.count ?? '-'} total`}
                    showIcon
                />
                {variant === 'all' && cryptoAllTfCountsText ? (
                    <Alert
                        style={{ marginTop: 12 }}
                        type="info"
                        message={`TF: ${cryptoAllTfCountsText}`}
                        showIcon
                    />
                ) : null}
                {wsError ? <Alert style={{ marginTop: 12 }} type="error" message={wsError} showIcon /> : null}
                {status?.actives ? (
                    <Alert
                        style={{ marginTop: 12 }}
                        type="info"
                        message={`Active: ${Object.keys(status.actives).length ? Object.keys(status.actives).map((k) => `${k}:${toCents(status.actives[k]?.price)} ${status.actives[k]?.outcome || ''}`).join(' | ') : 'none'}`}
                        showIcon
                    />
                ) : null}
                {status?.adaptiveDelta && deltaBoxViewMode === 'single' ? (
                    <Alert
                        style={{ marginTop: 12 }}
                        type="info"
                        message={(() => {
                            const tfKey = String(deltaBoxQuickTf || '15m').toLowerCase();
                            const ad: any = status?.adaptiveDelta || null;
                            const byTf = ad && typeof ad === 'object' ? ad[tfKey] : null;
                            const hasByTf = byTf && typeof byTf === 'object' && ['BTC', 'ETH', 'SOL', 'XRP'].some((k) => (byTf as any)[k] != null);
                            const hasLegacy = ad && typeof ad === 'object' && ['BTC', 'ETH', 'SOL', 'XRP'].some((k) => (ad as any)[k] != null);
                            const get = (sym: string) => {
                                if (hasByTf) return (byTf as any)[sym] || {};
                                if (hasLegacy) return (ad as any)[sym] || {};
                                return {};
                            };
                            const parts = ['BTC', 'ETH', 'SOL', 'XRP'].map((sym) => {
                                const s = get(sym);
                                const base = s?.baseMinDelta != null ? Number(s.baseMinDelta) : null;
                                const ov = s?.overrideMinDelta != null ? Number(s.overrideMinDelta) : null;
                                const rem = s?.remainingToRevert != null ? String(s.remainingToRevert) : '-';
                                if (base == null) return `${sym}:-`;
                                return ov != null ? `${sym}:${fmtNum(base)}→${fmtNum(ov)} (remain ${rem})` : `${sym}:${fmtNum(base)}`;
                            }).join(' | ');
                            return hasByTf ? `Adaptive Δ (${tfKey}): ${parts}` : `Adaptive Δ: ${parts}`;
                        })()}
                        showIcon
                    />
                ) : null}
                {health?.relayer || health?.autoRedeem ? (
                    <Alert
                        style={{ marginTop: 12 }}
                        type="warning"
                        message={`Relayer: ${health?.relayer?.activeApiKey || '-'} • AutoRedeem: ${health?.autoRedeem?.config?.enabled ? 'ON' : 'OFF'} • InFlight: ${health?.autoRedeem?.inFlight?.count ?? '-'} • Last: ${health?.autoRedeem?.last?.at || '-'} • LastError: ${health?.autoRedeem?.lastError || '-'}`}
                        showIcon
                    />
                ) : null}
            </Card>

            <Collapse
                style={{ marginBottom: 16, background: '#1f1f1f', borderColor: '#333' }}
                defaultActiveKey={['1']}
                items={[{
                    key: '1',
                    label: <Space><span style={{ color: '#fff', fontWeight: 600 }}>Delta Box Analysis</span><Tag color="purple">New</Tag></Space>,
                    children: (
                        <div>
                            <div style={{ marginBottom: 16, padding: '8px 12px', background: '#141414', borderRadius: 6, border: '1px solid #333' }}>
                                <Space wrap>
                                    <Text strong style={{ color: '#888' }}>Current Saved Thresholds:</Text>
                                    {variant === 'all' ? (
                                        (['5m', '15m', '1h', '4h', '1d'] as const).map((tf) => {
                                            const legacy = (savedDeltaThresholds?.legacy && typeof savedDeltaThresholds.legacy === 'object') ? savedDeltaThresholds.legacy : savedDeltaThresholds;
                                            const r = (savedDeltaThresholds?.byTimeframe && typeof savedDeltaThresholds.byTimeframe === 'object')
                                                ? ((savedDeltaThresholds.byTimeframe as any)[tf] || legacy || {})
                                                : (legacy || {});
                                            return (
                                                <span key={tf} style={{ marginRight: 12, fontSize: 12, color: '#ccc' }}>
                                                    <Tag style={{ marginRight: 4 }} color="geekblue">{String(tf).toUpperCase()}</Tag>
                                                    BTC:{r.btcMinDelta ?? '-'} ETH:{r.ethMinDelta ?? '-'} SOL:{r.solMinDelta ?? '-'} XRP:{r.xrpMinDelta ?? '-'}
                                                </span>
                                            );
                                        })
                                    ) : (
                                        <span style={{ color: '#ccc', fontSize: 13 }}>
                                            <span style={{ marginRight: 12 }}>BTC: <span style={{ color: '#fff', fontWeight: 600 }}>{savedDeltaThresholds?.btcMinDelta ?? '-'}</span></span>
                                            <span style={{ marginRight: 12 }}>ETH: <span style={{ color: '#fff', fontWeight: 600 }}>{savedDeltaThresholds?.ethMinDelta ?? '-'}</span></span>
                                            <span style={{ marginRight: 12 }}>SOL: <span style={{ color: '#fff', fontWeight: 600 }}>{savedDeltaThresholds?.solMinDelta ?? '-'}</span></span>
                                            <span style={{ marginRight: 12 }}>XRP: <span style={{ color: '#fff', fontWeight: 600 }}>{savedDeltaThresholds?.xrpMinDelta ?? '-'}</span></span>
                                        </span>
                                    )}
                                    <span style={{ color: '#666', fontSize: 12 }}>
                                        updatedAt: {savedDeltaThresholds?.updatedAt || '-'} • loadedAt: {savedDeltaThresholds?.loadedAt || '-'}
                                    </span>
                                    <Button
                                        size="small"
                                        onClick={() => {
                                            setAllSettingsOpen(true);
                                            Promise.allSettled([fetchStatus(), fetchThresholds(), fetchCryptoAllThresholdsForModal()]).catch(() => {});
                                        }}
                                    >
                                        View All
                                    </Button>
                                </Space>
                                <div style={{ marginTop: 6 }}>
                                    <Space wrap>
                                        <Text strong style={{ color: '#888' }}>Expiry（Saved→Draft）:</Text>
                                        {variant === 'all' ? (
                                            (['5m', '15m', '1h', '4h', '1d'] as const).map((tf) => {
                                                const savedByTf = (status?.config?.expiresWithinSecByTimeframe && typeof status?.config?.expiresWithinSecByTimeframe === 'object') ? status.config.expiresWithinSecByTimeframe : null;
                                                const saved = savedByTf && (savedByTf as any)[tf] != null ? Number((savedByTf as any)[tf]) : (status?.config?.expiresWithinSec != null ? Number(status.config.expiresWithinSec) : null);
                                                const draft = (expiresWithinSecByTimeframe as any)?.[tf] != null ? Number((expiresWithinSecByTimeframe as any)[tf]) : expiresWithinSec;
                                                return (
                                                    <span key={tf} style={{ marginRight: 12, fontSize: 12, color: '#ccc' }}>
                                                        <Tag style={{ marginRight: 4 }} color="geekblue">{String(tf).toUpperCase()}</Tag>
                                                        {saved != null && Number.isFinite(saved) ? String(saved) : '-'} → {Number.isFinite(draft) ? String(draft) : '-'} sec
                                                    </span>
                                                );
                                            })
                                        ) : (
                                            <span style={{ color: '#ccc', fontSize: 13 }}>
                                                {status?.config?.expiresWithinSec != null ? String(status.config.expiresWithinSec) : '-'} → {String(expiresWithinSec)} sec
                                            </span>
                                        )}
                                    </Space>
                                </div>
                            </div>
                            {deltaBoxViewMode === 'single' ? (
                            <div style={{ marginBottom: 16, padding: 12, background: '#262626', borderRadius: 8 }}>
                                <div style={{ marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <Text strong style={{ color: '#ddd' }}>Delta Box（A/B/C 即時）</Text>
                                    <Space wrap>
                                        <span style={{ color: '#888', fontSize: 12 }}>Timeframe</span>
                                        <Select
                                            size="small"
                                            value={deltaBoxQuickTf}
                                            style={{ width: 90 }}
                                            onChange={(v) => setDeltaBoxQuickTf(v)}
                                            options={[
                                                { value: '5m', label: '5m' },
                                                { value: '15m', label: '15m' },
                                                { value: '1h', label: '1h' },
                                                { value: '4h', label: '4h' },
                                                { value: '1d', label: '1d' },
                                            ]}
                                        />
                                        <Button icon={<ReloadOutlined />} onClick={() => fetchDeltaBox().catch(() => {})} loading={deltaBoxLoading} size="small">
                                            Refresh
                                        </Button>
                                    </Space>
                                </div>
                                <Table
                                    size="small"
                                    pagination={false}
                                    rowKey="symbol"
                                    dataSource={(['BTC', 'ETH', 'SOL', 'XRP'] as const).map((s) => ({ symbol: s }))}
                                    columns={[
                                        {
                                            title: 'Symbol',
                                            dataIndex: 'symbol',
                                            width: 90,
                                            render: (v: any) => <Tag color="blue" style={{ marginRight: 0 }}>{String(v)}</Tag>,
                                        },
                                        {
                                            title: 'Stats',
                                            render: (_: any, row: any) => {
                                                const sym = String(row?.symbol || '').toUpperCase();
                                                const r = deltaBoxMap.get(`${sym}:${String(deltaBoxQuickTf).toLowerCase()}`) || null;
                                                if (!r) return <div style={{ color: '#666', fontSize: 12 }}>- No Data -</div>;

                                                const renderRow = (label: string, v1: any, v2: any, v3: any, isTime = false) => (
                                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 2 }}>
                                                        <span style={{ color: '#888', width: 40 }}>{label}</span>
                                                        <span style={{ color: '#ddd' }}>{isTime ? fmtSec(v1) : fmtNum(v1)}</span>
                                                        <span style={{ color: '#888' }}>|</span>
                                                        <span style={{ color: '#ddd' }}>{isTime ? fmtSec(v2) : fmtNum(v2)}</span>
                                                        <span style={{ color: '#888' }}>|</span>
                                                        <span style={{ color: '#ddd' }}>{isTime ? fmtSec(v3) : fmtNum(v3)}</span>
                                                    </div>
                                                );

                                                return (
                                                    <div style={{ padding: 4 }}>
                                                        <div style={{ background: 'rgba(59,130,246,0.1)', padding: '2px 6px', borderRadius: 4, marginBottom: 8 }}>
                                                            <div style={{ fontSize: 11, color: '#3b82f6', fontWeight: 600, marginBottom: 2 }}>A: Avg Δ（Open→Close）</div>
                                                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                                                                <span style={{ color: '#aaa' }}>10/20/50:</span>
                                                                <span style={{ color: '#fff', fontWeight: 600 }}>{fmtNum(r?.a?.avg10)} / {fmtNum(r?.a?.avg20)} / {fmtNum(r?.a?.avg50)}</span>
                                                            </div>
                                                            <div style={{ fontSize: 10, color: '#666', textAlign: 'right' }}>samples: {r?.counts?.a ?? 0}</div>
                                                        </div>

                                                        <div style={{ background: 'rgba(168,85,247,0.1)', padding: '2px 6px', borderRadius: 4 }}>
                                                            <div style={{ fontSize: 11, color: '#a855f7', fontWeight: 600, marginBottom: 4 }}>B/C: 0.980–0.999 Events</div>

                                                            <div style={{ fontSize: 10, color: '#aaa', borderBottom: '1px solid #444', marginBottom: 2, paddingBottom: 2 }}>
                                                                B: Seconds Remaining（Avg 10/20/50）
                                                            </div>
                                                            {renderRow('Last1', r?.b?.avg10?.last1, r?.b?.avg20?.last1, r?.b?.avg50?.last1, true)}
                                                            {renderRow('Last2', r?.b?.avg10?.last2, r?.b?.avg20?.last2, r?.b?.avg50?.last2, true)}
                                                            {renderRow('Last3', r?.b?.avg10?.last3, r?.b?.avg20?.last3, r?.b?.avg50?.last3, true)}

                                                            <div style={{ fontSize: 10, color: '#aaa', borderBottom: '1px solid #444', marginTop: 6, marginBottom: 2, paddingBottom: 2 }}>
                                                                C: Delta @ Moment（Avg 10/20/50）
                                                            </div>
                                                            {renderRow('Last1', r?.c?.avg10?.last1, r?.c?.avg20?.last1, r?.c?.avg50?.last1)}
                                                            {renderRow('Last2', r?.c?.avg10?.last2, r?.c?.avg20?.last2, r?.c?.avg50?.last2)}
                                                            {renderRow('Last3', r?.c?.avg10?.last3, r?.c?.avg20?.last3, r?.c?.avg50?.last3)}

                                                            <div style={{ fontSize: 10, color: '#666', textAlign: 'right', marginTop: 4 }}>
                                                                samples: {r?.counts?.bc ?? 0}
                                                            </div>
                                                        </div>
                                                    </div>
                                                );
                                            }
                                        },
                                    ]}
                                />
                                {variant === 'all' ? (
                                    <div style={{ marginTop: 12 }}>
                                        <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                            <Text strong style={{ color: '#ddd' }}>Adaptive Δ（按時區）</Text>
                                            <span style={{ color: '#666', fontSize: 12 }}>enabled: {status?.config?.adaptiveDeltaEnabled ? 'ON' : 'OFF'}</span>
                                        </div>
                                        <Table
                                            size="small"
                                            pagination={false}
                                            rowKey="sym"
                                            dataSource={(['BTC', 'ETH', 'SOL', 'XRP'] as const).map((sym) => {
                                                const tf = String(deltaBoxQuickTf).toLowerCase();
                                                const a = status?.adaptiveDelta?.[tf]?.[sym] || null;
                                                return {
                                                    sym,
                                                    base: a?.baseMinDelta,
                                                    override: a?.overrideMinDelta,
                                                    effective: a?.effectiveMinDelta,
                                                    remain: a?.remainingToRevert,
                                                };
                                            })}
                                            columns={[
                                                { title: 'Sym', dataIndex: 'sym', width: 70, render: (v: any) => <Tag>{String(v)}</Tag> },
                                                { title: 'base', dataIndex: 'base', width: 140, render: (v: any) => <Tag>{fmtNum(v)}</Tag> },
                                                { title: 'override', dataIndex: 'override', width: 140, render: (v: any) => <Tag>{fmtNum(v)}</Tag> },
                                                { title: 'effective', dataIndex: 'effective', width: 140, render: (v: any) => <Tag>{fmtNum(v)}</Tag> },
                                                { title: 'remain', dataIndex: 'remain', width: 100, render: (v: any) => <Tag>{v == null ? '-' : String(v)}</Tag> },
                                            ]}
                                        />
                                    </div>
                                ) : null}
                            </div>
                            ) : null}
                            <div style={{ marginBottom: 16, padding: 12, background: '#262626', borderRadius: 8 }}>
                                <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <Text strong style={{ color: '#ddd' }}>Auto-Apply Settings (Tick to enable)</Text>
                                    <Space>
                                        <span style={{ color: '#888', fontSize: 12 }}>View</span>
                                        <Select
                                            size="small"
                                            value={deltaBoxViewMode}
                                            style={{ width: 120 }}
                                            onChange={(v) => setDeltaBoxViewMode(v)}
                                            options={[
                                                { value: 'single', label: 'Single TF' },
                                                { value: 'grid', label: 'Grid All TF' },
                                            ]}
                                        />
                                        <Button icon={<ReloadOutlined />} onClick={() => fetchDeltaBox().catch(() => {})} loading={deltaBoxLoading} size="small">
                                            Refresh Stats
                                        </Button>
                                        <Button type="primary" onClick={applyDeltaBoxSelections} disabled={!deltaBoxData} size="small">
                                            Apply Selected to Settings
                                        </Button>
                                    </Space>
                                </div>
                                <Space direction="vertical" style={{ width: '100%' }} size={8}>
                                    <Space wrap style={{ padding: '0 8px', width: '100%' }} size={8}>
                                        <span style={{ width: 60 }} />
                                        <span style={{ color: '#888', fontSize: 12, width: 80 }}>TF</span>
                                        <span style={{ color: '#888', fontSize: 12, width: 140 }}>Source</span>
                                        <span style={{ color: '#888', fontSize: 12, width: 90 }}>Last N</span>
                                        <span style={{ color: '#888', fontSize: 12, width: 90 }}>%</span>
                                        <span style={{ color: '#888', fontSize: 12, width: 100 }}>Sample</span>
                                        <span style={{ color: '#888', fontSize: 12, width: 120 }}>Manual</span>
                                    </Space>
                                    {(['BTC', 'ETH', 'SOL', 'XRP'] as const).map((sym) => {
                                        const cfg = deltaBoxApplyBySymbol[sym] || { enabled: false, timeframe: '15m', mode: 'A', n: 20, cIndex: 1, pct: 100, manualValue: 0 };
                                        const update = (patch: any) => setDeltaBoxApplyBySymbol((prev) => ({ ...prev, [sym]: { ...prev[sym], ...patch } }));
                                        return (
                                            <Space key={sym} wrap style={{ padding: '4px 8px', borderBottom: '1px solid #333', width: '100%' }}>
                                                <Checkbox checked={cfg.enabled} onChange={(e) => update({ enabled: e.target.checked })} style={{ width: 60 }}>{sym}</Checkbox>
                                                <Select
                                                    size="small"
                                                    value={cfg.timeframe}
                                                    style={{ width: 80 }}
                                                    onChange={(v) => update({ timeframe: v })}
                                                    options={[{ value: '5m', label: '5m' }, { value: '15m', label: '15m' }, { value: '1h', label: '1h' }, { value: '4h', label: '4h' }, { value: '1d', label: '1d' }]}
                                                />
                                                <Select
                                                    size="small"
                                                    value={cfg.mode}
                                                    style={{ width: 140 }}
                                                    onChange={(v) => update({ mode: v })}
                                                    options={[{ value: 'A', label: 'Mean Δ (A)' }, { value: 'C', label: 'Trigger Δ (C)' }, { value: 'Manual', label: 'Manual' }]}
                                                />
                                                <Select
                                                    size="small"
                                                    value={cfg.n}
                                                    style={{ width: 90 }}
                                                    onChange={(v) => update({ n: v })}
                                                    options={[{ value: 10, label: 'Last 10' }, { value: 20, label: 'Last 20' }, { value: 50, label: 'Last 50' }]}
                                                    disabled={cfg.mode === 'Manual'}
                                                />
                                                <InputNumber
                                                    size="small"
                                                    min={50}
                                                    max={200}
                                                    step={5}
                                                    value={cfg.pct}
                                                    onChange={(v) => update({ pct: Math.max(50, Math.min(200, Math.floor(Number(v)))) })}
                                                    style={{ width: 90 }}
                                                />
                                                {cfg.mode === 'C' && (
                                                    <Select
                                                        size="small"
                                                        value={cfg.cIndex}
                                                        style={{ width: 100 }}
                                                        onChange={(v) => update({ cIndex: v })}
                                                        options={[{ value: 1, label: 'Recent 1' }, { value: 2, label: 'Recent 2' }, { value: 3, label: 'Recent 3' }]}
                                                    />
                                                )}
                                                {cfg.mode !== 'C' ? <span style={{ width: 100 }} /> : null}
                                                {cfg.mode === 'Manual' && (
                                                    <InputNumber
                                                        size="small"
                                                        min={0}
                                                        step={sym === 'XRP' ? 0.0001 : sym === 'SOL' ? 0.1 : 1}
                                                        value={cfg.manualValue}
                                                        onChange={(v) => update({ manualValue: Math.max(0, Number(v)) })}
                                                        style={{ width: 120 }}
                                                    />
                                                )}
                                                {cfg.mode !== 'Manual' ? <span style={{ width: 120 }} /> : null}
                                            </Space>
                                        );
                                    })}
                                    <Space wrap style={{ padding: '4px 8px', width: '100%' }}>
                                        <Checkbox checked={deltaBoxExpireApply.enabled} onChange={(e) => setDeltaBoxExpireApply((p) => ({ ...p, enabled: e.target.checked }))} style={{ width: 100 }}>
                                            Expiry
                                        </Checkbox>
                                        <span style={{ color: '#888', fontSize: 12 }}>Apply Sec from:</span>
                                        <Select
                                            size="small"
                                            value={deltaBoxExpireApply.symbol}
                                            style={{ width: 80 }}
                                            onChange={(v) => setDeltaBoxExpireApply((p) => ({ ...p, symbol: v }))}
                                            options={[{ value: 'BTC', label: 'BTC' }, { value: 'ETH', label: 'ETH' }, { value: 'SOL', label: 'SOL' }, { value: 'XRP', label: 'XRP' }]}
                                        />
                                        <Select
                                            size="small"
                                            value={deltaBoxExpireApply.timeframe}
                                            style={{ width: 80 }}
                                            onChange={(v) => setDeltaBoxExpireApply((p) => ({ ...p, timeframe: v }))}
                                            options={[{ value: '5m', label: '5m' }, { value: '15m', label: '15m' }, { value: '1h', label: '1h' }, { value: '4h', label: '4h' }, { value: '1d', label: '1d' }]}
                                        />
                                        <span style={{ color: '#888', fontSize: 12 }}>Last N:</span>
                                        <Select
                                            size="small"
                                            value={deltaBoxExpireApply.n}
                                            style={{ width: 90 }}
                                            onChange={(v) => setDeltaBoxExpireApply((p) => ({ ...p, n: v }))}
                                            options={[{ value: 10, label: 'Last 10' }, { value: 20, label: 'Last 20' }, { value: 50, label: 'Last 50' }]}
                                        />
                                        <span style={{ color: '#888', fontSize: 12 }}>Sample:</span>
                                        <Select
                                            size="small"
                                            value={deltaBoxExpireApply.lastIndex}
                                            style={{ width: 100 }}
                                            onChange={(v) => setDeltaBoxExpireApply((p) => ({ ...p, lastIndex: v }))}
                                            options={[{ value: 1, label: 'Recent 1' }, { value: 2, label: 'Recent 2' }, { value: 3, label: 'Recent 3' }]}
                                        />
                                    </Space>
                                </Space>
                            </div>

                            {deltaBoxViewMode === 'grid' ? (
                                <>
                                    {variant === 'all' ? (
                                        <div style={{ marginBottom: 12 }}>
                                            <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                <Text strong style={{ color: '#ddd' }}>Adaptive Δ（全 TF）</Text>
                                                <span style={{ color: '#666', fontSize: 12 }}>enabled: {status?.config?.adaptiveDeltaEnabled ? 'ON' : 'OFF'}</span>
                                            </div>
                                            <Table
                                                size="small"
                                                pagination={false}
                                                rowKey="sym"
                                                bordered
                                                dataSource={(['BTC', 'ETH', 'SOL', 'XRP'] as const).map((sym) => ({ sym }))}
                                                columns={[
                                                    { title: 'Sym', dataIndex: 'sym', width: 80, fixed: 'left' as any, render: (v: any) => <Tag color="blue">{String(v)}</Tag> },
                                                    ...(allTimeframes.length ? allTimeframes : (['5m', '15m', '1h', '4h', '1d'] as any)).map((tf: any) => ({
                                                        title: String(tf).toUpperCase(),
                                                        dataIndex: String(tf),
                                                        width: 210,
                                                        render: (_: any, row: any) => {
                                                            const sym = String(row?.sym || '').toUpperCase();
                                                            const ad: any = status?.adaptiveDelta || null;
                                                            const tfKey = String(tf).toLowerCase();
                                                            const byTf = ad && typeof ad === 'object' ? ad[tfKey] : null;
                                                            const a = byTf && typeof byTf === 'object' && (byTf as any)[sym] != null ? (byTf as any)[sym] : (ad && typeof ad === 'object' ? (ad as any)[sym] : null);
                                                            const base = a?.baseMinDelta != null ? Number(a.baseMinDelta) : null;
                                                            const ov = a?.overrideMinDelta != null ? Number(a.overrideMinDelta) : null;
                                                            const rem = a?.remainingToRevert != null ? String(a.remainingToRevert) : '-';
                                                            if (base == null) return <Tag>-</Tag>;
                                                            return <Tag>{ov != null ? `${fmtNum(base)}→${fmtNum(ov)} (remain ${rem})` : `${fmtNum(base)}`}</Tag>;
                                                        }
                                                    })),
                                                ]}
                                                scroll={{ x: 1200 }}
                                            />
                                        </div>
                                    ) : null}
                                    <Table
                                        style={{ marginTop: 0 }}
                                        size="small"
                                        pagination={false}
                                        dataSource={(variant === 'all' ? (allSymbols.length ? allSymbols : (['BTC', 'ETH', 'SOL', 'XRP'] as any)) : (['BTC', 'ETH', 'SOL', 'XRP'] as any)).map((s: any) => ({ symbol: s }))}
                                        rowKey="symbol"
                                        bordered
                                        columns={[
                                            {
                                                title: 'Symbol',
                                                dataIndex: 'symbol',
                                                width: 80,
                                                fixed: 'left' as any,
                                                render: (v: any) => <div style={{ fontWeight: 'bold', textAlign: 'center' }}><Tag color="blue" style={{ marginRight: 0 }}>{String(v)}</Tag></div>
                                            },
                                            ...(variant === 'all' ? (allTimeframes.length ? allTimeframes : (['5m', '15m', '1h', '4h', '1d'] as any)) : (['5m', '15m', '1h', '4h', '1d'] as any)).map((tf: any) => ({
                                                title: String(tf).toUpperCase(),
                                                dataIndex: String(tf),
                                                width: 280,
                                                render: (_: any, row: any) => {
                                                    const sym = String(row?.symbol || '').toUpperCase();
                                                    const r = deltaBoxMap.get(`${sym}:${String(tf).toLowerCase()}`) || null;
                                                    if (!r) return <div style={{ color: '#666', fontSize: 12, textAlign: 'center' }}>- No Data -</div>;
                                                    
                                                    const a10 = r?.a?.avg10;
                                                    const a20 = r?.a?.avg20;
                                                    const a50 = r?.a?.avg50;
                                                    
                                                    const renderRow = (label: string, v1: any, v2: any, v3: any, isTime = false) => (
                                                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 2 }}>
                                                            <span style={{ color: '#888', width: 40 }}>{label}</span>
                                                            <span style={{ color: '#ddd' }}>{isTime ? fmtSec(v1) : fmtNum(v1)}</span>
                                                            <span style={{ color: '#888' }}>|</span>
                                                            <span style={{ color: '#ddd' }}>{isTime ? fmtSec(v2) : fmtNum(v2)}</span>
                                                            <span style={{ color: '#888' }}>|</span>
                                                            <span style={{ color: '#ddd' }}>{isTime ? fmtSec(v3) : fmtNum(v3)}</span>
                                                        </div>
                                                    );

                                                    return (
                                                        <div style={{ padding: 4 }}>
                                                            <div style={{ background: 'rgba(59,130,246,0.1)', padding: '2px 6px', borderRadius: 4, marginBottom: 6 }}>
                                                                <div style={{ fontSize: 11, color: '#3b82f6', fontWeight: 600, marginBottom: 2 }}>Type A: Avg Δ (Open→Close)</div>
                                                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                                                                    <span style={{ color: '#aaa' }}>10/20/50:</span>
                                                                    <span style={{ color: '#fff', fontWeight: 600 }}>{fmtNum(a10)} / {fmtNum(a20)} / {fmtNum(a50)}</span>
                                                                </div>
                                                                <div style={{ fontSize: 10, color: '#666', textAlign: 'right' }}>samples: {r?.counts?.a ?? 0}</div>
                                                            </div>

                                                            <div style={{ background: 'rgba(168,85,247,0.1)', padding: '2px 6px', borderRadius: 4 }}>
                                                                <div style={{ fontSize: 11, color: '#a855f7', fontWeight: 600, marginBottom: 4 }}>Type B/C: 0.980-0.999 Events</div>
                                                                
                                                                <div style={{ fontSize: 10, color: '#aaa', borderBottom: '1px solid #444', marginBottom: 2, paddingBottom: 2 }}>
                                                                    B: Seconds Remaining (Avg 10/20/50)
                                                                </div>
                                                                {renderRow('Last1', r?.b?.avg10?.last1, r?.b?.avg20?.last1, r?.b?.avg50?.last1, true)}
                                                                {renderRow('Last2', r?.b?.avg10?.last2, r?.b?.avg20?.last2, r?.b?.avg50?.last2, true)}
                                                                {renderRow('Last3', r?.b?.avg10?.last3, r?.b?.avg20?.last3, r?.b?.avg50?.last3, true)}

                                                                <div style={{ fontSize: 10, color: '#aaa', borderBottom: '1px solid #444', marginTop: 4, marginBottom: 2, paddingBottom: 2 }}>
                                                                    C: Delta @ Moment (Avg 10/20/50)
                                                                </div>
                                                                {renderRow('Last1', r?.c?.avg10?.last1, r?.c?.avg20?.last1, r?.c?.avg50?.last1)}
                                                                {renderRow('Last2', r?.c?.avg10?.last2, r?.c?.avg20?.last2, r?.c?.avg50?.last2)}
                                                                {renderRow('Last3', r?.c?.avg10?.last3, r?.c?.avg20?.last3, r?.c?.avg50?.last3)}
                                                                
                                                                <div style={{ fontSize: 10, color: '#666', textAlign: 'right', marginTop: 2 }}>samples: {r?.counts?.bc ?? 0}</div>
                                                            </div>
                                                        </div>
                                                    );
                                                }
                                            })),
                                        ]}
                                        scroll={{ x: 1600 }}
                                    />
                                </>
                            ) : null}
                        </div>
                    ),
                }]}
            />

            {variant !== 'all' || (allSymbols.length && allTimeframes.length) ? (
                <Card style={{ background: '#1f1f1f', border: '1px solid #333' }}>
                    <Table
                        className="compact-antd-table"
                        rowKey={(r) => {
                            const cid = String((r as any)?.conditionId || '');
                            const tf = String((r as any)?.timeframe || '');
                            return cid ? `${tf}:${cid}` : `${tf}:${String((r as any)?.slug || '')}:${String((r as any)?.symbol || '')}`;
                        }}
                        loading={false}
                        dataSource={candidates}
                        columns={columns as any}
                        pagination={false}
                        size="small"
                        tableLayout="fixed"
                        virtual
                        scroll={{ x: 1200, y: 420 }}
                    />
                </Card>
            ) : null}

            <Card style={{ marginTop: 16, background: '#1f1f1f', border: '1px solid #333' }}>
                <Title level={5} style={{ color: '#fff', marginBottom: 12 }}>Recent History</Title>
                <Collapse
                    ghost
                    style={{ marginBottom: 12 }}
                    activeKey={historyPanels}
                    onChange={(k) => setHistoryPanels(Array.isArray(k) ? (k as any) : (k ? [String(k)] : []))}
                    destroyInactivePanel
                    items={[
                        {
                            key: 'logs',
                            label: '15M Logs (JSON)',
                            children: (
                                <div>
                                    <Space wrap>
                                        <Button size="small" onClick={() => copyText(logsJson)}>Copy JSON</Button>
                                        <Tag>latest 50</Tag>
                                    </Space>
                                    <pre style={{ marginTop: 8, maxHeight: 360, overflow: 'auto', background: '#0f0f0f', color: '#ddd', padding: 10, border: '1px solid #333' }}>{logsJson}</pre>
                                </div>
                            ),
                        },
                        ...(configEvents.length ? [{
                            key: 'config',
                            label: `Config Records (${configEvents.length})`,
                            children: (
                                <Table
                                    className="compact-antd-table"
                                    rowKey={(r) => String((r as any).id)}
                                    loading={false}
                                    dataSource={configEvents.slice(0, 20)}
                                    columns={configColumns as any}
                                    pagination={false}
                                    size="small"
                                />
                            ),
                        }] : []),
                    ]}
                />
                {historySummary ? (
                    <Alert
                        style={{ marginBottom: 12 }}
                        type="info"
                        message={`Bets: ${historySummary.count ?? '-'} • Stake: $${Number(historySummary.totalStakeUsd ?? 0).toFixed(0)} • PnL: ${Number(historySummary.pnlTotalUsdc ?? 0).toFixed(4)} • W/L/O: ${historySummary.winCount ?? 0}/${historySummary.lossCount ?? 0}/${historySummary.openCount ?? 0} • 1h Filled: ${historySummary.filledOrders1h ?? 0}/${historySummary.totalOrders1h ?? 0} ($${Number(historySummary.filledUsd1h ?? 0).toFixed(0)}) • Redeemable: ${historySummary.redeemableCount ?? 0} • ✅: ${historySummary.redeemedCount ?? 0}`}
                        showIcon
                    />
                ) : null}
                <Table
                    className="compact-antd-table"
                    rowKey={(r) => String(r.id)}
                    loading={false}
                    dataSource={historyView}
                    columns={historyColumns as any}
                    pagination={false}
                    size="small"
                    tableLayout="fixed"
                    virtual
                    scroll={{ x: 1600, y: 520 }}
                />
            </Card>

            <Modal
                open={stoplossOpen}
                onCancel={() => setStoplossOpen(false)}
                footer={null}
                width={1100}
                title={
                    <Space wrap>
                        <Button onClick={async () => {
                            setStoplossLoading(true);
                            try {
                                await fetchStoplossHistory();
                            } finally {
                                setStoplossLoading(false);
                            }
                        }} loading={stoplossLoading}>
                            Refresh
                        </Button>
                        <Tag>OK: {stoplossSummary?.successCount ?? 0}</Tag>
                        <Tag>Skip: {stoplossSummary?.skippedCount ?? 0}</Tag>
                        <Tag>Fail: {stoplossSummary?.failedCount ?? 0}</Tag>
                    </Space>
                }
            >
                <Table
                    rowKey={(r) => String((r as any)?.id ?? `${String((r as any)?.timestamp ?? '')}:${String((r as any)?.symbol ?? '')}:${String((r as any)?.reason ?? '')}:${String((r as any)?.marketId ?? (r as any)?.conditionId ?? '')}`)}
                    loading={stoplossLoading}
                    dataSource={stoplossHistory}
                    columns={stoplossColumns as any}
                    pagination={false}
                    size="small"
                    virtual
                    scroll={{ y: 520 }}
                />
            </Modal>

            <Modal
                open={analysisOpen}
                onCancel={() => setAnalysisOpen(false)}
                footer={null}
                width={1200}
                title={
                    <Space wrap>
                        <Button onClick={async () => fetchTradeAnalysis({ tradeId: analysisTradeId })} loading={analysisLoading}>
                            Refresh
                        </Button>
                        <Tag>Trades: {analysisData?.trades?.length ?? 0}</Tag>
                        <Tag>BUY/SELL: {analysisData?.buySell?.buyCount ?? 0}/{analysisData?.buySell?.sellCount ?? 0}</Tag>
                        <Tag color="blue">0.980 peak: {analysisData?.peaks?.best980 ? `${analysisData.peaks.best980.offsetSec}s (${analysisData.peaks.best980.count})` : '-'}</Tag>
                        <Tag color="purple">0.999 peak: {analysisData?.peaks?.best999 ? `${analysisData.peaks.best999.offsetSec}s (${analysisData.peaks.best999.count})` : '-'}</Tag>
                        <Select
                            style={{ width: 260 }}
                            value={analysisTradeId != null ? String(analysisTradeId) : undefined}
                            onChange={async (v) => {
                                const id = Number(v);
                                setAnalysisTradeId(id);
                                await fetchTradeAnalysis({ tradeId: id });
                            }}
                            options={(Array.isArray(analysisData?.trades) ? analysisData.trades : []).map((t: any) => ({
                                label: `${String(t?.symbol || '')} • ${String(t?.outcome || '')} • $${Number(t?.amountUsd || 0).toFixed(0)} • fill ${(t?.fillPct != null ? `${Math.floor(Number(t.fillPct) * 100)}%` : '-')}`,
                                value: String(t?.id),
                            }))}
                        />
                    </Space>
                }
            >
                <Space direction="vertical" style={{ width: '100%' }} size={12}>
                    <Card size="small" title="0.980 / 0.999 每秒分佈（相對買入時刻 -59..0 秒）">
                        <div ref={analysisAggChartElRef} style={{ height: 220, width: '100%', marginBottom: 10 }} />
                        <Table
                            className="compact-antd-table"
                            rowKey={(r: any) => String(r.offsetSec)}
                            loading={analysisLoading}
                            dataSource={Array.isArray(analysisData?.timeline) ? analysisData.timeline : []}
                            pagination={false}
                            size="small"
                            virtual
                            scroll={{ y: 420 }}
                            columns={[
                                { title: 't(s)', dataIndex: 'offsetSec', key: 'offsetSec', width: 80, render: (v: any) => <Tag>{String(v)}</Tag> },
                                { title: '0.980x', dataIndex: 'count980', key: 'count980', width: 90, render: (v: any) => <Tag color={Number(v) > 0 ? 'blue' : 'default'}>{Number(v) || 0}</Tag> },
                                { title: '0.980 depth', dataIndex: 'usd980', key: 'usd980', width: 120, render: (v: any) => <Tag>{Number(v || 0).toFixed(4)}</Tag> },
                                { title: '0.999x', dataIndex: 'count999', key: 'count999', width: 90, render: (v: any) => <Tag color={Number(v) > 0 ? 'purple' : 'default'}>{Number(v) || 0}</Tag> },
                                { title: '0.999 depth', dataIndex: 'usd999', key: 'usd999', width: 120, render: (v: any) => <Tag>{Number(v || 0).toFixed(4)}</Tag> },
                            ]}
                        />
                    </Card>

                    <Card size="small" title="選中 Trade：最後60秒 Book（綠線=BestAsk Price, 紫柱=0.999 Depth USD）">
                        {analysisData?.tradeDetail ? (
                            <>
                                <Space wrap style={{ marginBottom: 10 }}>
                                    <Tag>{String(analysisData.tradeDetail.symbol || '-')}</Tag>
                                    <Tag>{String(analysisData.tradeDetail.outcome || '-')}</Tag>
                                    <Tag>bestAsk: {analysisData.tradeDetail.bestAsk != null ? Number(analysisData.tradeDetail.bestAsk).toFixed(4) : '-'}</Tag>
                                    <Tag>limit: {analysisData.tradeDetail.limitPrice != null ? Number(analysisData.tradeDetail.limitPrice).toFixed(4) : '-'}</Tag>
                                    <Tag>capDepth: {analysisData.tradeDetail.depthUsdAtCap != null ? Number(analysisData.tradeDetail.depthUsdAtCap).toFixed(4) : '-'}</Tag>
                                    <Tag>preOrders: {analysisData.tradeDetail.preOpenOrdersCount ?? '-'}</Tag>
                                    <Tag>preUsd: {analysisData.tradeDetail.preOpenOrdersRemainingUsd != null ? Number(analysisData.tradeDetail.preOpenOrdersRemainingUsd).toFixed(4) : '-'}</Tag>
                                </Space>
                                <div ref={analysisTradeChartElRef} style={{ height: 220, width: '100%', marginBottom: 10 }} />
                                <Table
                                    className="compact-antd-table"
                                    rowKey={(r: any) => String(r.sec)}
                                    loading={analysisLoading}
                                    dataSource={Array.isArray(analysisData.tradeDetail.book60s) ? analysisData.tradeDetail.book60s : []}
                                    pagination={false}
                                    size="small"
                                    virtual
                                    scroll={{ y: 420 }}
                                    columns={[
                                        { title: 'sec', dataIndex: 'sec', key: 'sec', width: 110, render: (v: any) => <Tag>{String(v)}</Tag> },
                                        { title: 'bestAsk', dataIndex: 'bestAsk', key: 'bestAsk', width: 110, render: (v: any) => <Tag>{v != null ? Number(v).toFixed(4) : '-'}</Tag> },
                                        { title: 'bestBid', dataIndex: 'bestBid', key: 'bestBid', width: 110, render: (v: any) => <Tag>{v != null ? Number(v).toFixed(4) : '-'}</Tag> },
                                        { title: 'topAskUsd', dataIndex: 'topAskUsd', key: 'topAskUsd', width: 120, render: (v: any) => <Tag>{v != null ? Number(v).toFixed(4) : '-'}</Tag> },
                                        { title: 'Depth($).980', dataIndex: 'depthUsd980', key: 'depthUsd980', width: 120, render: (v: any) => <Tag>{v != null ? Number(v).toFixed(4) : '-'}</Tag> },
                                        { title: 'Depth($).999', dataIndex: 'depthUsd999', key: 'depthUsd999', width: 120, render: (v: any) => <Tag>{v != null ? Number(v).toFixed(4) : '-'}</Tag> },
                                        { title: 'asks', dataIndex: 'asksCount', key: 'asksCount', width: 80, render: (v: any) => <Tag>{Number(v) || 0}</Tag> },
                                        { title: 'bids', dataIndex: 'bidsCount', key: 'bidsCount', width: 80, render: (v: any) => <Tag>{Number(v) || 0}</Tag> },
                                    ]}
                                />
                            </>
                        ) : (
                            <Alert type="info" message="未有 tradeDetail（請先揀 Trade 或 Refresh）" showIcon />
                        )}
                    </Card>
                </Space>
            </Modal>

            <Modal
                open={allSettingsOpen}
                onCancel={() => setAllSettingsOpen(false)}
                footer={null}
                width={1100}
                title={
                    <Space wrap>
                        <Text strong>All Settings Snapshot</Text>
                        <Button
                            icon={<ReloadOutlined />}
                            onClick={() => Promise.allSettled([fetchStatus(), fetchThresholds(), fetchCryptoAllThresholdsForModal()]).catch(() => {})}
                            loading={savedCryptoAllThresholdsLoading}
                        >
                            Refresh
                        </Button>
                        <Button
                            onClick={() => {
                                const out: any = { now: new Date().toISOString(), variant };
                                if (variant === 'all') {
                                    out.savedCryptoAllThresholds = savedCryptoAllThresholds;
                                    out.draftCryptoAllThresholds = { cryptoAllDeltaByTimeframe };
                                    out.savedConfig = {
                                        expiresWithinSec: status?.config?.expiresWithinSec,
                                        expiresWithinSecByTimeframe: (status?.config as any)?.expiresWithinSecByTimeframe,
                                        adaptiveDeltaEnabled: (status?.config as any)?.adaptiveDeltaEnabled,
                                        adaptiveDeltaBigMoveMultiplier: (status?.config as any)?.adaptiveDeltaBigMoveMultiplier,
                                        adaptiveDeltaRevertNoBuyCount: (status?.config as any)?.adaptiveDeltaRevertNoBuyCount,
                                    };
                                    out.draftConfig = {
                                        expiresWithinSec,
                                        expiresWithinSecByTimeframe,
                                        adaptiveDeltaEnabled,
                                        adaptiveDeltaBigMoveMultiplier,
                                        adaptiveDeltaRevertNoBuyCount,
                                    };
                                    out.adaptiveDelta = status?.adaptiveDelta || null;
                                } else {
                                    out.savedDeltaThresholds = savedDeltaThresholds;
                                    out.draftDeltaThresholds = { btcMinDelta, ethMinDelta, solMinDelta, xrpMinDelta };
                                    out.savedConfig = { expiresWithinSec: status?.config?.expiresWithinSec };
                                    out.draftConfig = { expiresWithinSec };
                                }
                                copyText(JSON.stringify(out, null, 2));
                            }}
                        >
                            Copy JSON
                        </Button>
                    </Space>
                }
            >
                <Space direction="vertical" style={{ width: '100%' }} size={12}>
                    <Card size="small" title="Expiry (Saved vs Draft)">
                        {variant === 'all' ? (
                            <Table
                                size="small"
                                pagination={false}
                                rowKey={(r: any) => String(r.tf)}
                                dataSource={(['5m', '15m', '1h', '4h', '1d'] as const).map((tf) => {
                                    const savedByTf = ((status?.config as any)?.expiresWithinSecByTimeframe && typeof (status?.config as any)?.expiresWithinSecByTimeframe === 'object') ? (status?.config as any).expiresWithinSecByTimeframe : null;
                                    const saved = savedByTf && savedByTf[tf] != null ? Number(savedByTf[tf]) : ((status?.config as any)?.expiresWithinSec != null ? Number((status?.config as any).expiresWithinSec) : null);
                                    const draft = (expiresWithinSecByTimeframe as any)?.[tf] != null ? Number((expiresWithinSecByTimeframe as any)[tf]) : expiresWithinSec;
                                    return { tf, saved, draft };
                                })}
                                columns={[
                                    { title: 'TF', dataIndex: 'tf', width: 80, render: (v: any) => <Tag color="geekblue">{String(v).toUpperCase()}</Tag> },
                                    { title: 'Saved', dataIndex: 'saved', width: 120, render: (v: any) => <Tag>{v != null && Number.isFinite(Number(v)) ? String(Math.floor(Number(v))) : '-'}</Tag> },
                                    { title: 'Draft', dataIndex: 'draft', width: 120, render: (v: any) => <Tag>{v != null && Number.isFinite(Number(v)) ? String(Math.floor(Number(v))) : '-'}</Tag> },
                                ]}
                            />
                        ) : (
                            <Space wrap>
                                <Tag color="geekblue">Saved</Tag>
                                <span style={{ color: '#ddd' }}>Expire ≤ (sec):</span>
                                <Tag>{status?.config?.expiresWithinSec != null ? String(status.config.expiresWithinSec) : '-'}</Tag>
                                <Tag color="gold">Draft</Tag>
                                <span style={{ color: '#ddd' }}>Expire ≤ (sec):</span>
                                <Tag>{String(expiresWithinSec)}</Tag>
                            </Space>
                        )}
                    </Card>

                    {variant === 'all' ? (
                        <Card size="small" title="Adaptive Δ (Saved)">
                            <Table
                                size="small"
                                pagination={false}
                                rowKey={(r: any) => String(r.tf)}
                                dataSource={(['5m', '15m', '1h', '4h', '1d'] as const).map((tf) => {
                                    const row: any = { tf };
                                    for (const sym of ['BTC', 'ETH', 'SOL', 'XRP'] as const) {
                                        const ad: any = status?.adaptiveDelta || null;
                                        const byTf = ad && typeof ad === 'object' ? ad[String(tf).toLowerCase()] : null;
                                        row[sym] = byTf && typeof byTf === 'object' ? byTf[sym] : null;
                                    }
                                    return row;
                                })}
                                columns={[
                                    { title: 'TF', dataIndex: 'tf', width: 80, render: (v: any) => <Tag color="geekblue">{String(v).toUpperCase()}</Tag> },
                                    ...(['BTC', 'ETH', 'SOL', 'XRP'] as const).map((sym) => ({
                                        title: sym,
                                        dataIndex: sym,
                                        width: 220,
                                        render: (a: any) => {
                                            const base = a?.baseMinDelta != null ? Number(a.baseMinDelta) : null;
                                            const ov = a?.overrideMinDelta != null ? Number(a.overrideMinDelta) : null;
                                            const rem = a?.remainingToRevert != null ? String(a.remainingToRevert) : '-';
                                            if (base == null) return <Tag>-</Tag>;
                                            return <Tag>{ov != null ? `${fmtNum(base)}→${fmtNum(ov)} (remain ${rem})` : `${fmtNum(base)}`}</Tag>;
                                        }
                                    })),
                                ]}
                            />
                            <div style={{ marginTop: 8, color: '#aaa', fontSize: 12 }}>
                                multiplier×: {adaptiveDeltaBigMoveMultiplier} • revertN: {adaptiveDeltaRevertNoBuyCount} • enabled: {adaptiveDeltaEnabled ? 'ON' : 'OFF'}
                            </div>
                        </Card>
                    ) : null}

                    <Card size="small" title="Thresholds (Saved vs Draft)">
                        <div style={{ marginBottom: 10, color: '#aaa', fontSize: 12 }}>
                            Saved = 後端 existing record；Draft = 你而家畫面數值（Apply 後、Confirm 前/後都可對照）。
                        </div>
                        {variant === 'all' ? (
                            <>
                                <Table
                                    size="small"
                                    pagination={false}
                                    rowKey={(r: any) => String(r.tf)}
                                    loading={savedCryptoAllThresholdsLoading}
                                    dataSource={(['5m', '15m', '1h', '4h', '1d'] as const).map((tf) => {
                                        const legacy = (savedCryptoAllThresholds?.legacy && typeof savedCryptoAllThresholds.legacy === 'object') ? savedCryptoAllThresholds.legacy : savedCryptoAllThresholds;
                                        const sRow = (savedCryptoAllThresholds?.byTimeframe && typeof savedCryptoAllThresholds.byTimeframe === 'object')
                                            ? ((savedCryptoAllThresholds.byTimeframe as any)[tf] || legacy || {})
                                            : (legacy || {});
                                        const dRow = (cryptoAllDeltaByTimeframe as any)[tf] || {};
                                        return {
                                            tf,
                                            sbtc: sRow.btcMinDelta,
                                            seth: sRow.ethMinDelta,
                                            ssol: sRow.solMinDelta,
                                            sxrp: sRow.xrpMinDelta,
                                            dbtc: dRow.btcMinDelta,
                                            deth: dRow.ethMinDelta,
                                            dsol: dRow.solMinDelta,
                                            dxrp: dRow.xrpMinDelta,
                                        };
                                    })}
                                    columns={[
                                        { title: 'TF', dataIndex: 'tf', width: 70, render: (v: any) => <Tag color="geekblue">{String(v).toUpperCase()}</Tag> },
                                        { title: 'BTC (saved→draft)', render: (_: any, r: any) => `${r.sbtc ?? '-'} → ${r.dbtc ?? '-'}` },
                                        { title: 'ETH (saved→draft)', render: (_: any, r: any) => `${r.seth ?? '-'} → ${r.deth ?? '-'}` },
                                        { title: 'SOL (saved→draft)', render: (_: any, r: any) => `${r.ssol ?? '-'} → ${r.dsol ?? '-'}` },
                                        { title: 'XRP (saved→draft)', render: (_: any, r: any) => `${r.sxrp ?? '-'} → ${r.dxrp ?? '-'}` },
                                    ]}
                                />
                                <div style={{ marginTop: 8, color: '#666', fontSize: 12 }}>
                                    cryptoall updatedAt: {savedCryptoAllThresholds?.updatedAt || '-'} • loadedAt: {savedCryptoAllThresholds?.loadedAt || '-'}
                                </div>
                            </>
                        ) : (
                            <Table
                                size="small"
                                pagination={false}
                                rowKey={(r: any) => String(r.scope)}
                                dataSource={[
                                    {
                                        scope: 'crypto15m',
                                        tf: '-',
                                        saved: savedDeltaThresholds ? {
                                            btc: savedDeltaThresholds.btcMinDelta,
                                            eth: savedDeltaThresholds.ethMinDelta,
                                            sol: savedDeltaThresholds.solMinDelta,
                                            xrp: savedDeltaThresholds.xrpMinDelta,
                                            updatedAt: savedDeltaThresholds.updatedAt,
                                            loadedAt: savedDeltaThresholds.loadedAt,
                                        } : null,
                                        draft: { btc: btcMinDelta, eth: ethMinDelta, sol: solMinDelta, xrp: xrpMinDelta },
                                    },
                                ].filter((r) => r.saved || r.draft)}
                                columns={[
                                    { title: 'Scope', dataIndex: 'scope', width: 110, render: (v: any) => <Tag>{String(v)}</Tag> },
                                    { title: 'TF', dataIndex: 'tf', width: 70, render: (v: any) => <Tag color="geekblue">{String(v)}</Tag> },
                                    { title: 'BTC (saved→draft)', render: (_: any, row: any) => row.saved ? `${row.saved.btc ?? '-'} → ${row.draft?.btc ?? '-'}` : '-' },
                                    { title: 'ETH (saved→draft)', render: (_: any, row: any) => row.saved ? `${row.saved.eth ?? '-'} → ${row.draft?.eth ?? '-'}` : '-' },
                                    { title: 'SOL (saved→draft)', render: (_: any, row: any) => row.saved ? `${row.saved.sol ?? '-'} → ${row.draft?.sol ?? '-'}` : '-' },
                                    { title: 'XRP (saved→draft)', render: (_: any, row: any) => row.saved ? `${row.saved.xrp ?? '-'} → ${row.draft?.xrp ?? '-'}` : '-' },
                                    { title: 'updatedAt/loadedAt', width: 260, render: (_: any, row: any) => row.saved ? `${row.saved.updatedAt || '-'} / ${row.saved.loadedAt || '-'}` : '-' },
                                ]}
                            />
                        )}
                    </Card>

                    {variant === 'all' ? (
                        <Card size="small" title="Adaptive Δ (Backend Status - All Timeframes)">
                             <Table
                                size="small"
                                pagination={false}
                                rowKey="sym"
                                bordered
                                dataSource={(['BTC', 'ETH', 'SOL', 'XRP'] as const).map((sym) => ({ sym }))}
                                columns={[
                                    { title: 'Sym', dataIndex: 'sym', width: 80, fixed: 'left' as any, render: (v: any) => <Tag color="blue">{String(v)}</Tag> },
                                    ...(['5m', '15m', '1h', '4h', '1d'] as const).map((tf) => ({
                                        title: String(tf).toUpperCase(),
                                        dataIndex: String(tf),
                                        width: 200,
                                        render: (_: any, row: any) => {
                                            const sym = String(row?.sym || '').toUpperCase();
                                            const ad: any = status?.adaptiveDelta || null;
                                            const tfKey = String(tf).toLowerCase();
                                            const byTf = ad && typeof ad === 'object' ? ad[tfKey] : null;
                                            const a = byTf && typeof byTf === 'object' && (byTf as any)[sym] != null ? (byTf as any)[sym] : null;
                                            const base = a?.baseMinDelta != null ? Number(a.baseMinDelta) : null;
                                            const ov = a?.overrideMinDelta != null ? Number(a.overrideMinDelta) : null;
                                            const rem = a?.remainingToRevert != null ? String(a.remainingToRevert) : '-';
                                            if (base == null) return <Tag>-</Tag>;
                                            return <Tag>{ov != null ? `${fmtNum(base)}→${fmtNum(ov)} (remain ${rem})` : `${fmtNum(base)}`}</Tag>;
                                        }
                                    })),
                                ]}
                                scroll={{ x: 1000 }}
                            />
                        </Card>
                    ) : null}
                </Space>
            </Modal>
        </div>
    );
}

export default Crypto15m;
