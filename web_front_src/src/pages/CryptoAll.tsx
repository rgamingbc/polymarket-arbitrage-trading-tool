import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, InputNumber, Modal, Select, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { PlayCircleOutlined, PauseCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import axios from 'axios';

const { Title } = Typography;

const api = axios.create({
    baseURL: '/api',
    timeout: 120000,
});

const TF_OPTIONS = [
    { label: '15m', value: '15m' },
    { label: '1h', value: '1h' },
    { label: '4h', value: '4h' },
    { label: '1d', value: '1d' },
];

const SYMBOL_OPTIONS = [
    { label: 'BTC', value: 'BTC' },
    { label: 'ETH', value: 'ETH' },
    { label: 'SOL', value: 'SOL' },
    { label: 'XRP', value: 'XRP' },
];

function CryptoAll() {
    const [candidates, setCandidates] = useState<any[]>([]);
    const [status, setStatus] = useState<any>(null);
    const [watchdog, setWatchdog] = useState<any>(null);
    const [history, setHistory] = useState<any[]>([]);
    const [historySummary, setHistorySummary] = useState<any>(null);
    const [historyStrategy, setHistoryStrategy] = useState<'cryptoall' | 'crypto15m' | 'all'>('cryptoall');
    const [showPendingOnly, setShowPendingOnly] = useState(false);
    const [bidLoadingId, setBidLoadingId] = useState<string | null>(null);
    const [wsConnected, setWsConnected] = useState(false);
    const [wsLastAt, setWsLastAt] = useState<string | null>(null);
    const [wsError, setWsError] = useState<string | null>(null);
    const [pollMs, setPollMs] = useState<number>(2000);
    const [minProb, setMinProb] = useState<number>(0.9);
    const [expiresWithinSec, setExpiresWithinSec] = useState<number>(180);
    const [amountUsd, setAmountUsd] = useState<number>(1);
    const [dojiGuardEnabled, setDojiGuardEnabled] = useState<boolean>(true);
    const [riskSkipScore, setRiskSkipScore] = useState<number>(70);
    const [riskAddOnBlockScore, setRiskAddOnBlockScore] = useState<number>(50);
    const [addOnEnabled, setAddOnEnabled] = useState<boolean>(false);
    const [addOnAccelEnabled, setAddOnAccelEnabled] = useState<boolean>(true);
    const [addOnMultiplierA, setAddOnMultiplierA] = useState<number>(1.0);
    const [addOnMultiplierB, setAddOnMultiplierB] = useState<number>(1.3);
    const [addOnMultiplierC, setAddOnMultiplierC] = useState<number>(1.7);
    const [addOnMaxTotalStakeUsdPerPosition, setAddOnMaxTotalStakeUsdPerPosition] = useState<number>(50);
    const [stoplossOpen, setStoplossOpen] = useState<boolean>(false);
    const [stoplossEnabled, setStoplossEnabled] = useState<boolean>(false);
    const [stoplossCut1DropCents, setStoplossCut1DropCents] = useState<number>(1);
    const [stoplossCut1SellPct, setStoplossCut1SellPct] = useState<number>(50);
    const [stoplossCut2DropCents, setStoplossCut2DropCents] = useState<number>(2);
    const [stoplossCut2SellPct, setStoplossCut2SellPct] = useState<number>(100);
    const [stoplossSpreadGuardCents, setStoplossSpreadGuardCents] = useState<number>(2);
    const [stoplossMinSecToExit, setStoplossMinSecToExit] = useState<number>(25);
    const [symbols, setSymbols] = useState<string[]>(['BTC', 'ETH', 'SOL', 'XRP']);
    const [timeframes, setTimeframes] = useState<Array<'15m' | '1h' | '4h' | '1d'>>(['15m']);
    const [btcMinDelta, setBtcMinDelta] = useState<number>(600);
    const [ethMinDelta, setEthMinDelta] = useState<number>(30);
    const [solMinDelta, setSolMinDelta] = useState<number>(0.8);
    const [xrpMinDelta, setXrpMinDelta] = useState<number>(0.0065);
    const [startLoading, setStartLoading] = useState(false);
    const [stopLoading, setStopLoading] = useState(false);
    const [refreshLoading, setRefreshLoading] = useState(false);
    const [thresholdsLoading, setThresholdsLoading] = useState(false);
    const [thresholdsSaving, setThresholdsSaving] = useState(false);
    const [watchdogStartLoading, setWatchdogStartLoading] = useState(false);
    const [watchdogStopLoading, setWatchdogStopLoading] = useState(false);
    const [watchdogReportOpen, setWatchdogReportOpen] = useState(false);
    const [watchdogReport, setWatchdogReport] = useState<any>(null);
    const [matrixOpen, setMatrixOpen] = useState(false);
    const timerRef = useRef<any>(null);
    const historyTimerRef = useRef<any>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const wsRetryRef = useRef<number>(0);
    const wsReconnectTimerRef = useRef<any>(null);

    useEffect(() => {
        try {
            const raw = localStorage.getItem('cryptoall_settings_v1');
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (parsed?.minProb != null) setMinProb(Number(parsed.minProb));
            if (parsed?.expiresWithinSec != null) setExpiresWithinSec(Number(parsed.expiresWithinSec));
            if (parsed?.amountUsd != null) setAmountUsd(Number(parsed.amountUsd));
            if (parsed?.pollMs != null) setPollMs(Number(parsed.pollMs));
            if (parsed?.dojiGuardEnabled != null) setDojiGuardEnabled(!!parsed.dojiGuardEnabled);
            if (parsed?.riskSkipScore != null) setRiskSkipScore(Number(parsed.riskSkipScore));
            if (parsed?.riskAddOnBlockScore != null) setRiskAddOnBlockScore(Number(parsed.riskAddOnBlockScore));
            if (parsed?.addOnEnabled != null) setAddOnEnabled(!!parsed.addOnEnabled);
            if (parsed?.addOnAccelEnabled != null) setAddOnAccelEnabled(!!parsed.addOnAccelEnabled);
            if (parsed?.addOnMultiplierA != null) setAddOnMultiplierA(Number(parsed.addOnMultiplierA));
            if (parsed?.addOnMultiplierB != null) setAddOnMultiplierB(Number(parsed.addOnMultiplierB));
            if (parsed?.addOnMultiplierC != null) setAddOnMultiplierC(Number(parsed.addOnMultiplierC));
            if (parsed?.addOnMaxTotalStakeUsdPerPosition != null) setAddOnMaxTotalStakeUsdPerPosition(Number(parsed.addOnMaxTotalStakeUsdPerPosition));
            if (parsed?.stoplossEnabled != null) setStoplossEnabled(!!parsed.stoplossEnabled);
            if (parsed?.stoplossCut1DropCents != null) setStoplossCut1DropCents(Number(parsed.stoplossCut1DropCents));
            if (parsed?.stoplossCut1SellPct != null) setStoplossCut1SellPct(Number(parsed.stoplossCut1SellPct));
            if (parsed?.stoplossCut2DropCents != null) setStoplossCut2DropCents(Number(parsed.stoplossCut2DropCents));
            if (parsed?.stoplossCut2SellPct != null) setStoplossCut2SellPct(Number(parsed.stoplossCut2SellPct));
            if (parsed?.stoplossSpreadGuardCents != null) setStoplossSpreadGuardCents(Number(parsed.stoplossSpreadGuardCents));
            if (parsed?.stoplossMinSecToExit != null) setStoplossMinSecToExit(Number(parsed.stoplossMinSecToExit));
            if (Array.isArray(parsed?.symbols)) setSymbols(parsed.symbols.map((x: any) => String(x || '').toUpperCase()).filter(Boolean));
            if (Array.isArray(parsed?.timeframes)) setTimeframes(parsed.timeframes.map((x: any) => String(x || '').toLowerCase()).filter(Boolean));
        } catch {
        }
    }, []);

    useEffect(() => {
        try {
            localStorage.setItem('cryptoall_settings_v1', JSON.stringify({
                minProb,
                expiresWithinSec,
                amountUsd,
                pollMs,
                dojiGuardEnabled,
                riskSkipScore,
                riskAddOnBlockScore,
                addOnEnabled,
                addOnAccelEnabled,
                addOnMultiplierA,
                addOnMultiplierB,
                addOnMultiplierC,
                addOnMaxTotalStakeUsdPerPosition,
                stoplossEnabled,
                stoplossCut1DropCents,
                stoplossCut1SellPct,
                stoplossCut2DropCents,
                stoplossCut2SellPct,
                stoplossSpreadGuardCents,
                stoplossMinSecToExit,
                symbols,
                timeframes,
            }));
        } catch {
        }
    }, [minProb, expiresWithinSec, amountUsd, pollMs, dojiGuardEnabled, riskSkipScore, riskAddOnBlockScore, addOnEnabled, addOnAccelEnabled, addOnMultiplierA, addOnMultiplierB, addOnMultiplierC, addOnMaxTotalStakeUsdPerPosition, stoplossEnabled, stoplossCut1DropCents, stoplossCut1SellPct, stoplossCut2DropCents, stoplossCut2SellPct, stoplossSpreadGuardCents, stoplossMinSecToExit, symbols, timeframes]);

    const fetchStatus = async () => {
        const res = await api.get('/group-arb/cryptoall/status');
        setStatus(res.data?.status);
    };

    const fetchWatchdog = async () => {
        const r = await api.get('/group-arb/cryptoall/watchdog/status');
        setWatchdog(r.data?.status);
    };

    const fetchCandidates = async () => {
        const res = await api.get('/group-arb/cryptoall/candidates', {
            params: {
                symbols: symbols.join(','),
                timeframes: timeframes.join(','),
                minProb,
                expiresWithinSec,
                limit: 40,
            }
        });
        const list = Array.isArray(res.data?.candidates) ? res.data.candidates : [];
        setCandidates(list);
    };

    const fetchHistory = async () => {
        if (historyStrategy === 'cryptoall') {
            const res = await api.get('/group-arb/cryptoall/history', { params: { refresh: true, intervalMs: 1000, maxEntries: 50 } });
            const h = Array.isArray(res.data?.history) ? res.data.history : [];
            setHistory(h.map((x: any) => ({ ...x, strategy: 'cryptoall' })));
            setHistorySummary(res.data?.summary || null);
            return;
        }
        if (historyStrategy === 'crypto15m') {
            const res = await api.get('/group-arb/crypto15m/history', { params: { refresh: true, intervalMs: 1000, maxEntries: 50 } });
            const h = Array.isArray(res.data?.history) ? res.data.history : [];
            setHistory(h.map((x: any) => ({ ...x, strategy: 'crypto15m' })));
            setHistorySummary(res.data?.summary || null);
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
    };

    const fetchThresholds = async () => {
        setThresholdsLoading(true);
        try {
            const r = await api.get('/group-arb/cryptoall/delta-thresholds');
            const t = r.data?.thresholds || {};
            if (t?.btcMinDelta != null) setBtcMinDelta(Number(t.btcMinDelta));
            if (t?.ethMinDelta != null) setEthMinDelta(Number(t.ethMinDelta));
            if (t?.solMinDelta != null) setSolMinDelta(Number(t.solMinDelta));
            if (t?.xrpMinDelta != null) setXrpMinDelta(Number(t.xrpMinDelta));
        } finally {
            setThresholdsLoading(false);
        }
    };

    const saveThresholds = async () => {
        setThresholdsSaving(true);
        try {
            await api.post('/group-arb/cryptoall/delta-thresholds', { btcMinDelta, ethMinDelta, solMinDelta, xrpMinDelta });
        } finally {
            setThresholdsSaving(false);
        }
        fetchThresholds().catch(() => {});
    };

    const refreshAll = async () => {
        await Promise.all([fetchStatus(), fetchCandidates(), fetchWatchdog()]);
    };

    useEffect(() => {
        fetchThresholds().catch(() => {});
        refreshAll().catch(() => {});
        fetchHistory().catch(() => {});
    }, []);

    useEffect(() => {
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = setInterval(() => {
            const wsLastMs = wsLastAt ? Date.parse(String(wsLastAt)) : NaN;
            const wsFresh = wsConnected && Number.isFinite(wsLastMs) && (Date.now() - wsLastMs) < 2000;
            if (wsFresh) {
                fetchWatchdog().catch(() => {});
                return;
            }
            Promise.all([fetchStatus(), fetchCandidates(), fetchWatchdog()]).catch(() => {});
        }, Math.max(500, Math.floor(pollMs)));
        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [pollMs, minProb, expiresWithinSec, symbols.join(','), timeframes.join(','), wsConnected, wsLastAt]);

    useEffect(() => {
        if (historyTimerRef.current) clearInterval(historyTimerRef.current);
        historyTimerRef.current = setInterval(() => {
            fetchHistory().catch(() => {});
        }, 10000);
        return () => {
            if (historyTimerRef.current) clearInterval(historyTimerRef.current);
        };
    }, [historyStrategy]);

    useEffect(() => {
        fetchHistory().catch(() => {});
    }, [historyStrategy]);

    useEffect(() => {
        if (wsReconnectTimerRef.current) clearTimeout(wsReconnectTimerRef.current);
        if (wsRef.current) {
            try { wsRef.current.close(); } catch {}
            wsRef.current = null;
        }
        const connect = () => {
            if (wsReconnectTimerRef.current) clearTimeout(wsReconnectTimerRef.current);
            if (wsRef.current) {
                try { wsRef.current.close(); } catch {}
                wsRef.current = null;
            }
            const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
            const wsUrl =
                `${protocol}://${window.location.host}/api/group-arb/cryptoall/ws` +
                `?symbols=${encodeURIComponent(symbols.join(','))}` +
                `&timeframes=${encodeURIComponent(timeframes.join(','))}` +
                `&minProb=${encodeURIComponent(String(minProb))}` +
                `&expiresWithinSec=${encodeURIComponent(String(expiresWithinSec))}` +
                `&limit=40`;
            const ws = new WebSocket(wsUrl);
            wsRef.current = ws;
            setWsError(null);
            ws.onopen = () => {
                wsRetryRef.current = 0;
                setWsConnected(true);
                fetchStatus().catch(() => {});
            };
            ws.onclose = () => {
                setWsConnected(false);
                const retry = Math.min(8, wsRetryRef.current + 1);
                wsRetryRef.current = retry;
                const delayMs = Math.min(10_000, 300 * Math.pow(2, retry));
                wsReconnectTimerRef.current = setTimeout(connect, delayMs);
            };
            ws.onerror = () => {
                setWsError(`WS error: ${wsUrl}`);
            };
            ws.onmessage = (evt) => {
                try {
                    const msg = JSON.parse(String(evt.data || '{}'));
                    if (msg?.type === 'snapshot') {
                        setWsLastAt(String(msg?.at || null));
                        if (msg?.status) setStatus(msg.status);
                        if (Array.isArray(msg?.candidates)) setCandidates(msg.candidates);
                        return;
                    }
                    if (msg?.type === 'error') {
                        setWsLastAt(String(msg?.at || null));
                        setWsError(String(msg?.message || 'WS error'));
                    }
                } catch {
                }
            };
        };
        connect();
        return () => {
            if (wsReconnectTimerRef.current) clearTimeout(wsReconnectTimerRef.current);
            if (wsRef.current) {
                try { wsRef.current.close(); } catch {}
                wsRef.current = null;
            }
        };
    }, [symbols.join(','), timeframes.join(','), minProb, expiresWithinSec]);

    const onStart = async () => {
        setStartLoading(true);
        try {
            await api.post('/group-arb/cryptoall/auto/start', {
                pollMs,
                minProb,
                expiresWithinSec,
                amountUsd,
                symbols,
                timeframes,
                dojiGuardEnabled,
                riskSkipScore,
                riskAddOnBlockScore,
                addOnEnabled,
                addOnAccelEnabled,
                addOnMultiplierA,
                addOnMultiplierB,
                addOnMultiplierC,
                addOnMaxTotalStakeUsdPerPosition,
                stoplossEnabled,
                stoplossCut1DropCents,
                stoplossCut1SellPct,
                stoplossCut2DropCents,
                stoplossCut2SellPct,
                stoplossSpreadGuardCents,
                stoplossMinSecToExit,
            });
        } finally {
            setStartLoading(false);
        }
        refreshAll().catch(() => {});
    };

    const onStop = async () => {
        setStopLoading(true);
        try {
            await api.post('/group-arb/cryptoall/auto/stop');
        } finally {
            setStopLoading(false);
        }
        refreshAll().catch(() => {});
    };

    const onStartWatchdog = async () => {
        setWatchdogStartLoading(true);
        try {
            await api.post('/group-arb/cryptoall/watchdog/start', { durationHours: 12, pollMs: 30000 });
        } finally {
            setWatchdogStartLoading(false);
        }
        fetchWatchdog().catch(() => {});
    };

    const onStopWatchdog = async () => {
        setWatchdogStopLoading(true);
        try {
            await api.post('/group-arb/cryptoall/watchdog/stop', { reason: 'manual_ui_stop', stopAuto: true });
        } finally {
            setWatchdogStopLoading(false);
        }
        fetchWatchdog().catch(() => {});
        fetchStatus().catch(() => {});
    };

    const onOpenWatchdogReport = async () => {
        const r = await api.get('/group-arb/cryptoall/watchdog/report/latest');
        setWatchdogReport(r.data);
        setWatchdogReportOpen(true);
    };

    const toCents = (p: any) => {
        const n = Number(p);
        if (!Number.isFinite(n)) return '-';
        return (n * 100).toFixed(1) + 'c';
    };

    const onBid = async (r: any) => {
        const conditionId = String(r?.conditionId || '').trim();
        if (!conditionId) return;
        if (r?.chosenIndex == null) return;
        setBidLoadingId(conditionId);
        try {
            await api.post('/group-arb/cryptoall/order', {
                conditionId,
                outcomeIndex: Number(r.chosenIndex),
                amountUsd,
                minPrice: minProb,
                force: false,
                symbol: r?.symbol,
                timeframe: r?.timeframe,
            });
        } finally {
            setBidLoadingId(null);
        }
        refreshAll().catch(() => {});
        fetchHistory().catch(() => {});
    };

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
            { title: 'BestAsk', dataIndex: 'bestAsk', key: 'bestAsk', width: 90, render: (v: any) => (v != null ? toCents(v) : '-') },
            { title: 'Limit', dataIndex: 'limitPrice', key: 'limitPrice', width: 90, render: (v: any) => (v != null ? toCents(v) : '-') },
            { title: 'Order', dataIndex: 'orderStatus', key: 'orderStatus', width: 90, render: (v: any) => (v ? <Tag>{String(v)}</Tag> : '-') },
            { title: 'Filled', dataIndex: 'filledSize', key: 'filledSize', width: 80, render: (v: any) => (v != null ? Number(v).toFixed(2) : '-') },
            { title: 'Result', dataIndex: 'result', key: 'result', width: 90, render: (v: any) => <Tag color={String(v) === 'WIN' ? 'green' : String(v) === 'LOSS' ? 'red' : 'default'}>{String(v || '-')}</Tag> },
            { title: 'PnL', dataIndex: 'cashPnl', key: 'cashPnl', width: 90, render: (v: any, r: any) => {
                const x = r?.realizedPnlUsdc != null ? r.realizedPnlUsdc : v;
                return x != null ? Number(x).toFixed(4) : '-';
            } },
            {
                title: 'State',
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
            { title: 'Tx', dataIndex: 'txHash', key: 'txHash', width: 120, render: (v: any) => (v ? <Tag>{String(v).slice(0, 6)}…{String(v).slice(-4)}</Tag> : '-') },
        ];
    }, [symbols.join(','), timeframes.join(',')]);

    const columns: any[] = [
        {
            title: 'Symbol',
            dataIndex: 'symbol',
            key: 'symbol',
            width: 90,
            render: (_: any, r: any) => (
                <Space size={6}>
                    <Tag color="blue">{String(r?.symbol || '').toUpperCase()}</Tag>
                    <Tag>{String(r?.timeframe || '').toUpperCase()}</Tag>
                </Space>
            )
        },
        {
            title: 'Market',
            dataIndex: 'question',
            key: 'question',
            render: (v: any, r: any) => {
                const slug = String(r?.slug || '').trim();
                const text = String(v || slug || r?.conditionId || '');
                const cid = String(r?.conditionId || '').trim();
                const href = slug ? `https://polymarket.com/event/${encodeURIComponent(slug)}` : null;
                return (
                    <div>
                        {href ? <a href={href} target="_blank" rel="noreferrer">{text}</a> : <span>{text}</span>}
                        <div style={{ fontSize: 12, color: '#777' }}>{cid}</div>
                    </div>
                );
            }
        },
        {
            title: 'Expire(s)',
            dataIndex: 'secondsToExpire',
            key: 'secondsToExpire',
            width: 110,
            render: (v: any) => <Tag color={Number(v) <= 30 ? 'red' : 'gold'}>{String(v)}</Tag>
        },
        {
            title: 'Risk',
            key: 'risk',
            width: 130,
            render: (_: any, r: any) => {
                const s = r?.riskScore != null ? Number(r.riskScore) : null;
                const color = s == null ? 'default' : s >= 70 ? 'red' : s >= 50 ? 'orange' : s >= 30 ? 'green' : 'blue';
                const doji = r?.dojiLikely === true ? 'doji' : '';
                const spread = r?.spread != null ? toCents(r.spread) : '-';
                return (
                    <Space wrap size={6}>
                        <Tag color={color}>{s == null ? '-' : s}</Tag>
                        {doji ? <Tag>{doji}</Tag> : null}
                        <Tag>spr {spread}</Tag>
                    </Space>
                );
            }
        },
        {
            title: 'Outcomes',
            key: 'outcomes',
            width: 180,
            render: (_: any, r: any) => (
                <Space direction="vertical" size={2}>
                    <span style={{ color: '#bbb' }}>Up: {r?.upPrice != null ? toCents(r.upPrice) : '-'}</span>
                    <span style={{ color: '#bbb' }}>Down: {r?.downPrice != null ? toCents(r.downPrice) : '-'}</span>
                </Space>
            )
        },
        {
            title: 'Pick',
            key: 'pick',
            width: 180,
            render: (_: any, r: any) => {
                const riskBlocked = dojiGuardEnabled && r?.riskScore != null && Number(r.riskScore) >= riskSkipScore;
                const ok = r?.eligibleByExpiry === true && r?.meetsMinProb === true && r?.meetsMinDelta === true && !riskBlocked;
                const pick = r?.chosenOutcome ? `${String(r.chosenOutcome)} ${toCents(r.chosenPrice)}` : '-';
                return (
                    <Space wrap size={6}>
                        <Tag color={ok ? 'green' : 'default'}>{pick}</Tag>
                        {!ok ? <Tag>{riskBlocked ? 'risk' : 'expiry/Δ/minProb'}</Tag> : null}
                    </Space>
                );
            }
        },
        {
            title: 'Action',
            key: 'action',
            width: 140,
            render: (_: any, r: any) => (
                <Button
                    onClick={() => onBid(r)}
                    loading={bidLoadingId === String(r?.conditionId || '')}
                    disabled={!r?.conditionId || r?.chosenIndex == null}
                >
                    Bid ${amountUsd}
                </Button>
            )
        },
    ];

    return (
        <div>
            <Title level={3} style={{ color: '#fff', marginBottom: 16 }}>
                🧩 Crypto All
            </Title>

            <Card style={{ marginBottom: 16, background: '#1f1f1f', border: '1px solid #333' }}>
                <Alert style={{ marginBottom: 12 }} type="info" message="Crypto All 是獨立策略，不會影響 crypto-15m。" showIcon />
                <Space wrap>
                    <span style={{ color: '#ddd' }}>Selected</span>
                    <Tag>{(timeframes || []).map((x) => String(x).toUpperCase()).join(', ') || '-'}</Tag>
                    <Tag>{(symbols || []).map((x) => String(x).toUpperCase()).join(', ') || '-'}</Tag>
                    <Button onClick={() => setMatrixOpen(true)}>Matrix</Button>
                </Space>
                <div style={{ height: 12 }} />
                <Space wrap>
                    <span style={{ color: '#ddd' }}>Min Prob</span>
                    <InputNumber min={0.5} max={0.99} step={0.01} value={minProb} onChange={(v) => setMinProb(Number(v))} />
                    <span style={{ color: '#ddd' }}>Expire ≤ (sec)</span>
                    <InputNumber min={10} max={300} step={5} value={expiresWithinSec} onChange={(v) => setExpiresWithinSec(Number(v))} />
                    <span style={{ color: '#ddd' }}>Poll (ms)</span>
                    <InputNumber min={500} max={10000} step={100} value={pollMs} onChange={(v) => setPollMs(Math.max(500, Math.floor(Number(v))))} />
                    <span style={{ color: '#ddd' }}>Amount ($)</span>
                    <InputNumber min={1} max={1000} step={1} value={amountUsd} onChange={(v) => setAmountUsd(Math.max(1, Math.floor(Number(v))))} />
                </Space>
                <div style={{ height: 12 }} />
                <Space wrap>
                    <Checkbox checked={dojiGuardEnabled} onChange={(e) => setDojiGuardEnabled(e.target.checked)}>
                        Doji Guard
                    </Checkbox>
                    <span style={{ color: '#ddd' }}>Skip ≥</span>
                    <InputNumber min={0} max={100} step={1} value={riskSkipScore} onChange={(v) => setRiskSkipScore(Math.max(0, Math.min(100, Math.floor(Number(v)))))} />
                    <span style={{ color: '#ddd' }}>AddOn Block ≥</span>
                    <InputNumber min={0} max={100} step={1} value={riskAddOnBlockScore} onChange={(v) => setRiskAddOnBlockScore(Math.max(0, Math.min(100, Math.floor(Number(v)))))} />
                </Space>
                <div style={{ height: 12 }} />
                <Space wrap>
                    <Checkbox checked={addOnEnabled} onChange={(e) => setAddOnEnabled(e.target.checked)}>
                        Add-On (3-2-1)
                    </Checkbox>
                    <Checkbox checked={addOnAccelEnabled} onChange={(e) => setAddOnAccelEnabled(e.target.checked)} disabled={!addOnEnabled}>
                        Accel
                    </Checkbox>
                    <span style={{ color: '#ddd' }}>A×</span>
                    <InputNumber min={0.1} max={5} step={0.1} value={addOnMultiplierA} onChange={(v) => setAddOnMultiplierA(Number(v))} disabled={!addOnEnabled} />
                    <span style={{ color: '#ddd' }}>B×</span>
                    <InputNumber min={0.1} max={5} step={0.1} value={addOnMultiplierB} onChange={(v) => setAddOnMultiplierB(Number(v))} disabled={!addOnEnabled} />
                    <span style={{ color: '#ddd' }}>C×</span>
                    <InputNumber min={0.1} max={5} step={0.1} value={addOnMultiplierC} onChange={(v) => setAddOnMultiplierC(Number(v))} disabled={!addOnEnabled} />
                    <span style={{ color: '#ddd' }}>Max Stake</span>
                    <InputNumber min={1} max={5000} step={1} value={addOnMaxTotalStakeUsdPerPosition} onChange={(v) => setAddOnMaxTotalStakeUsdPerPosition(Math.max(1, Math.floor(Number(v))))} disabled={!addOnEnabled} />
                    <Button onClick={() => setStoplossOpen(true)}>StopLoss</Button>
                </Space>
                <div style={{ height: 12 }} />
                <Space wrap>
                    <span style={{ color: '#ddd' }}>Δ BTC</span>
                    <InputNumber min={0} step={1} value={btcMinDelta} onChange={(v) => setBtcMinDelta(Math.max(0, Number(v)))} />
                    <span style={{ color: '#ddd' }}>Δ ETH</span>
                    <InputNumber min={0} step={1} value={ethMinDelta} onChange={(v) => setEthMinDelta(Math.max(0, Number(v)))} />
                    <span style={{ color: '#ddd' }}>Δ SOL</span>
                    <InputNumber min={0} step={0.1} value={solMinDelta} onChange={(v) => setSolMinDelta(Math.max(0, Number(v)))} />
                    <span style={{ color: '#ddd' }}>Δ XRP</span>
                    <InputNumber min={0} step={0.0001} value={xrpMinDelta} onChange={(v) => setXrpMinDelta(Math.max(0, Number(v)))} />
                    <Button onClick={saveThresholds} loading={thresholdsSaving} disabled={thresholdsLoading}>
                        Confirm Δ
                    </Button>
                    <Button onClick={onStartWatchdog} loading={watchdogStartLoading} disabled={watchdog?.running === true}>
                        {watchdog?.running ? 'Watchdog: ON' : 'Start Watchdog (12h)'}
                    </Button>
                    <Tooltip title={watchdog?.reportPaths?.json ? '查看最近 Watchdog 報告' : '未有報告（未啟動或未觸發 stop）'}>
                        <Button onClick={onOpenWatchdogReport} disabled={!watchdog?.reportPaths?.json}>
                            Report
                        </Button>
                    </Tooltip>
                    <Button type="primary" icon={<PlayCircleOutlined />} onClick={onStart} loading={startLoading} disabled={!!status?.enabled}>
                        Start Auto
                    </Button>
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
                </Space>
            </Card>

            <Card style={{ marginBottom: 16, background: '#1f1f1f', border: '1px solid #333' }}>
                <Space wrap>
                    <Tag color={status?.enabled ? 'green' : 'red'}>Auto: {status?.enabled ? 'ON' : 'OFF'}</Tag>
                    <Tag color={watchdog?.running ? 'green' : 'red'}>Watchdog: {watchdog?.running ? 'ON' : 'OFF'}</Tag>
                    <Tag color={wsConnected ? 'green' : 'red'}>WS: {wsConnected ? 'ON' : 'OFF'}</Tag>
                    {wsLastAt ? <Tag>WS Last: {String(wsLastAt).replace('T', ' ').replace('Z', '')}</Tag> : null}
                    <Tag>Tracked: {String(status?.trackedCount ?? 0)}</Tag>
                    <Tag color={status?.addOn?.enabled ? 'green' : 'red'}>Add-On: {status?.addOn?.enabled ? 'ON' : 'OFF'}</Tag>
                    <Tag>Add-On Pos: {Array.isArray(status?.addOn?.positions) ? status.addOn.positions.length : 0}</Tag>
                    <Tag>LastScan: {String(status?.lastScanAt || '-')}</Tag>
                    {status?.lastError ? <Tag color="red">{String(status.lastError).slice(0, 80)}</Tag> : null}
                </Space>
                {Array.isArray(status?.addOn?.positions) && status.addOn.positions.length ? (
                    <div style={{ marginTop: 12 }}>
                        <Space wrap>
                            {status.addOn.positions.slice(0, 10).map((p: any) => (
                                <Tag key={String(p.positionKey || '')}>
                                    {String(p.symbol || '').toUpperCase()} {String(p.window || '-')} {Number(p.secondsToExpire || 0)}s A{p.placedA ? '✓' : '-'}B{p.placedB ? '✓' : '-'}C{p.placedC ? '✓' : '-'}
                                </Tag>
                            ))}
                        </Space>
                    </div>
                ) : null}
                {wsError ? <Alert style={{ marginTop: 12 }} type="error" message={wsError} showIcon /> : null}
                {!candidates.length ? (
                    <Alert
                        style={{ marginTop: 12 }}
                        type="warning"
                        message="暫無候選市場"
                        description="通常係 slugs 來源抓取失敗或 Polymarket 頁面路徑改動。可用 /api/group-arb/cryptoall/diag 檢查各來源狀態。"
                        showIcon
                    />
                ) : null}
            </Card>

            <Table
                size="small"
                rowKey={(r) => String(r?.conditionId || '') + ':' + String(r?.timeframe || '')}
                columns={columns}
                dataSource={candidates}
                pagination={{ pageSize: 20 }}
                style={{ background: '#1f1f1f', border: '1px solid #333' }}
                expandable={{
                    expandedRowRender: (r) => (
                        <Space wrap>
                            <Tag>TF {String(r?.timeframe || '').toUpperCase()}</Tag>
                            <Tag>Δ {r?.deltaAbs != null ? Number(r.deltaAbs).toFixed(6) : '-'}</Tag>
                            <Tag>ΔMin {r?.minDeltaRequired != null ? Number(r.minDeltaRequired).toFixed(6) : '-'}</Tag>
                            <Tag>MinProb {r?.minProb != null ? Number(r.minProb).toFixed(2) : '-'}</Tag>
                            <Tag>Eligible {r?.eligibleByExpiry === true ? 'Y' : 'N'}</Tag>
                            <Tag>Slug {String(r?.slug || '').slice(0, 48)}</Tag>
                            {r?.deltaError ? <Tag color="red">{String(r.deltaError).slice(0, 80)}</Tag> : null}
                        </Space>
                    ),
                    rowExpandable: (r) => !!r,
                }}
            />
            <Card style={{ marginTop: 16, background: '#1f1f1f', border: '1px solid #333' }}>
                <Title level={5} style={{ color: '#fff', marginBottom: 12 }}>Recent History</Title>
                <Space wrap style={{ marginBottom: 12 }}>
                    <Button onClick={() => setShowPendingOnly((v) => !v)} type={showPendingOnly ? 'primary' : 'default'}>
                        {showPendingOnly ? 'History: Pending' : 'History: All'}
                    </Button>
                    <Select
                        value={historyStrategy}
                        style={{ width: 180 }}
                        onChange={(v) => setHistoryStrategy(v)}
                        options={[
                            { label: 'History: CryptoAll', value: 'cryptoall' },
                            { label: 'History: Crypto15m', value: 'crypto15m' },
                            { label: 'History: All', value: 'all' },
                        ]}
                    />
                    <Button onClick={() => fetchHistory().catch(() => {})}>Refresh History</Button>
                </Space>
                {historySummary ? (
                    <Alert
                        style={{ marginBottom: 12 }}
                        type="info"
                        message={`Bets: ${historySummary.count ?? '-'} • Stake: $${Number(historySummary.totalStakeUsd ?? 0).toFixed(0)} • PnL: ${Number(historySummary.pnlTotalUsdc ?? 0).toFixed(4)} • W/L/O: ${historySummary.winCount ?? 0}/${historySummary.lossCount ?? 0}/${historySummary.openCount ?? 0} • Redeemable: ${historySummary.redeemableCount ?? 0} • ✅: ${historySummary.redeemedCount ?? 0}`}
                        showIcon
                    />
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
                title="Timeframes × Symbols"
                open={matrixOpen}
                onCancel={() => setMatrixOpen(false)}
                onOk={() => setMatrixOpen(false)}
                okText="Done"
                cancelText="Close"
            >
                <Space direction="vertical" style={{ width: '100%' }}>
                    <Space wrap>
                        <span style={{ color: '#555' }}>Timeframes</span>
                        <Checkbox.Group options={TF_OPTIONS} value={timeframes as any} onChange={(v) => setTimeframes(v as any)} />
                        <Button
                            onClick={() => {
                                setTimeframes(['15m', '1h', '4h', '1d']);
                            }}
                        >
                            All TF
                        </Button>
                    </Space>
                    <Space wrap>
                        <span style={{ color: '#555' }}>Symbols</span>
                        <Checkbox.Group options={SYMBOL_OPTIONS} value={symbols} onChange={(v) => setSymbols((v as any[]).map((x) => String(x)))} />
                        <Button
                            onClick={() => {
                                setSymbols(['BTC', 'ETH', 'SOL', 'XRP']);
                            }}
                        >
                            All SYM
                        </Button>
                    </Space>
                    <div style={{ border: '1px solid #eee', borderRadius: 8, padding: 12 }}>
                        <div style={{ fontSize: 12, color: '#777', marginBottom: 8 }}>Active combinations</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '80px repeat(4, 1fr)', gap: 8, alignItems: 'center' }}>
                            <div />
                            {TF_OPTIONS.map((tf) => (
                                <div key={tf.value} style={{ textAlign: 'center', fontWeight: 600 }}>
                                    {tf.label}
                                </div>
                            ))}
                            {SYMBOL_OPTIONS.map((sym) => (
                                <div key={sym.value} style={{ display: 'contents' }}>
                                    <div style={{ fontWeight: 600 }}>
                                        {sym.label}
                                    </div>
                                    {TF_OPTIONS.map((tf) => {
                                        const on = symbols.includes(sym.value) && (timeframes as any[]).includes(tf.value);
                                        return (
                                            <div key={`${sym.value}:${tf.value}`} style={{ textAlign: 'center' }}>
                                                <Tag color={on ? 'green' : 'default'}>{on ? 'ON' : 'OFF'}</Tag>
                                            </div>
                                        );
                                    })}
                                </div>
                            ))}
                        </div>
                    </div>
                </Space>
            </Modal>
            <Modal
                title="Crypto All Watchdog Report"
                open={watchdogReportOpen}
                onCancel={() => setWatchdogReportOpen(false)}
                onOk={() => setWatchdogReportOpen(false)}
                okText="Close"
                cancelButtonProps={{ style: { display: 'none' } }}
                width={900}
            >
                <div style={{ fontSize: 12, color: '#777', marginBottom: 8 }}>
                    jsonPath: {String(watchdogReport?.jsonPath || '-')} • mdPath: {String(watchdogReport?.mdPath || '-')}
                </div>
                <div style={{ maxHeight: 420, overflow: 'auto', border: '1px solid #eee', borderRadius: 8, padding: 12, background: '#fafafa' }}>
                    <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                        {String(watchdogReport?.md || JSON.stringify(watchdogReport?.json || null, null, 2) || '')}
                    </pre>
                </div>
            </Modal>
            <Modal
                title="StopLoss Settings"
                open={stoplossOpen}
                onCancel={() => setStoplossOpen(false)}
                onOk={() => setStoplossOpen(false)}
                okText="Done"
                cancelText="Close"
            >
                <Space direction="vertical" style={{ width: '100%' }}>
                    <Checkbox checked={stoplossEnabled} onChange={(e) => setStoplossEnabled(e.target.checked)}>
                        Enable StopLoss
                    </Checkbox>
                    <Space wrap>
                        <span style={{ color: '#555' }}>Cut1 Drop (cents)</span>
                        <InputNumber min={0} max={20} step={1} value={stoplossCut1DropCents} onChange={(v) => setStoplossCut1DropCents(Math.max(0, Math.floor(Number(v))))} />
                        <span style={{ color: '#555' }}>Sell %</span>
                        <InputNumber min={0} max={100} step={5} value={stoplossCut1SellPct} onChange={(v) => setStoplossCut1SellPct(Math.max(0, Math.min(100, Math.floor(Number(v)))))} />
                    </Space>
                    <Space wrap>
                        <span style={{ color: '#555' }}>Cut2 Drop (cents)</span>
                        <InputNumber min={0} max={50} step={1} value={stoplossCut2DropCents} onChange={(v) => setStoplossCut2DropCents(Math.max(0, Math.floor(Number(v))))} />
                        <span style={{ color: '#555' }}>Sell %</span>
                        <InputNumber min={0} max={100} step={5} value={stoplossCut2SellPct} onChange={(v) => setStoplossCut2SellPct(Math.max(0, Math.min(100, Math.floor(Number(v)))))} />
                    </Space>
                    <Space wrap>
                        <span style={{ color: '#555' }}>Spread Guard (cents)</span>
                        <InputNumber min={0} max={20} step={1} value={stoplossSpreadGuardCents} onChange={(v) => setStoplossSpreadGuardCents(Math.max(0, Math.floor(Number(v))))} />
                        <span style={{ color: '#555' }}>Min Sec To Exit</span>
                        <InputNumber min={0} max={180} step={5} value={stoplossMinSecToExit} onChange={(v) => setStoplossMinSecToExit(Math.max(0, Math.floor(Number(v))))} />
                    </Space>
                </Space>
            </Modal>
        </div>
    );
}

export default CryptoAll;
