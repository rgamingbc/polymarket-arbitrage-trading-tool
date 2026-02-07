import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, InputNumber, Select, Table, Tag, Typography, Space, Alert, Tooltip, Checkbox, Modal, message } from 'antd';
import { PlayCircleOutlined, PauseCircleOutlined, ReloadOutlined, ShoppingCartOutlined, SafetyCertificateOutlined, DeleteOutlined } from '@ant-design/icons';
import axios from 'axios';

const { Title } = Typography;

const api = axios.create({
    baseURL: '/api',
    timeout: 120000,
});

function Crypto15m() {
    const [candidates, setCandidates] = useState<any[]>([]);
    const [candidatesMeta, setCandidatesMeta] = useState<{ count: number; eligible: number } | null>(null);
    const [status, setStatus] = useState<any>(null);
    const [watchdog, setWatchdog] = useState<any>(null);
    const [health, setHealth] = useState<any>(null);
    const [history, setHistory] = useState<any[]>([]);
    const [configEvents, setConfigEvents] = useState<any[]>([]);
    const [historyStrategy, setHistoryStrategy] = useState<'crypto15m' | 'cryptoall' | 'all'>('crypto15m');
    const [autoRefresh, setAutoRefresh] = useState(true);
    const [showPendingOnly, setShowPendingOnly] = useState(false);
    const [editing, setEditing] = useState(false);
    const [pollMs, setPollMs] = useState<number>(1000);
    const [minProb, setMinProb] = useState<number>(0.9);
    const [expiresWithinSec, setExpiresWithinSec] = useState<number>(180);
    const [amountUsd, setAmountUsd] = useState<number>(1);
    const [buySizingMode, setBuySizingMode] = useState<'fixed' | 'orderbook_max' | 'all_capital'>('fixed');
    const [trendEnabled, setTrendEnabled] = useState<boolean>(true);
    const [trendMinutes, setTrendMinutes] = useState<number>(1);
    const [staleMsThreshold, setStaleMsThreshold] = useState<number>(5000);
    const [btcMinDelta, setBtcMinDelta] = useState<number>(600);
    const [ethMinDelta, setEthMinDelta] = useState<number>(30);
    const [solMinDelta, setSolMinDelta] = useState<number>(0.8);
    const [xrpMinDelta, setXrpMinDelta] = useState<number>(0.0065);
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
    const timerRef = useRef<any>(null);
    const timerHistoryRef = useRef<any>(null);
    const wsRef = useRef<WebSocket | null>(null);
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

    const CountdownTag = ({ endDate, fallbackSeconds }: { endDate?: string; fallbackSeconds?: number }) => {
        const compute = () => {
            const ms = endDate ? Date.parse(String(endDate)) : NaN;
            if (Number.isFinite(ms)) return Math.max(0, Math.floor((ms - Date.now()) / 1000));
            const fb = fallbackSeconds != null ? Number(fallbackSeconds) : NaN;
            return Number.isFinite(fb) ? Math.max(0, Math.floor(fb)) : 0;
        };
        const [sec, setSec] = useState<number>(compute());
        useEffect(() => {
            setSec(compute());
            const t = setInterval(() => setSec(compute()), 1000);
            return () => clearInterval(t);
        }, [endDate, fallbackSeconds]);
        return <Tag color={sec <= 30 ? 'red' : 'gold'}>{String(sec)}</Tag>;
    };

    useEffect(() => {
        try {
            const raw = localStorage.getItem('crypto15m_settings_v1');
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (parsed?.minProb != null) setMinProb(Number(parsed.minProb));
            if (parsed?.expiresWithinSec != null) setExpiresWithinSec(Number(parsed.expiresWithinSec));
            if (parsed?.amountUsd != null) setAmountUsd(Number(parsed.amountUsd));
            if (parsed?.buySizingMode != null) {
                const m = String(parsed.buySizingMode);
                setBuySizingMode(m === 'orderbook_max' ? 'orderbook_max' : m === 'all_capital' ? 'all_capital' : 'fixed');
            }
            if (parsed?.trendEnabled != null) setTrendEnabled(!!parsed.trendEnabled);
            if (parsed?.trendMinutes != null) setTrendMinutes(Number(parsed.trendMinutes));
            if (parsed?.staleMsThreshold != null) setStaleMsThreshold(Number(parsed.staleMsThreshold));
            if (parsed?.pollMs != null) setPollMs(Number(parsed.pollMs));
            if (parsed?.btcMinDelta != null) setBtcMinDelta(Number(parsed.btcMinDelta));
            if (parsed?.ethMinDelta != null) setEthMinDelta(Number(parsed.ethMinDelta));
            if (parsed?.solMinDelta != null) setSolMinDelta(Number(parsed.solMinDelta));
            if (parsed?.xrpMinDelta != null) setXrpMinDelta(Number(parsed.xrpMinDelta));
            if (parsed?.stoplossEnabled != null) setStoplossEnabled(!!parsed.stoplossEnabled);
            if (parsed?.stoplossCut1DropCents != null) setStoplossCut1DropCents(Number(parsed.stoplossCut1DropCents));
            if (parsed?.stoplossCut1SellPct != null) setStoplossCut1SellPct(Number(parsed.stoplossCut1SellPct));
            if (parsed?.stoplossCut2DropCents != null) setStoplossCut2DropCents(Number(parsed.stoplossCut2DropCents));
            if (parsed?.stoplossCut2SellPct != null) setStoplossCut2SellPct(Number(parsed.stoplossCut2SellPct));
            if (parsed?.stoplossMinSecToExit != null) setStoplossMinSecToExit(Number(parsed.stoplossMinSecToExit));
            if (parsed?.adaptiveDeltaEnabled != null) setAdaptiveDeltaEnabled(!!parsed.adaptiveDeltaEnabled);
            if (parsed?.adaptiveDeltaBigMoveMultiplier != null) setAdaptiveDeltaBigMoveMultiplier(Number(parsed.adaptiveDeltaBigMoveMultiplier));
            if (parsed?.adaptiveDeltaRevertNoBuyCount != null) setAdaptiveDeltaRevertNoBuyCount(Number(parsed.adaptiveDeltaRevertNoBuyCount));
        } catch {
        } finally {
            setSettingsHydrated(true);
        }
    }, []);

    useEffect(() => {
        if (!settingsHydrated) return;
        try {
            localStorage.setItem('crypto15m_settings_v1', JSON.stringify({
                minProb,
                expiresWithinSec,
                amountUsd,
                buySizingMode,
                trendEnabled,
                trendMinutes,
                staleMsThreshold,
                pollMs,
                btcMinDelta,
                ethMinDelta,
                solMinDelta,
                xrpMinDelta,
                stoplossEnabled,
                stoplossCut1DropCents,
                stoplossCut1SellPct,
                stoplossCut2DropCents,
                stoplossCut2SellPct,
                stoplossMinSecToExit,
                adaptiveDeltaEnabled,
                adaptiveDeltaBigMoveMultiplier,
                adaptiveDeltaRevertNoBuyCount,
            }));
        } catch {
        }
    }, [settingsHydrated, minProb, expiresWithinSec, amountUsd, buySizingMode, trendEnabled, trendMinutes, staleMsThreshold, pollMs, btcMinDelta, ethMinDelta, solMinDelta, xrpMinDelta, stoplossEnabled, stoplossCut1DropCents, stoplossCut1SellPct, stoplossCut2DropCents, stoplossCut2SellPct, stoplossMinSecToExit, adaptiveDeltaEnabled, adaptiveDeltaBigMoveMultiplier, adaptiveDeltaRevertNoBuyCount]);

    const fetchStatus = async () => {
        const res = await api.get('/group-arb/crypto15m/status');
        setStatus(res.data?.status);
    };

    const fetchCandidates = async () => {
        const res = await api.get('/group-arb/crypto15m/candidates', { params: { minProb, expiresWithinSec, limit: 20 } });
        const list = Array.isArray(res.data?.candidates) ? res.data.candidates : [];
        const sorted = list
            .slice()
            .sort((a: any, b: any) => {
                const aOk = a?.meetsMinProb === true && a?.eligibleByExpiry === true;
                const bOk = b?.meetsMinProb === true && b?.eligibleByExpiry === true;
                if (aOk !== bOk) return aOk ? -1 : 1;
                const ap = Number(a?.chosenPrice);
                const bp = Number(b?.chosenPrice);
                if (Number.isFinite(ap) && Number.isFinite(bp) && ap !== bp) return bp - ap;
                const as = Number(a?.secondsToExpire);
                const bs = Number(b?.secondsToExpire);
                if (Number.isFinite(as) && Number.isFinite(bs) && as !== bs) return as - bs;
                return String(a?.symbol || '').localeCompare(String(b?.symbol || ''));
            });
        setCandidates(sorted);
        setCandidatesMeta({
            count: Number(res.data?.count ?? sorted.length),
            eligible: Number(res.data?.countEligible ?? sorted.filter((c: any) => c?.meetsMinProb === true && c?.eligibleByExpiry === true).length),
        });
    };

    const fetchHistory = async () => {
        if (historyStrategy === 'crypto15m') {
            const res = await api.get('/group-arb/crypto15m/history', { params: { refresh: true, intervalMs: 1000, maxEntries: 50 } });
            const h = Array.isArray(res.data?.history) ? res.data.history : [];
            setHistory(h.map((x: any) => ({ ...x, strategy: 'crypto15m' })));
            setHistorySummary(res.data?.summary || null);
            setConfigEvents(Array.isArray(res.data?.configEvents) ? res.data.configEvents : []);
            return;
        }
        if (historyStrategy === 'cryptoall') {
            const res = await api.get('/group-arb/cryptoall/history', { params: { refresh: true, intervalMs: 1000, maxEntries: 50 } });
            const h = Array.isArray(res.data?.history) ? res.data.history : [];
            setHistory(h.map((x: any) => ({ ...x, strategy: 'cryptoall' })));
            setHistorySummary(res.data?.summary || null);
            setConfigEvents([]);
            return;
        }
        const [r15, rAll] = await Promise.all([
            api.get('/group-arb/crypto15m/history', { params: { refresh: true, intervalMs: 1000, maxEntries: 50 } }),
            api.get('/group-arb/cryptoall/history', { params: { refresh: true, intervalMs: 1000, maxEntries: 50 } }),
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
        };
        setHistory(merged);
        setHistorySummary(sum);
        setConfigEvents(Array.isArray(r15.data?.configEvents) ? r15.data.configEvents : []);
    };

    const fetchStoplossHistory = async () => {
        const res = await api.get('/group-arb/crypto15m/stoploss/history', { params: { maxEntries: 120 } });
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

    const fetchHealth = async () => {
        const [r1, r2] = await Promise.all([
            api.get('/group-arb/relayer/status'),
            api.get('/group-arb/auto-redeem/status'),
        ]);
        setHealth({
            relayer: r1.data?.status,
            autoRedeem: r2.data?.status,
        });
    };

    const fetchWatchdog = async () => {
        const r = await api.get('/group-arb/crypto15m/watchdog/status');
        setWatchdog(r.data?.status);
    };

    const fetchThresholds = async () => {
        setThresholdsLoading(true);
        try {
            const r = await api.get('/group-arb/crypto15m/delta-thresholds');
            const t = r.data?.thresholds || {};
            if (t?.btcMinDelta != null) setBtcMinDelta(Number(t.btcMinDelta));
            if (t?.ethMinDelta != null) setEthMinDelta(Number(t.ethMinDelta));
            if (t?.solMinDelta != null) setSolMinDelta(Number(t.solMinDelta));
            if (t?.xrpMinDelta != null) setXrpMinDelta(Number(t.xrpMinDelta));
        } finally {
            setThresholdsLoading(false);
        }
    };

    const saveAllSettings = async () => {
        setThresholdsSaving(true);
        try {
            await Promise.all([
                api.post('/group-arb/crypto15m/delta-thresholds', { btcMinDelta, ethMinDelta, solMinDelta, xrpMinDelta }),
                api.post('/group-arb/crypto15m/config', {
                    amountUsd,
                    buySizingMode,
                    minProb,
                    expiresWithinSec,
                    pollMs,
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
        await Promise.all([fetchStatus(), fetchCandidates(), fetchHistory(), fetchWatchdog()]);
    };

    useEffect(() => {
        fetchThresholds().catch(() => {});
    }, []);

    useEffect(() => {
        refreshAll();
    }, []);

    useEffect(() => {
        if (timerRef.current) clearInterval(timerRef.current);
        if (wsConnected) return;
        const urgent = candidates.some((c: any) => c?.meetsMinProb === true && c?.eligibleByExpiry === true);
        const effectivePollMs = urgent ? Math.min(1000, Math.max(500, Math.floor(pollMs))) : Math.max(500, Math.floor(pollMs));
        timerRef.current = setInterval(() => {
            if (!autoRefresh) return;
            if (editing) return;
            Promise.all([fetchStatus(), fetchCandidates(), fetchWatchdog()]).catch(() => {});
        }, effectivePollMs);
        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [autoRefresh, editing, minProb, expiresWithinSec, pollMs, candidates.length, wsConnected]);

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
    }, [autoRefresh, editing, historyStrategy]);

    useEffect(() => {
        fetchHistory().catch(() => {});
    }, [historyStrategy]);

    useEffect(() => {
        if (!autoRefresh) {
            if (wsReconnectTimerRef.current) clearTimeout(wsReconnectTimerRef.current);
            if (wsRef.current) {
                wsRef.current.close();
                wsRef.current = null;
            }
            setWsConnected(false);
            return;
        }
        const connect = () => {
            if (wsReconnectTimerRef.current) clearTimeout(wsReconnectTimerRef.current);
            if (wsRef.current) {
                try { wsRef.current.close(); } catch {}
                wsRef.current = null;
            }
            const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
            const wsUrl = `${protocol}://${window.location.host}/api/group-arb/crypto15m/ws?minProb=${encodeURIComponent(String(minProb))}&expiresWithinSec=${encodeURIComponent(String(expiresWithinSec))}&limit=20`;
            const ws = new WebSocket(wsUrl);
            wsRef.current = ws;
            setWsError(null);
            ws.onopen = () => {
                wsRetryRef.current = 0;
                setWsConnected(true);
            };
            ws.onclose = () => {
                setWsConnected(false);
                if (!autoRefresh) return;
                const retry = Math.min(8, wsRetryRef.current + 1);
                wsRetryRef.current = retry;
                const delayMs = Math.min(10_000, 300 * Math.pow(2, retry));
                wsReconnectTimerRef.current = setTimeout(connect, delayMs);
            };
            ws.onerror = () => {
                setWsError('ws error');
                setWsConnected(false);
                try { ws.close(); } catch {}
            };
            ws.onmessage = (evt) => {
                try {
                    const msg = JSON.parse(String(evt.data || '{}'));
                    if (msg?.type === 'snapshot') {
                        if (msg?.status) setStatus(msg.status);
                        if (msg?.candidates) {
                            const payload = msg.candidates;
                            const list = Array.isArray(payload?.candidates) ? payload.candidates : [];
                            setCandidates(list);
                            setCandidatesMeta({
                                count: Number(payload?.count ?? list.length),
                                eligible: Number(payload?.countEligible ?? 0),
                            });
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
            if (wsReconnectTimerRef.current) clearTimeout(wsReconnectTimerRef.current);
            try { wsRef.current?.close(); } catch {}
            wsRef.current = null;
        };
    }, [autoRefresh, minProb, expiresWithinSec]);

    const onStart = async () => {
        setStartLoading(true);
        try {
            await api.post('/group-arb/crypto15m/auto/start', {
                amountUsd,
                minProb,
                expiresWithinSec,
                pollMs,
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
        } finally {
            setStartLoading(false);
        }
        refreshAll().catch(() => {});
    };

    const onStop = async () => {
        setStopLoading(true);
        try {
            await api.post('/group-arb/crypto15m/auto/stop');
        } finally {
            setStopLoading(false);
        }
        refreshAll().catch(() => {});
    };

    const onStartWatchdog = async () => {
        setWatchdogStartLoading(true);
        try {
            await api.post('/group-arb/crypto15m/watchdog/start', { durationHours: 12, pollMs: 30000 });
        } finally {
            setWatchdogStartLoading(false);
        }
        refreshAll().catch(() => {});
    };

    const onStopWatchdog = async () => {
        setWatchdogStopLoading(true);
        try {
            await api.post('/group-arb/crypto15m/watchdog/stop', { reason: 'manual_ui_stop', stopAuto: true });
        } finally {
            setWatchdogStopLoading(false);
        }
        refreshAll().catch(() => {});
    };

    const onBid = async (row: any) => {
        setBidLoadingId(String(row?.conditionId || ''));
        try {
            const res = await api.post('/group-arb/crypto15m/order', {
                conditionId: row.conditionId,
                outcomeIndex: row.chosenIndex,
                amountUsd,
                minPrice: minProb,
                trendEnabled,
                trendMinutes,
                stoplossEnabled,
                stoplossCut1DropCents,
                stoplossCut1SellPct,
                stoplossCut2DropCents,
                stoplossCut2SellPct,
                stoplossMinSecToExit,
            });
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
            await api.post('/group-arb/crypto15m/active/reset');
        } finally {
            setResetLoading(false);
        }
        refreshAll().catch(() => {});
    };

    const columns = useMemo(() => {
        return [
            {
                title: 'Symbol',
                dataIndex: 'symbol',
                key: 'symbol',
                width: 90,
                render: (v: any) => <Tag color="blue">{String(v || '').toUpperCase() || '-'}</Tag>,
            },
            {
                title: 'Market',
                dataIndex: 'title',
                key: 'title',
                render: (_: any, r: any) => (
                    <div>
                        <div style={{ color: '#fff', fontWeight: 600 }}>{r.title || r.slug || r.conditionId}</div>
                        <div style={{ color: '#aaa', fontSize: 12 }}>{r.conditionId}</div>
                    </div>
                ),
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
                            <Tag color={ok ? 'green' : 'default'}>{String(r.chosenOutcome)} {toCents(r.chosenPrice)}</Tag>
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
    }, [amountUsd, status?.actives, bidLoadingId]);

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
            { title: 'Market', dataIndex: 'title', key: 'title', render: (v: any, r: any) => {
                const slug = String(r?.slug || '').trim();
                const text = String(v || slug || r?.conditionId || '');
                if (!slug) return <span>{text}</span>;
                const href = `https://polymarket.com/event/${encodeURIComponent(slug)}`;
                return <a href={href} target="_blank" rel="noreferrer">{text}</a>;
            } },
            { title: 'Pick', dataIndex: 'outcome', key: 'outcome', width: 90, render: (v: any) => String(v || '') },
            { title: 'Amount', dataIndex: 'amountUsd', key: 'amountUsd', width: 90, render: (v: any) => (v != null ? `$${Number(v).toFixed(0)}` : '-') },
            { title: <Tooltip title="下單前從 CLOB /books 讀到的最低賣價（你買入的參考價）"><span>BestAsk</span></Tooltip>, dataIndex: 'bestAsk', key: 'bestAsk', width: 90, render: (v: any) => (v != null ? toCents(v) : '-') },
            { title: <Tooltip title="送單的最高買入價上限（FAK：能成交就成交，剩下直接取消）"><span>Limit</span></Tooltip>, dataIndex: 'limitPrice', key: 'limitPrice', width: 90, render: (v: any) => (v != null ? toCents(v) : '-') },
            { title: 'Order', dataIndex: 'orderStatus', key: 'orderStatus', width: 90, render: (v: any) => (v ? <Tag>{String(v)}</Tag> : '-') },
            { title: 'Filled', dataIndex: 'filledSize', key: 'filledSize', width: 80, render: (v: any) => (v != null ? Number(v).toFixed(2) : '-') },
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

    return (
        <div>
            <Title level={3} style={{ color: '#fff', marginBottom: 16 }}>
                ⏱️ 15mins Crypto Trade
            </Title>

            <Card style={{ marginBottom: 16, background: '#1f1f1f', border: '1px solid #333' }}>
                <Alert
                    style={{ marginBottom: 12 }}
                    type="warning"
                    message="請先啟動 Watchdog（12h 監控），再啟動 Auto Order，避免監控失效。"
                    showIcon
                />
                <Space wrap>
                    <span style={{ color: '#ddd' }}>Min Prob</span>
                    <InputNumber min={0.5} max={0.99} step={0.01} value={minProb} onChange={(v) => setMinProb(Number(v))} />
                    <span style={{ color: '#ddd' }}>Expire ≤ (sec)</span>
                    <InputNumber min={10} max={300} step={5} value={expiresWithinSec} onChange={(v) => setExpiresWithinSec(Number(v))} />
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
                    <span style={{ color: '#ddd' }}>Δ BTC</span>
                    <InputNumber min={0} step={1} value={btcMinDelta} onChange={(v) => setBtcMinDelta(Math.max(0, Number(v)))} />
                    <span style={{ color: '#ddd' }}>Δ ETH</span>
                    <InputNumber min={0} step={1} value={ethMinDelta} onChange={(v) => setEthMinDelta(Math.max(0, Number(v)))} />
                    <span style={{ color: '#ddd' }}>Δ SOL</span>
                    <InputNumber min={0} step={0.1} value={solMinDelta} onChange={(v) => setSolMinDelta(Math.max(0, Number(v)))} />
                    <span style={{ color: '#ddd' }}>Δ XRP</span>
                    <InputNumber min={0} step={0.0001} value={xrpMinDelta} onChange={(v) => setXrpMinDelta(Math.max(0, Number(v)))} />
                    <Button onClick={saveAllSettings} loading={thresholdsSaving}>
                        Confirm
                    </Button>
                    <Button onClick={onStartWatchdog} loading={watchdogStartLoading} disabled={watchdog?.running === true}>
                        {watchdog?.running ? 'Watchdog: ON' : 'Start Watchdog (12h)'}
                    </Button>
                    <Tooltip title={watchdog?.running !== true ? '請先啟動 Watchdog（12h 監控）' : status?.enabled ? 'Auto 已啟動' : String(status?.lastError || '').startsWith('books_stale:') ? '目前 books_stale 超過門檻；Auto 會安全停單。請等快照更新或調高門檻。' : undefined}>
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
                    message={`WS: ${wsConnected ? 'ON' : 'OFF'} • WS Last: ${wsLastAt || '-'} • Key: ${status?.hasValidKey ? 'OK' : 'MISSING'} • Watchdog: ${watchdog?.running ? 'ON' : 'OFF'} • Auto: ${status?.enabled ? 'ON' : 'OFF'} • LastScanAt: ${status?.lastScanAt || '-'} • Tracked: ${Array.isArray(status?.tracked) ? status.tracked.length : '-'} • Candidates: ${candidatesMeta?.eligible ?? '-'} eligible / ${candidatesMeta?.count ?? '-'} total`}
                    showIcon
                />
                {wsError ? <Alert style={{ marginTop: 12 }} type="error" message={wsError} showIcon /> : null}
                {status?.actives ? (
                    <Alert
                        style={{ marginTop: 12 }}
                        type="info"
                        message={`Active: ${Object.keys(status.actives).length ? Object.keys(status.actives).map((k) => `${k}:${toCents(status.actives[k]?.price)} ${status.actives[k]?.outcome || ''}`).join(' | ') : 'none'}`}
                        showIcon
                    />
                ) : null}
                {status?.adaptiveDelta ? (
                    <Alert
                        style={{ marginTop: 12 }}
                        type="info"
                        message={`Adaptive Δ: ${['BTC', 'ETH', 'SOL', 'XRP'].map((sym) => {
                            const s = (status?.adaptiveDelta || {})[sym] || {};
                            const base = s.baseMinDelta != null ? Number(s.baseMinDelta) : null;
                            const ov = s.overrideMinDelta != null ? Number(s.overrideMinDelta) : null;
                            const rem = s.remainingToRevert != null ? String(s.remainingToRevert) : '-';
                            if (base == null) return `${sym}:-`;
                            return ov != null ? `${sym}:${base}→${ov} (remain ${rem})` : `${sym}:${base}`;
                        }).join(' | ')}`}
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

            <Card style={{ background: '#1f1f1f', border: '1px solid #333' }}>
                <Table
                    rowKey={(r) => r.conditionId}
                    loading={false}
                    dataSource={candidates}
                    columns={columns as any}
                    pagination={false}
                    size="small"
                />
            </Card>

            <Card style={{ marginTop: 16, background: '#1f1f1f', border: '1px solid #333' }}>
                <Title level={5} style={{ color: '#fff', marginBottom: 12 }}>Recent History</Title>
                {historySummary ? (
                    <Alert
                        style={{ marginBottom: 12 }}
                        type="info"
                        message={`Bets: ${historySummary.count ?? '-'} • Stake: $${Number(historySummary.totalStakeUsd ?? 0).toFixed(0)} • PnL: ${Number(historySummary.pnlTotalUsdc ?? 0).toFixed(4)} • W/L/O: ${historySummary.winCount ?? 0}/${historySummary.lossCount ?? 0}/${historySummary.openCount ?? 0} • Redeemable: ${historySummary.redeemableCount ?? 0} • ✅: ${historySummary.redeemedCount ?? 0}`}
                        showIcon
                    />
                ) : null}
                {configEvents.length ? (
                    <div style={{ marginBottom: 12 }}>
                        <Title level={5} style={{ color: '#fff', marginBottom: 8 }}>Config Records</Title>
                        <Table
                            rowKey={(r) => String(r.id)}
                            loading={false}
                            dataSource={configEvents.slice(0, 20)}
                            columns={configColumns as any}
                            pagination={false}
                            size="small"
                        />
                    </div>
                ) : null}
                <Table
                    rowKey={(r) => String(r.id)}
                    loading={false}
                    dataSource={showPendingOnly ? history.filter((x: any) => String(x?.result || '') === 'OPEN' || x?.redeemable === true || (String(x?.redeemStatus || '') && String(x?.redeemStatus || '').toLowerCase() !== 'confirmed')) : history}
                    columns={historyColumns as any}
                    pagination={false}
                    size="small"
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
                    rowKey={(r) => String(r?.id || Math.random())}
                    loading={stoplossLoading}
                    dataSource={stoplossHistory}
                    columns={stoplossColumns as any}
                    pagination={false}
                    size="small"
                />
            </Modal>
        </div>
    );
}

export default Crypto15m;
