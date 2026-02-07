import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Checkbox, InputNumber, Modal, Select, Space, Table, Tag, Tooltip, Typography, message } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import axios from 'axios';

const { Title } = Typography;

const api = axios.create({
    baseURL: '/api',
    timeout: 120000,
});

const SYMBOL_OPTIONS = [
    { label: 'BTC', value: 'BTC' },
    { label: 'ETH', value: 'ETH' },
    { label: 'SOL', value: 'SOL' },
    { label: 'XRP', value: 'XRP' },
];

const TF_OPTIONS = [
    { label: '15m', value: '15m' },
    { label: '1h', value: '1h' },
    { label: '4h', value: '4h' },
    { label: '1d', value: '1d' },
];

export default function CryptoAllV2Shared(props: { strategy: 'cryptoall' | 'cryptoall2'; title: string; storageKey: string }) {
    const { strategy, title, storageKey } = props;
    const [candidates, setCandidates] = useState<any[]>([]);
    const [status, setStatus] = useState<any>(null);
    const [watchdog, setWatchdog] = useState<any>(null);
    const [history, setHistory] = useState<any[]>([]);
    const [configEvents, setConfigEvents] = useState<any[]>([]);
    const [historySummary, setHistorySummary] = useState<any>(null);
    const [stoplossOpen, setStoplossOpen] = useState(false);
    const [stoplossHistory, setStoplossHistory] = useState<any[]>([]);
    const [stoplossSummary, setStoplossSummary] = useState<any>(null);
    const [stoplossLoading, setStoplossLoading] = useState(false);
    const [reportOpen, setReportOpen] = useState(false);
    const [reportLoading, setReportLoading] = useState(false);
    const [reportText, setReportText] = useState<string>('');
    const [bidLoadingId, setBidLoadingId] = useState<string | null>(null);
    const [refreshLoading, setRefreshLoading] = useState(false);
    const [startLoading, setStartLoading] = useState(false);
    const [stopLoading, setStopLoading] = useState(false);
    const [watchdogStartLoading, setWatchdogStartLoading] = useState(false);
    const [watchdogStopLoading, setWatchdogStopLoading] = useState(false);
    const [, setThresholdsLoading] = useState(false);
    const [thresholdsSaving, setThresholdsSaving] = useState(false);
    const [autoRefresh, setAutoRefresh] = useState(true);
    const [pollMs, setPollMs] = useState<number>(2000);
    const [minProb, setMinProb] = useState<number>(0.9);
    const [expiresWithinSec, setExpiresWithinSec] = useState<number>(180);
    const [amountUsd, setAmountUsd] = useState<number>(1);
    const [splitBuyEnabled, setSplitBuyEnabled] = useState<boolean>(false);
    const [splitBuyPct3m, setSplitBuyPct3m] = useState<number>(34);
    const [splitBuyPct2m, setSplitBuyPct2m] = useState<number>(33);
    const [splitBuyPct1m, setSplitBuyPct1m] = useState<number>(33);
    const [splitBuyTrendEnabled, setSplitBuyTrendEnabled] = useState<boolean>(true);
    const [splitBuyTrendMinutes3m, setSplitBuyTrendMinutes3m] = useState<number>(3);
    const [splitBuyTrendMinutes2m, setSplitBuyTrendMinutes2m] = useState<number>(2);
    const [splitBuyTrendMinutes1m, setSplitBuyTrendMinutes1m] = useState<number>(1);
    const [btcMinDelta, setBtcMinDelta] = useState<number>(600);
    const [ethMinDelta, setEthMinDelta] = useState<number>(30);
    const [solMinDelta, setSolMinDelta] = useState<number>(0.8);
    const [xrpMinDelta, setXrpMinDelta] = useState<number>(0.0065);
    const [symbols, setSymbols] = useState<string[]>(['BTC', 'ETH', 'SOL', 'XRP']);
    const [showSkipped, setShowSkipped] = useState(false);
    const [dojiGuardEnabled, setDojiGuardEnabled] = useState<boolean>(true);
    const [riskSkipScore, setRiskSkipScore] = useState<number>(70);

    const [stoplossEnabled, setStoplossEnabled] = useState<boolean>(false);
    const [stoplossCut1DropCents, setStoplossCut1DropCents] = useState<number>(1);
    const [stoplossCut1SellPct, setStoplossCut1SellPct] = useState<number>(50);
    const [stoplossCut2DropCents, setStoplossCut2DropCents] = useState<number>(2);
    const [stoplossCut2SellPct, setStoplossCut2SellPct] = useState<number>(100);
    const [stoplossMinSecToExit, setStoplossMinSecToExit] = useState<number>(25);
    const [adaptiveDeltaEnabled, setAdaptiveDeltaEnabled] = useState<boolean>(true);
    const [adaptiveDeltaBigMoveMultiplier, setAdaptiveDeltaBigMoveMultiplier] = useState<number>(2);
    const [adaptiveDeltaRevertNoBuyCount, setAdaptiveDeltaRevertNoBuyCount] = useState<number>(4);
    const [matrixOpen, setMatrixOpen] = useState(false);
    const [settingsHydrated, setSettingsHydrated] = useState(false);

    const timerRef = useRef<any>(null);
    const candidatesSigRef = useRef<string>('');

    useEffect(() => {
        try {
            const raw = localStorage.getItem(storageKey);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (parsed?.minProb != null) setMinProb(Number(parsed.minProb));
            if (parsed?.expiresWithinSec != null) setExpiresWithinSec(Number(parsed.expiresWithinSec));
            if (parsed?.amountUsd != null) setAmountUsd(Number(parsed.amountUsd));
            if (parsed?.splitBuyEnabled != null) setSplitBuyEnabled(!!parsed.splitBuyEnabled);
            if (parsed?.splitBuyPct3m != null) setSplitBuyPct3m(Number(parsed.splitBuyPct3m));
            if (parsed?.splitBuyPct2m != null) setSplitBuyPct2m(Number(parsed.splitBuyPct2m));
            if (parsed?.splitBuyPct1m != null) setSplitBuyPct1m(Number(parsed.splitBuyPct1m));
            if (parsed?.splitBuyTrendEnabled != null) setSplitBuyTrendEnabled(!!parsed.splitBuyTrendEnabled);
            if (parsed?.splitBuyTrendMinutes3m != null) setSplitBuyTrendMinutes3m(Number(parsed.splitBuyTrendMinutes3m));
            if (parsed?.splitBuyTrendMinutes2m != null) setSplitBuyTrendMinutes2m(Number(parsed.splitBuyTrendMinutes2m));
            if (parsed?.splitBuyTrendMinutes1m != null) setSplitBuyTrendMinutes1m(Number(parsed.splitBuyTrendMinutes1m));
            if (parsed?.pollMs != null) setPollMs(Number(parsed.pollMs));
            if (Array.isArray(parsed?.symbols)) setSymbols(parsed.symbols.map((x: any) => String(x || '').toUpperCase()).filter(Boolean));
            if (parsed?.showSkipped != null) setShowSkipped(!!parsed.showSkipped);
            if (parsed?.dojiGuardEnabled != null) setDojiGuardEnabled(!!parsed.dojiGuardEnabled);
            if (parsed?.riskSkipScore != null) setRiskSkipScore(Number(parsed.riskSkipScore));
            if (parsed?.btcMinDelta != null) setBtcMinDelta(Number(parsed.btcMinDelta));
            if (parsed?.ethMinDelta != null) setEthMinDelta(Number(parsed.ethMinDelta));
            if (parsed?.solMinDelta != null) setSolMinDelta(Number(parsed.solMinDelta));
            if (parsed?.xrpMinDelta != null) setXrpMinDelta(Number(parsed.xrpMinDelta));
            if (parsed?.autoRefresh != null) setAutoRefresh(!!parsed.autoRefresh);
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
    }, [storageKey]);

    useEffect(() => {
        if (!settingsHydrated) return;
        try {
            localStorage.setItem(storageKey, JSON.stringify({
                minProb,
                expiresWithinSec,
                amountUsd,
                splitBuyEnabled,
                splitBuyPct3m,
                splitBuyPct2m,
                splitBuyPct1m,
                splitBuyTrendEnabled,
                splitBuyTrendMinutes3m,
                splitBuyTrendMinutes2m,
                splitBuyTrendMinutes1m,
                pollMs,
                symbols,
                showSkipped,
                dojiGuardEnabled,
                riskSkipScore,
                btcMinDelta,
                ethMinDelta,
                solMinDelta,
                xrpMinDelta,
                autoRefresh,
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
    }, [settingsHydrated, storageKey, minProb, expiresWithinSec, amountUsd, splitBuyEnabled, splitBuyPct3m, splitBuyPct2m, splitBuyPct1m, splitBuyTrendEnabled, splitBuyTrendMinutes3m, splitBuyTrendMinutes2m, splitBuyTrendMinutes1m, pollMs, symbols, showSkipped, dojiGuardEnabled, riskSkipScore, btcMinDelta, ethMinDelta, solMinDelta, xrpMinDelta, autoRefresh, stoplossEnabled, stoplossCut1DropCents, stoplossCut1SellPct, stoplossCut2DropCents, stoplossCut2SellPct, stoplossMinSecToExit, adaptiveDeltaEnabled, adaptiveDeltaBigMoveMultiplier, adaptiveDeltaRevertNoBuyCount]);

    const autoSummary = useMemo(() => {
        const parts = [
            status?.enabled === true ? 'AUTO=ON' : 'AUTO=OFF',
            `poll=${pollMs}ms`,
            `minProb=${minProb}`,
            `exp≤${expiresWithinSec}s`,
            `usd=${amountUsd}`,
            `symbols=${(symbols || []).join(',')}`,
            splitBuyEnabled ? `split=ON(${splitBuyPct3m}/${splitBuyPct2m}/${splitBuyPct1m})` : 'split=OFF',
            dojiGuardEnabled ? `doji=ON(skip≥${riskSkipScore})` : 'doji=OFF',
            stoplossEnabled != null ? `stoploss=${stoplossEnabled ? 'ON' : 'OFF'}` : null,
            adaptiveDeltaEnabled != null ? `adaptiveΔ=${adaptiveDeltaEnabled ? 'ON' : 'OFF'}` : null,
        ].filter(Boolean);
        return parts.join(' • ');
    }, [status, pollMs, minProb, expiresWithinSec, amountUsd, symbols, splitBuyEnabled, splitBuyPct3m, splitBuyPct2m, splitBuyPct1m, dojiGuardEnabled, riskSkipScore, stoplossEnabled, adaptiveDeltaEnabled]);

    const fetchStatus = async () => {
        const res = await api.get(`/group-arb/${strategy}/status`);
        const data = res.data || null;
        setStatus(data?.status ?? data);
    };

    const fetchWatchdog = async () => {
        const r = await api.get('/group-arb/crypto15m/watchdog/status');
        const data = r.data || null;
        setWatchdog(data?.status ?? data);
    };

    const onOpenReport = async () => {
        setReportOpen(true);
        setReportLoading(true);
        try {
            const r = await api.get('/group-arb/crypto15m/watchdog/report/latest');
            const md = r.data?.md ?? '';
            const json = r.data?.json ?? null;
            setReportText(md || (json ? JSON.stringify(json, null, 2) : ''));
        } finally {
            setReportLoading(false);
        }
    };

    const fetchCandidates = async () => {
        const res = await api.get(`/group-arb/${strategy}/candidates`, {
            params: {
                symbols: symbols.join(','),
                minProb,
                expiresWithinSec,
                limit: 40,
            }
        });
        const list = Array.isArray(res.data?.candidates) ? res.data.candidates : [];
        const sig = (list || []).slice(0, 120).map((c: any) => `${c?.conditionId || ''}|${c?.secondsToExpire ?? ''}|${c?.upPrice ?? ''}|${c?.downPrice ?? ''}|${c?.chosenOutcome ?? ''}|${c?.chosenPrice ?? ''}|${c?.riskState ?? ''}|${c?.riskScore ?? ''}`).join(';');
        if (candidatesSigRef.current !== sig) {
            candidatesSigRef.current = sig;
            setCandidates(list);
        }
    };

    const fetchHistory = async () => {
        const res = await api.get(`/group-arb/${strategy}/history`, { params: { refresh: true, intervalMs: 1000, maxEntries: 50, includeSkipped: showSkipped } });
        const h = Array.isArray(res.data?.history) ? res.data.history : [];
        setHistory(h.map((x: any) => ({ ...x, strategy })));
        setHistorySummary(res.data?.summary || null);
        setConfigEvents(Array.isArray(res.data?.configEvents) ? res.data.configEvents : []);
    };

    const fetchStoplossHistory = async () => {
        setStoplossLoading(true);
        try {
            const res = await api.get(`/group-arb/${strategy}/stoploss/history`, { params: { maxEntries: 200 } });
            const h = Array.isArray(res.data?.history) ? res.data.history : [];
            setStoplossHistory(h);
            setStoplossSummary(res.data?.summary || null);
        } finally {
            setStoplossLoading(false);
        }
    };

    const onOpenStoploss = async () => {
        setStoplossOpen(true);
        await fetchStoplossHistory().catch(() => {});
    };

    const onPersistConfig = async () => {
        setThresholdsSaving(true);
        try {
            await api.post(`/group-arb/${strategy}/config`, {
                pollMs,
                expiresWithinSec,
                minProb,
                amountUsd,
                splitBuyEnabled,
                splitBuyPct3m,
                splitBuyPct2m,
                splitBuyPct1m,
                splitBuyTrendEnabled,
                splitBuyTrendMinutes3m,
                splitBuyTrendMinutes2m,
                splitBuyTrendMinutes1m,
                symbols,
                dojiGuardEnabled,
                riskSkipScore,
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
            message.success('Saved');
        } finally {
            setThresholdsSaving(false);
        }
    };

    const onStart = async () => {
        setStartLoading(true);
        try {
            const res = await api.post(`/group-arb/${strategy}/auto/start`, {
                pollMs,
                expiresWithinSec,
                minProb,
                amountUsd,
                splitBuyEnabled,
                splitBuyPct3m,
                splitBuyPct2m,
                splitBuyPct1m,
                splitBuyTrendEnabled,
                splitBuyTrendMinutes3m,
                splitBuyTrendMinutes2m,
                splitBuyTrendMinutes1m,
                symbols,
                dojiGuardEnabled,
                riskSkipScore,
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
            setStatus(res.data || null);
        } finally {
            setStartLoading(false);
        }
    };

    const onStop = async () => {
        setStopLoading(true);
        try {
            const res = await api.post(`/group-arb/${strategy}/auto/stop`, {});
            setStatus(res.data || null);
        } finally {
            setStopLoading(false);
        }
    };

    const onQuickRefresh = async () => {
        setRefreshLoading(true);
        try {
            await Promise.all([
                fetchStatus(),
                fetchCandidates(),
                fetchHistory(),
                fetchWatchdog(),
            ]);
        } finally {
            setRefreshLoading(false);
        }
    };

    const onSaveThresholds = async () => {
        setThresholdsSaving(true);
        try {
            await api.post(`/group-arb/${strategy}/delta-thresholds`, {
                btcMinDelta,
                ethMinDelta,
                solMinDelta,
                xrpMinDelta,
            });
            message.success('Saved');
        } finally {
            setThresholdsSaving(false);
        }
    };

    const fetchThresholds = async () => {
        setThresholdsLoading(true);
        try {
            const res = await api.get(`/group-arb/${strategy}/delta-thresholds`);
            const t = res.data?.thresholds || {};
            if (t.btcMinDelta != null) setBtcMinDelta(Number(t.btcMinDelta));
            if (t.ethMinDelta != null) setEthMinDelta(Number(t.ethMinDelta));
            if (t.solMinDelta != null) setSolMinDelta(Number(t.solMinDelta));
            if (t.xrpMinDelta != null) setXrpMinDelta(Number(t.xrpMinDelta));
        } finally {
            setThresholdsLoading(false);
        }
    };

    const onStartWatchdog = async () => {
        setWatchdogStartLoading(true);
        try {
            await api.post('/group-arb/crypto15m/watchdog/start', { durationHours: 12, pollMs: 30000 });
            await fetchWatchdog();
        } finally {
            setWatchdogStartLoading(false);
        }
    };

    const onStopWatchdog = async () => {
        setWatchdogStopLoading(true);
        try {
            await api.post('/group-arb/crypto15m/watchdog/stop', { reason: 'manual_ui_stop', stopAuto: false });
            await fetchWatchdog();
        } finally {
            setWatchdogStopLoading(false);
        }
    };

    const onBid = async (row: any) => {
        const conditionId = String(row?.conditionId || '');
        if (!conditionId) return;
        const outcomeIndex = row?.chosenIndex != null ? Number(row.chosenIndex) : (row?.chosenOutcome === 'Down' ? 1 : 0);
        setBidLoadingId(conditionId);
        try {
            await api.post(`/group-arb/${strategy}/order`, {
                conditionId,
                outcomeIndex,
                amountUsd,
                minPrice: minProb,
                splitBuyEnabled,
                splitBuyPct3m,
                splitBuyPct2m,
                splitBuyPct1m,
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
            message.success('Order placed');
            await fetchHistory().catch(() => {});
        } finally {
            setBidLoadingId(null);
        }
    };

    useEffect(() => {
        onQuickRefresh().catch(() => {});
        fetchThresholds().catch(() => {});
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = setInterval(() => {
            if (!autoRefresh) return;
            fetchStatus().catch(() => {});
            fetchCandidates().catch(() => {});
            fetchHistory().catch(() => {});
            fetchWatchdog().catch(() => {});
        }, Math.max(1500, Math.min(60_000, pollMs)));
        return () => {
            try { if (timerRef.current) clearInterval(timerRef.current); } catch {}
        };
    }, [autoRefresh, pollMs, strategy]);

    const columns = useMemo(() => {
        return [
            { title: 'Symbol', dataIndex: 'symbol', key: 'symbol', width: 85, render: (v: any) => <Tag>{String(v || '-')}</Tag> },
            { title: 'TF', dataIndex: 'timeframe', key: 'timeframe', width: 70, render: (v: any) => <Tag>{String(v || '15m')}</Tag> },
            { title: 'Expire(s)', dataIndex: 'secondsToExpire', key: 'secondsToExpire', width: 95, render: (v: any) => <Tag color={Number(v) <= 60 ? 'red' : Number(v) <= 180 ? 'orange' : 'green'}>{Number(v) || 0}</Tag> },
            { title: 'Pick', dataIndex: 'chosenOutcome', key: 'chosenOutcome', width: 70, render: (v: any) => <Tag color={String(v) === 'Down' ? 'red' : 'green'}>{String(v || '-')}</Tag> },
            { title: 'Price', dataIndex: 'chosenPrice', key: 'chosenPrice', width: 85, render: (v: any) => <Tag>{v != null ? Number(v).toFixed(4) : '-'}</Tag> },
            { title: 'Δ', dataIndex: 'deltaAbs', key: 'deltaAbs', width: 85, render: (v: any) => <Tag>{v != null ? Number(v).toFixed(4) : '-'}</Tag> },
            { title: 'Risk', dataIndex: 'riskScore', key: 'riskScore', width: 85, render: (v: any) => <Tag color={Number(v) >= 70 ? 'red' : Number(v) >= 50 ? 'orange' : 'green'}>{v != null ? Number(v) : '-'}</Tag> },
            {
                title: 'Actions',
                key: 'actions',
                width: 140,
                render: (_: any, row: any) => (
                    <Space>
                        <Button size="small" loading={bidLoadingId === String(row?.conditionId || '')} onClick={() => onBid(row)}>Bid</Button>
                        <Tooltip title={String(row?.conditionId || '')}><Tag>ID</Tag></Tooltip>
                    </Space>
                )
            }
        ];
    }, [bidLoadingId, amountUsd, minProb, expiresWithinSec, stoplossEnabled, stoplossCut1DropCents, stoplossCut1SellPct, stoplossCut2DropCents, stoplossCut2SellPct, stoplossMinSecToExit, splitBuyEnabled, splitBuyPct3m, splitBuyPct2m, splitBuyPct1m, adaptiveDeltaEnabled, adaptiveDeltaBigMoveMultiplier, adaptiveDeltaRevertNoBuyCount]);

    return (
        <div style={{ padding: 16 }}>
            <Space direction="vertical" style={{ width: '100%' }} size={12}>
                <Card bodyStyle={{ background: '#111', color: '#fff' }}>
                    <Space style={{ width: '100%', justifyContent: 'space-between' }} align="start">
                        <div>
                            <Title level={3} style={{ color: '#fff', marginTop: 0 }}>{title}</Title>
                            <div style={{ opacity: 0.8 }}>{autoSummary}</div>
                            <div style={{ marginTop: 8 }}>
                                <Space wrap>
                                    <Tag color={status?.enabled === true ? 'green' : 'red'}>Auto: {status?.enabled === true ? 'ON' : 'OFF'}</Tag>
                                    {typeof status?.hasValidKey === 'boolean' ? <Tag color={status?.hasValidKey ? 'green' : 'red'}>Key: {status?.hasValidKey ? 'OK' : 'MISSING'}</Tag> : null}
                                    {status?.trading ? (
                                        <>
                                            <Tag color={status.trading.initialized === true ? 'green' : 'orange'}>Trading: {status.trading.initialized === true ? 'OK' : 'INIT'}</Tag>
                                            <Tag color={status.trading.hasCredentials === true ? 'green' : 'red'}>Creds: {status.trading.hasCredentials === true ? 'OK' : 'MISSING'}</Tag>
                                            {status.trading.lastInitError ? <Tag color="red">{String(status.trading.lastInitError).slice(0, 80)}</Tag> : null}
                                        </>
                                    ) : null}
                                    <Tag color={watchdog?.running === true ? 'green' : 'default'}>Watchdog: {watchdog?.running === true ? 'ON' : 'OFF'}</Tag>
                                    {status?.lastError ? <Tag color="red">{String(status.lastError).slice(0, 80)}</Tag> : null}
                                    {status?.lastScanAt ? <Tag>LastScan: {String(status.lastScanAt || '-')}</Tag> : null}
                                    {historySummary?.count != null ? <Tag color="blue">History: {Number(historySummary.count || 0)}</Tag> : null}
                                    {status?.adaptiveDelta ? ['BTC', 'ETH', 'SOL', 'XRP'].map((sym) => {
                                        const s = (status?.adaptiveDelta || {})[sym] || null;
                                        if (!s) return null;
                                        const base = s.baseMinDelta != null ? Number(s.baseMinDelta) : null;
                                        const ov = s.overrideMinDelta != null ? Number(s.overrideMinDelta) : null;
                                        if (base == null) return null;
                                        return <Tag key={`ad-${sym}`} color={ov != null ? 'gold' : 'default'}>{sym} Δ {ov != null ? `${base}→${ov}` : String(base)}</Tag>;
                                    }) : null}
                                </Space>
                            </div>
                        </div>
                        <Space>
                            <Button icon={<ReloadOutlined />} onClick={onQuickRefresh} loading={refreshLoading}>Refresh</Button>
                            <Button onClick={onPersistConfig} loading={thresholdsSaving}>Save</Button>
                            <Button type="primary" onClick={onStart} loading={startLoading} disabled={status?.enabled === true}>Start</Button>
                            <Button danger onClick={onStop} loading={stopLoading} disabled={status?.enabled !== true}>Stop</Button>
                        </Space>
                    </Space>
                </Card>

                <Card title="Settings">
                    <Space wrap>
                        <Tooltip title="Poll interval (ms)">
                            <InputNumber min={500} step={100} value={pollMs} onChange={(v) => setPollMs(Math.max(500, Math.floor(Number(v) || 2000)))} />
                        </Tooltip>
                        <Tooltip title="Min probability">
                            <InputNumber min={0} max={1} step={0.01} value={minProb} onChange={(v) => setMinProb(Math.max(0, Math.min(1, Number(v) || 0.9)))} />
                        </Tooltip>
                        <Tooltip title="Seconds to expiry (<=)">
                            <InputNumber min={10} max={9999} step={1} value={expiresWithinSec} onChange={(v) => setExpiresWithinSec(Math.max(10, Math.floor(Number(v) || 180)))} />
                        </Tooltip>
                        <Tooltip title="Amount USD per entry">
                            <InputNumber min={1} max={5000} step={1} value={amountUsd} onChange={(v) => setAmountUsd(Math.max(1, Number(v) || 1))} />
                        </Tooltip>
                        <Tooltip title="Symbols">
                            <Select mode="multiple" style={{ minWidth: 240 }} value={symbols} options={SYMBOL_OPTIONS} onChange={(v) => setSymbols(Array.isArray(v) ? v : [])} />
                        </Tooltip>
                        <Tooltip title="Show skipped history entries">
                            <Checkbox checked={showSkipped} onChange={(e) => setShowSkipped(e.target.checked)}>Show skipped</Checkbox>
                        </Tooltip>
                        <Tooltip title="Auto refresh UI">
                            <Checkbox checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)}>Auto refresh</Checkbox>
                        </Tooltip>
                    </Space>
                    <div style={{ marginTop: 12 }}>
                        <Space wrap>
                            <Checkbox checked={dojiGuardEnabled} onChange={(e) => setDojiGuardEnabled(e.target.checked)}>DojiGuard</Checkbox>
                            <Tooltip title="Skip if riskScore >= this">
                                <InputNumber min={0} max={100} step={1} value={riskSkipScore} onChange={(v) => setRiskSkipScore(Math.max(0, Math.min(100, Math.floor(Number(v) || 70))))} />
                            </Tooltip>
                            <Checkbox checked={splitBuyEnabled} onChange={(e) => setSplitBuyEnabled(e.target.checked)}>Split Buy</Checkbox>
                            <InputNumber min={0} max={1000} step={1} value={splitBuyPct3m} onChange={(v) => setSplitBuyPct3m(Math.max(0, Math.min(1000, Math.floor(Number(v) || 0))))} />
                            <InputNumber min={0} max={1000} step={1} value={splitBuyPct2m} onChange={(v) => setSplitBuyPct2m(Math.max(0, Math.min(1000, Math.floor(Number(v) || 0))))} />
                            <InputNumber min={0} max={1000} step={1} value={splitBuyPct1m} onChange={(v) => setSplitBuyPct1m(Math.max(0, Math.min(1000, Math.floor(Number(v) || 0))))} />
                            <Checkbox checked={splitBuyTrendEnabled} onChange={(e) => setSplitBuyTrendEnabled(e.target.checked)}>Trend gate</Checkbox>
                            <InputNumber min={1} max={10} step={1} value={splitBuyTrendMinutes3m} onChange={(v) => setSplitBuyTrendMinutes3m(Math.max(1, Math.min(10, Math.floor(Number(v) || 3))))} />
                            <InputNumber min={1} max={10} step={1} value={splitBuyTrendMinutes2m} onChange={(v) => setSplitBuyTrendMinutes2m(Math.max(1, Math.min(10, Math.floor(Number(v) || 2))))} />
                            <InputNumber min={1} max={10} step={1} value={splitBuyTrendMinutes1m} onChange={(v) => setSplitBuyTrendMinutes1m(Math.max(1, Math.min(10, Math.floor(Number(v) || 1))))} />
                        </Space>
                    </div>
                    <div style={{ marginTop: 12 }}>
                        <Space wrap>
                            <Checkbox checked={stoplossEnabled} onChange={(e) => setStoplossEnabled(e.target.checked)}>CutLoss</Checkbox>
                            <InputNumber min={0} max={50} step={1} value={stoplossCut1DropCents} onChange={(v) => setStoplossCut1DropCents(Math.max(0, Math.min(50, Math.floor(Number(v) || 0))))} />
                            <InputNumber min={0} max={100} step={1} value={stoplossCut1SellPct} onChange={(v) => setStoplossCut1SellPct(Math.max(0, Math.min(100, Math.floor(Number(v) || 0))))} />
                            <InputNumber min={0} max={50} step={1} value={stoplossCut2DropCents} onChange={(v) => setStoplossCut2DropCents(Math.max(0, Math.min(50, Math.floor(Number(v) || 0))))} />
                            <InputNumber min={0} max={100} step={1} value={stoplossCut2SellPct} onChange={(v) => setStoplossCut2SellPct(Math.max(0, Math.min(100, Math.floor(Number(v) || 0))))} />
                            <InputNumber min={0} max={600} step={1} value={stoplossMinSecToExit} onChange={(v) => setStoplossMinSecToExit(Math.max(0, Math.min(600, Math.floor(Number(v) || 0))))} />
                            <Checkbox checked={adaptiveDeltaEnabled} onChange={(e) => setAdaptiveDeltaEnabled(e.target.checked)}>Adaptive Δ</Checkbox>
                            <InputNumber min={1} max={10} step={0.1} value={adaptiveDeltaBigMoveMultiplier} onChange={(v) => setAdaptiveDeltaBigMoveMultiplier(Math.max(1, Math.min(10, Number(v) || 2)))} />
                            <InputNumber min={1} max={50} step={1} value={adaptiveDeltaRevertNoBuyCount} onChange={(v) => setAdaptiveDeltaRevertNoBuyCount(Math.max(1, Math.min(50, Math.floor(Number(v) || 4))))} />
                        </Space>
                    </div>
                </Card>

                <Card title="Delta Thresholds">
                    <Space wrap>
                        <Tag>BTC</Tag>
                        <InputNumber min={0} step={1} value={btcMinDelta} onChange={(v) => setBtcMinDelta(Number(v) || 0)} />
                        <Tag>ETH</Tag>
                        <InputNumber min={0} step={0.1} value={ethMinDelta} onChange={(v) => setEthMinDelta(Number(v) || 0)} />
                        <Tag>SOL</Tag>
                        <InputNumber min={0} step={0.01} value={solMinDelta} onChange={(v) => setSolMinDelta(Number(v) || 0)} />
                        <Tag>XRP</Tag>
                        <InputNumber min={0} step={0.0001} value={xrpMinDelta} onChange={(v) => setXrpMinDelta(Number(v) || 0)} />
                        <Button onClick={onSaveThresholds} loading={thresholdsSaving}>Save thresholds</Button>
                    </Space>
                </Card>

                <Card title="Candidates" extra={<Space><Button onClick={() => setMatrixOpen(true)}>Matrix</Button><Button onClick={onOpenStoploss}>Stoploss</Button></Space>}>
                    <Table
                        rowKey={(r: any) => String(r?.conditionId || '') + ':' + String(r?.chosenTokenId || '')}
                        size="small"
                        columns={columns as any}
                        dataSource={candidates}
                        pagination={{ pageSize: 20 }}
                    />
                </Card>

                <Card title="History" extra={<Space><Button onClick={onOpenReport}>Report</Button><Button onClick={onStartWatchdog} loading={watchdogStartLoading} disabled={watchdog?.running === true}>{watchdog?.running ? 'Watchdog: ON' : 'Start Watchdog (12h)'}</Button><Button danger onClick={onStopWatchdog} loading={watchdogStopLoading} disabled={watchdog?.running !== true}>Stop Watchdog</Button></Space>}>
                    {configEvents.length ? (
                        <div style={{ marginBottom: 12 }}>
                            <Table
                                rowKey={(r: any) => String(r?.id || '')}
                                size="small"
                                dataSource={configEvents.slice(0, 20)}
                                pagination={false}
                                columns={[
                                    { title: 'At', dataIndex: 'timestamp', key: 'timestamp', width: 180, render: (v: any) => <Tag>{String(v || '-')}</Tag> },
                                    { title: 'Event', dataIndex: 'type', key: 'type', width: 180, render: (v: any) => <Tag>{String(v || '-')}</Tag> },
                                    { title: 'Reason', dataIndex: 'reason', key: 'reason', render: (v: any) => String(v || '-') },
                                ]}
                            />
                        </div>
                    ) : null}
                    <Space wrap style={{ marginBottom: 8 }}>
                        {historySummary ? <Tag>Total: {Number(historySummary.count || 0)}</Tag> : null}
                        {historySummary ? <Tag>Stake: {Number(historySummary.totalStakeUsd || 0).toFixed(2)}</Tag> : null}
                        {historySummary ? <Tag>PnL: {Number(historySummary.pnlTotalUsdc || 0).toFixed(4)}</Tag> : null}
                        {historySummary ? <Tag>W: {Number(historySummary.winCount || 0)}</Tag> : null}
                        {historySummary ? <Tag>L: {Number(historySummary.lossCount || 0)}</Tag> : null}
                        {historySummary ? <Tag>O: {Number(historySummary.openCount || 0)}</Tag> : null}
                    </Space>
                    <Table
                        rowKey={(r: any) => String(r?.id || '')}
                        size="small"
                        dataSource={history}
                        pagination={{ pageSize: 20 }}
                        columns={[
                            { title: 'At', dataIndex: 'timestamp', key: 'timestamp', width: 180, render: (v: any) => <Tag>{String(v || '-')}</Tag> },
                            { title: 'Action', dataIndex: 'action', key: 'action', width: 140, render: (v: any) => <Tag>{String(v || '-')}</Tag> },
                            { title: 'Symbol', dataIndex: 'symbol', key: 'symbol', width: 80, render: (v: any) => <Tag>{String(v || '-')}</Tag> },
                            { title: 'TF', dataIndex: 'timeframe', key: 'timeframe', width: 70, render: (v: any) => <Tag>{String(v || '15m')}</Tag> },
                            { title: 'Result', dataIndex: 'result', key: 'result', width: 80, render: (v: any) => <Tag color={String(v) === 'WIN' ? 'green' : String(v) === 'LOSS' ? 'red' : 'blue'}>{String(v || '-')}</Tag> },
                            { title: 'Stake', dataIndex: 'amountUsd', key: 'amountUsd', width: 90, render: (v: any) => <Tag>{Number(v || 0).toFixed(2)}</Tag> },
                            { title: 'PnL', dataIndex: 'realizedPnlUsdc', key: 'realizedPnlUsdc', width: 90, render: (v: any) => <Tag>{Number(v || 0).toFixed(4)}</Tag> },
                            { title: 'Cond', dataIndex: 'marketId', key: 'marketId', width: 180, render: (v: any) => <Tooltip title={String(v || '')}><Tag>id</Tag></Tooltip> },
                        ]}
                    />
                </Card>

                <Modal
                    title="Stoploss History"
                    open={stoplossOpen}
                    onCancel={() => setStoplossOpen(false)}
                    footer={<Space><Button onClick={() => fetchStoplossHistory()} loading={stoplossLoading}>Refresh</Button><Button onClick={() => setStoplossOpen(false)}>Close</Button></Space>}
                    width={1100}
                >
                    <Space wrap style={{ marginBottom: 10 }}>
                        {stoplossSummary ? <Tag>OK: {Number(stoplossSummary.successCount || 0)}</Tag> : null}
                        {stoplossSummary ? <Tag>Skip: {Number(stoplossSummary.skippedCount || 0)}</Tag> : null}
                        {stoplossSummary ? <Tag>Fail: {Number(stoplossSummary.failedCount || 0)}</Tag> : null}
                    </Space>
                    <Table
                        rowKey={(r: any) => String(r?.id || '')}
                        size="small"
                        loading={stoplossLoading}
                        dataSource={stoplossHistory}
                        pagination={{ pageSize: 20 }}
                        columns={[
                            { title: 'At', dataIndex: 'timestamp', key: 'timestamp', width: 180, render: (v: any) => <Tag>{String(v || '-')}</Tag> },
                            { title: 'Symbol', dataIndex: 'symbol', key: 'symbol', width: 80, render: (v: any) => <Tag>{String(v || '-')}</Tag> },
                            { title: 'TF', dataIndex: 'timeframe', key: 'timeframe', width: 70, render: (v: any) => <Tag>{String(v || '15m')}</Tag> },
                            { title: 'Reason', dataIndex: 'reason', key: 'reason', width: 140, render: (v: any) => <Tag>{String(v || '-')}</Tag> },
                            { title: 'Sell', dataIndex: 'sellAmount', key: 'sellAmount', width: 120, render: (v: any) => <Tag>{v != null ? Number(v) : '-'}</Tag> },
                            { title: 'Sec', dataIndex: 'secondsToExpire', key: 'secondsToExpire', width: 90, render: (v: any) => <Tag>{v != null ? Number(v) : '-'}</Tag> },
                            { title: 'Entry', dataIndex: 'entryPrice', key: 'entryPrice', width: 90, render: (v: any) => <Tag>{v != null ? Number(v).toFixed(4) : '-'}</Tag> },
                            { title: 'Bid', dataIndex: 'currentBid', key: 'currentBid', width: 90, render: (v: any) => <Tag>{v != null ? Number(v).toFixed(4) : '-'}</Tag> },
                            { title: 'Ask', dataIndex: 'currentAsk', key: 'currentAsk', width: 90, render: (v: any) => <Tag>{v != null ? Number(v).toFixed(4) : '-'}</Tag> },
                            { title: 'OK', dataIndex: 'success', key: 'success', width: 60, render: (v: any) => <Tag color={v === true ? 'green' : 'red'}>{v === true ? 'Y' : 'N'}</Tag> },
                            { title: 'Skip', dataIndex: 'skipped', key: 'skipped', width: 60, render: (v: any) => <Tag color={v === true ? 'orange' : 'default'}>{v === true ? 'Y' : 'N'}</Tag> },
                            { title: 'Err', dataIndex: 'error', key: 'error', render: (v: any) => <span style={{ color: '#b00' }}>{String(v || '')}</span> },
                        ]}
                    />
                </Modal>

                <Modal title="Watchdog Report" open={reportOpen} onCancel={() => setReportOpen(false)} footer={<Button onClick={() => setReportOpen(false)}>Close</Button>} width={1000}>
                    <pre style={{ whiteSpace: 'pre-wrap' }}>{reportLoading ? 'Loading...' : reportText}</pre>
                </Modal>

                <Modal title="Matrix" open={matrixOpen} onCancel={() => setMatrixOpen(false)} footer={<Button onClick={() => setMatrixOpen(false)}>Close</Button>} width={1000}>
                    <Space wrap style={{ marginBottom: 12 }}>
                        {SYMBOL_OPTIONS.map((s) => <Tag key={s.value}>{s.value}</Tag>)}
                        {TF_OPTIONS.map((t) => <Tag key={t.value}>{t.value}</Tag>)}
                    </Space>
                    <Table
                        rowKey={(r: any) => String(r?.conditionId || '') + ':' + String(r?.chosenTokenId || '')}
                        size="small"
                        dataSource={candidates}
                        pagination={{ pageSize: 50 }}
                        columns={columns as any}
                    />
                </Modal>
            </Space>
        </div>
    );
}
