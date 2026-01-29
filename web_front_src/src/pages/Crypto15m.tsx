import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, InputNumber, Table, Tag, Typography, Space, Alert } from 'antd';
import { PlayCircleOutlined, PauseCircleOutlined, ReloadOutlined, ShoppingCartOutlined, SafetyCertificateOutlined, DeleteOutlined } from '@ant-design/icons';
import axios from 'axios';

const { Title } = Typography;

const api = axios.create({
    baseURL: '/api',
    timeout: 120000,
});

function Crypto15m() {
    const [candidates, setCandidates] = useState<any[]>([]);
    const [status, setStatus] = useState<any>(null);
    const [health, setHealth] = useState<any>(null);
    const [history, setHistory] = useState<any[]>([]);
    const [autoRefresh, setAutoRefresh] = useState(true);
    const [hideRedeemHistory, setHideRedeemHistory] = useState(true);
    const [editing, setEditing] = useState(false);
    const [minProb, setMinProb] = useState<number>(0.9);
    const [expiresWithinSec, setExpiresWithinSec] = useState<number>(180);
    const [amountUsd, setAmountUsd] = useState<number>(1);
    const [actionLoading, setActionLoading] = useState(false);
    const timerRef = useRef<any>(null);
    const timerHistoryRef = useRef<any>(null);

    const toCents = (p: any) => (Number(p) * 100).toFixed(1) + 'c';

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
        } catch {
        }
    }, []);

    useEffect(() => {
        try {
            localStorage.setItem('crypto15m_settings_v1', JSON.stringify({ minProb, expiresWithinSec, amountUsd }));
        } catch {
        }
    }, [minProb, expiresWithinSec, amountUsd]);

    const fetchStatus = async () => {
        const res = await api.get('/group-arb/crypto15m/status');
        setStatus(res.data?.status);
    };

    const fetchCandidates = async () => {
        const res = await api.get('/group-arb/crypto15m/candidates', { params: { minProb, expiresWithinSec, limit: 20 } });
        const list = Array.isArray(res.data?.candidates) ? res.data.candidates : [];
        setCandidates((prev: any[]) => {
            const prevById = new Map(prev.map((x) => [String(x?.conditionId), x]));
            const next = list.map((x: any) => {
                const id = String(x?.conditionId);
                const old = prevById.get(id);
                if (!old) return x;
                return {
                    ...old,
                    prices: x.prices,
                    chosenIndex: x.chosenIndex,
                    chosenOutcome: x.chosenOutcome,
                    chosenPrice: x.chosenPrice,
                    meetsMinProb: x.meetsMinProb,
                    eligibleByExpiry: x.eligibleByExpiry,
                    secondsToExpire: x.secondsToExpire,
                    endDate: x.endDate,
                    symbol: x.symbol,
                };
            });
            const newIds = new Set(list.map((x: any) => String(x?.conditionId)));
            for (const x of prev) {
                const id = String(x?.conditionId);
                if (!newIds.has(id)) next.push(x);
            }
            return next;
        });
    };

    const fetchHistory = async () => {
        const res = await api.get('/group-arb/history', { params: { refresh: true, intervalMs: 1000, maxEntries: 20 } });
        const h = Array.isArray(res.data?.history) ? res.data.history : [];
        setHistory(h);
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

    const refreshAll = async () => {
        await Promise.all([fetchStatus(), fetchCandidates(), fetchHistory()]);
    };

    useEffect(() => {
        refreshAll();
    }, []);

    useEffect(() => {
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = setInterval(() => {
            if (!autoRefresh) return;
            if (editing) return;
            Promise.all([fetchStatus(), fetchCandidates()]).catch(() => {});
        }, 2000);
        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [autoRefresh, editing, minProb, expiresWithinSec]);

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
    }, [autoRefresh, editing]);

    const onStart = async () => {
        setActionLoading(true);
        try {
            await api.post('/group-arb/crypto15m/auto/start', { amountUsd, minProb, expiresWithinSec });
            await refreshAll();
        } finally {
            setActionLoading(false);
        }
    };

    const onStop = async () => {
        setActionLoading(true);
        try {
            await api.post('/group-arb/crypto15m/auto/stop');
            await refreshAll();
        } finally {
            setActionLoading(false);
        }
    };

    const onBid = async (row: any) => {
        setActionLoading(true);
        try {
            await api.post('/group-arb/crypto15m/order', {
                conditionId: row.conditionId,
                outcomeIndex: row.chosenIndex,
                amountUsd,
                minPrice: minProb,
            });
            await refreshAll();
        } finally {
            setActionLoading(false);
        }
    };

    const onResetActive = async () => {
        setActionLoading(true);
        try {
            await api.post('/group-arb/crypto15m/active/reset');
            await refreshAll();
        } finally {
            setActionLoading(false);
        }
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
                    return (
                        <Space direction="vertical" size={2}>
                            <div style={{ color: '#ddd' }}>{o[0]}: {toCents(p[0])}</div>
                            <div style={{ color: '#ddd' }}>{o[1]}: {toCents(p[1])}</div>
                        </Space>
                    );
                },
            },
            {
                title: 'Pick',
                key: 'pick',
                width: 140,
                render: (_: any, r: any) => (
                    <Tag color={r.meetsMinProb ? 'green' : 'default'}>{String(r.chosenOutcome)} {toCents(r.chosenPrice)}</Tag>
                ),
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
                        loading={actionLoading}
                    >
                        Bid ${amountUsd}
                    </Button>
                ),
            },
        ];
    }, [amountUsd, status?.actives, actionLoading, minProb]);

    const historyColumns = useMemo(() => {
        return [
            { title: 'Time', dataIndex: 'timestamp', key: 'timestamp', width: 190, render: (v: any) => String(v || '').replace('T', ' ').replace('Z', '') },
            { title: 'Mode', dataIndex: 'mode', key: 'mode', width: 90, render: (v: any) => <Tag>{String(v || '')}</Tag> },
            { title: 'Action', dataIndex: 'action', key: 'action', width: 140, render: (v: any) => <Tag color="purple">{String(v || '')}</Tag> },
            { title: 'Symbol', dataIndex: 'symbol', key: 'symbol', width: 90, render: (v: any) => <Tag color="blue">{String(v || '').toUpperCase()}</Tag> },
            { title: 'Outcome', dataIndex: 'outcome', key: 'outcome', width: 110, render: (v: any) => String(v || '') },
            { title: 'Price', dataIndex: 'price', key: 'price', width: 90, render: (v: any) => (v != null ? toCents(v) : '-') },
            { title: 'Remark', dataIndex: 'marketQuestion', key: 'marketQuestion', render: (v: any) => String(v || '') },
        ];
    }, []);

    return (
        <div>
            <Title level={3} style={{ color: '#fff', marginBottom: 16 }}>
                ⏱️ 15mins Crypto Trade
            </Title>

            <Card style={{ marginBottom: 16, background: '#1f1f1f', border: '1px solid #333' }}>
                <Space wrap>
                    <span style={{ color: '#ddd' }}>Min Prob</span>
                    <InputNumber min={0.5} max={0.99} step={0.01} value={minProb} onChange={(v) => setMinProb(Number(v))} />
                    <span style={{ color: '#ddd' }}>Expire ≤ (sec)</span>
                    <InputNumber min={10} max={300} step={5} value={expiresWithinSec} onChange={(v) => setExpiresWithinSec(Number(v))} />
                    <span style={{ color: '#ddd' }}>Amount ($)</span>
                    <InputNumber
                        min={0.5}
                        max={50}
                        step={0.5}
                        value={amountUsd}
                        onFocus={() => setEditing(true)}
                        onBlur={() => setEditing(false)}
                        onChange={(v) => setAmountUsd(Number(v))}
                    />
                    <Button type="primary" icon={<PlayCircleOutlined />} onClick={onStart} loading={actionLoading} disabled={!!status?.enabled}>
                        Start Auto Trade
                    </Button>
                    <Button icon={<PauseCircleOutlined />} onClick={onStop} loading={actionLoading} disabled={!status?.enabled}>
                        Stop
                    </Button>
                    <Button icon={<ReloadOutlined />} onClick={refreshAll} loading={actionLoading}>
                        Refresh
                    </Button>
                    <Button onClick={() => setAutoRefresh((v) => !v)} type={autoRefresh ? 'primary' : 'default'}>
                        {autoRefresh ? 'Auto Refresh: ON' : 'Auto Refresh: OFF'}
                    </Button>
                    <Button onClick={() => setHideRedeemHistory((v) => !v)} type={hideRedeemHistory ? 'primary' : 'default'}>
                        {hideRedeemHistory ? 'History: Orders' : 'History: All'}
                    </Button>
                    <Button icon={<SafetyCertificateOutlined />} onClick={fetchHealth} loading={actionLoading}>
                        Health Check
                    </Button>
                    <Button danger icon={<DeleteOutlined />} onClick={onResetActive} loading={actionLoading}>
                        Reset Active
                    </Button>
                </Space>
                {status?.lastError ? (
                    <Alert style={{ marginTop: 12 }} type="error" message={String(status.lastError)} showIcon />
                ) : null}
                {status?.actives ? (
                    <Alert
                        style={{ marginTop: 12 }}
                        type="info"
                        message={`Active: ${Object.keys(status.actives).length ? Object.keys(status.actives).map((k) => `${k}:${toCents(status.actives[k]?.price)} ${status.actives[k]?.outcome || ''}`).join(' | ') : 'none'}`}
                        showIcon
                    />
                ) : null}
                {health?.relayer || health?.autoRedeem ? (
                    <Alert
                        style={{ marginTop: 12 }}
                        type="warning"
                        message={`Relayer: ${health?.relayer?.activeApiKey || '-'} • AutoRedeem: ${health?.autoRedeem?.config?.enabled ? 'ON' : 'OFF'} • InFlight: ${health?.autoRedeem?.inFlight?.count ?? '-'}`}
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
                <Table
                    rowKey={(r) => String(r.id)}
                    loading={false}
                    dataSource={hideRedeemHistory ? history.filter((x: any) => String(x?.action || '') !== 'redeem') : history}
                    columns={historyColumns as any}
                    pagination={false}
                    size="small"
                />
            </Card>
        </div>
    );
}

export default Crypto15m;
