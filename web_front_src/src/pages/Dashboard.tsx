import { Card, Typography, Row, Col, Table, Tag, Button, Alert, Space, Switch, InputNumber, Tabs, Select, Input } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createChart } from 'lightweight-charts';
import api from '../api/client';
import { AccountContext } from '../account/AccountContext';

const { Title } = Typography;

type Range = '1D' | '1W' | '1M' | 'ALL';
type PnlMode = 'portfolio' | 'cashflow';
type StrategyFilter = 'all' | 'manual' | 'auto' | 'semi' | 'external';
type SourceFilter = 'all' | 'tool' | 'external';
type StatusFilter = 'all' | 'open' | 'filled' | 'canceled' | 'failed';

const fmtUsd = (v: any) => {
    const n = Number(v || 0);
    if (!Number.isFinite(n)) return '$0.00';
    return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
};

const eventUrlForMarket = (slug: string, eventSlug?: string) => {
    const s = String(slug || '');
    const e = String(eventSlug || '');
    if (s && e) return `https://polymarket.com/event/${e}/${s}`;
    if (!s) return '';
    const m = s.match(/^(.*-on-[a-z]+-\d{1,2})-/i);
    const groupSlug = m ? m[1] : s;
    return `https://polymarket.com/event/${groupSlug}/${s}`;
};

const bucketStatus = (raw: any): Exclude<StatusFilter, 'all'> => {
    const s = String(raw || '').toUpperCase();
    if (!s) return 'open';
    if (s.includes('CANCEL')) return 'canceled';
    if (s.includes('FAIL') || s.includes('REJECT')) return 'failed';
    if (s.includes('FILL') || s.includes('CONFIRM') || s.includes('MATCH')) return 'filled';
    return 'open';
};

export default function Dashboard() {
    const { activeAccountId, setActiveAccountId } = useContext(AccountContext);
    const [accounts, setAccounts] = useState<any[]>([]);
    const [accountsLoading, setAccountsLoading] = useState(false);
    const [createAccountName, setCreateAccountName] = useState('');
    const [renameAccountName, setRenameAccountName] = useState('');

    const [history, setHistory] = useState<any[]>([]);
    const [openOrders, setOpenOrders] = useState<any[]>([]);
    const [trades, setTrades] = useState<any[]>([]);
    const [portfolio, setPortfolio] = useState<any>(null);

    const [pnlMode, setPnlMode] = useState<PnlMode>('portfolio');
    const [range, setRange] = useState<Range>('1D');
    const [pnl, setPnl] = useState<any>(null);
    const [cashflow, setCashflow] = useState<any>(null);

    const [redeemStatus, setRedeemStatus] = useState<any>(null);
    const [autoRedeemEnabled, setAutoRedeemEnabled] = useState(false);
    const [autoRedeemMaxPerCycle, setAutoRedeemMaxPerCycle] = useState(20);
    const [relayerStatus, setRelayerStatus] = useState<any>(null);
    const [setupStatus, setSetupStatus] = useState<any>(null);
    const [setupPrivateKey, setSetupPrivateKey] = useState('');
    const [setupProxyAddress, setSetupProxyAddress] = useState('');
    const [setupSaveLoading, setSetupSaveLoading] = useState(false);
    const [setupSaveError, setSetupSaveError] = useState<string | null>(null);
    const [setupSaveSuccess, setSetupSaveSuccess] = useState<string | null>(null);
    const [builderKeys, setBuilderKeys] = useState<any[]>(() => {
        try {
            const k = `builder_relayer_keys_v1:${activeAccountId || 'default'}`;
            const raw = localStorage.getItem(k) || localStorage.getItem('builder_relayer_keys_v1');
            const parsed = raw ? JSON.parse(raw) : [];
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    });
    const [builderActiveIndex, setBuilderActiveIndex] = useState(0);
    const [relayerKeyLabel, setRelayerKeyLabel] = useState('');
    const [relayerApiKey, setRelayerApiKey] = useState('');
    const [relayerSecret, setRelayerSecret] = useState('');
    const [relayerPassphrase, setRelayerPassphrase] = useState('');
    const [relayerUrl, setRelayerUrl] = useState('https://relayer-v2.polymarket.com');
    const [relayerSaveLoading, setRelayerSaveLoading] = useState(false);
    const [relayerSaveError, setRelayerSaveError] = useState<string | null>(null);
    const [relayerSaveSuccess, setRelayerSaveSuccess] = useState<string | null>(null);

    const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
    const [strategyFilter, setStrategyFilter] = useState<StrategyFilter>('all');
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
    const [search, setSearch] = useState('');

    const [loadingPortfolio, setLoadingPortfolio] = useState(false);
    const [loadingHistory, setLoadingHistory] = useState(false);
    const [loadingOrders, setLoadingOrders] = useState(false);
    const [loadingTrades, setLoadingTrades] = useState(false);
    const [loadingPnl, setLoadingPnl] = useState(false);
    const [loadingCashflow, setLoadingCashflow] = useState(false);
    const [loadingRedeem, setLoadingRedeem] = useState(false);

    const pnlChartElRef = useRef<HTMLDivElement | null>(null);
    const pnlChartRef = useRef<any>(null);
    const pnlSeriesRef = useRef<any>(null);

    const accountPrefix = useMemo(() => (activeAccountId ? `/accounts/${activeAccountId}` : ''), [activeAccountId]);
    const apiPath = (p: string) => `${accountPrefix}${p}`;

    const fetchAccounts = async () => {
        setAccountsLoading(true);
        try {
            const res = await api.get('/accounts');
            const list = Array.isArray(res.data?.accounts) ? res.data.accounts : [];
            setAccounts(list);
            const ids = new Set(list.map((a: any) => String(a?.id || '').trim()).filter(Boolean));
            const nextActive = ids.has(activeAccountId) ? activeAccountId : (list[0]?.id ? String(list[0].id) : 'default');
            if (nextActive !== activeAccountId) setActiveAccountId(nextActive);
        } finally {
            setAccountsLoading(false);
        }
    };

    const createAccount = async () => {
        const name = String(createAccountName || '').trim();
        const res = await api.post('/accounts', { name: name || undefined });
        const acc = res.data?.account;
        await fetchAccounts();
        if (acc?.id) setActiveAccountId(String(acc.id));
        setCreateAccountName('');
    };

    const renameActiveAccount = async () => {
        const name = String(renameAccountName || '').trim();
        if (!name) return;
        await api.patch(`/accounts/${encodeURIComponent(activeAccountId)}`, { name });
        await fetchAccounts();
        setRenameAccountName('');
    };

    useEffect(() => {
        fetchAccounts();
    }, []);

    useEffect(() => {
        const acc = accounts.find((a: any) => String(a?.id || '') === String(activeAccountId || ''));
        if (acc?.name != null) setRenameAccountName(String(acc.name));
        try {
            const k = `builder_relayer_keys_v1:${activeAccountId || 'default'}`;
            const raw = localStorage.getItem(k) || (activeAccountId === 'default' ? localStorage.getItem('builder_relayer_keys_v1') : null);
            const parsed = raw ? JSON.parse(raw) : [];
            setBuilderKeys(Array.isArray(parsed) ? parsed : []);
        } catch {
            setBuilderKeys([]);
        }
    }, [activeAccountId, accounts]);

    const fetchPortfolio = async () => {
        setLoadingPortfolio(true);
        try {
            const res = await api.get(apiPath('/group-arb/portfolio-summary'), { params: { positionsLimit: 50 } });
            setPortfolio(res.data?.summary || null);
        } finally {
            setLoadingPortfolio(false);
        }
    };

    const fetchHistory = async () => {
        setLoadingHistory(true);
        try {
            const res = await api.get(apiPath('/group-arb/history'), { params: { refresh: true, intervalMs: 1000, maxEntries: 50 } });
            setHistory(Array.isArray(res.data.history) ? res.data.history : []);
        } finally {
            setLoadingHistory(false);
        }
    };

    const fetchOpenOrders = async () => {
        setLoadingOrders(true);
        try {
            const res = await api.get(apiPath('/group-arb/open-orders'));
            setOpenOrders(Array.isArray(res.data.orders) ? res.data.orders : []);
        } finally {
            setLoadingOrders(false);
        }
    };

    const fetchTrades = async () => {
        setLoadingTrades(true);
        try {
            const res = await api.get(apiPath('/group-arb/trades'));
            setTrades(Array.isArray(res.data.trades) ? res.data.trades : []);
        } finally {
            setLoadingTrades(false);
        }
    };

    const fetchPnl = async (r: Range) => {
        setLoadingPnl(true);
        try {
            const res = await api.get(apiPath('/group-arb/pnl'), { params: { range: r } });
            setPnl(res.data);
        } catch {
            setPnl(null);
        } finally {
            setLoadingPnl(false);
        }
    };

    const fetchCashflow = async (r: Range) => {
        setLoadingCashflow(true);
        try {
            const res = await api.get(apiPath('/group-arb/performance'), { params: { range: r } });
            setCashflow(res.data);
        } catch {
            setCashflow(null);
        } finally {
            setLoadingCashflow(false);
        }
    };

    const fetchRedeemStatus = async () => {
        setLoadingRedeem(true);
        try {
            const res = await api.get(apiPath('/group-arb/auto-redeem/status'));
            setRedeemStatus(res.data);
            const cfg = res.data?.status?.config;
            if (cfg) {
                setAutoRedeemEnabled(!!cfg.enabled);
                setAutoRedeemMaxPerCycle(Number(cfg.maxPerCycle || 20));
            }
        } catch {
            setRedeemStatus(null);
        } finally {
            setLoadingRedeem(false);
        }
    };

    const persistLocalBuilderKeys = (keys: any[]) => {
        try {
            const k = `builder_relayer_keys_v1:${activeAccountId || 'default'}`;
            localStorage.setItem(k, JSON.stringify(keys));
        } catch {
        }
    };

    const fetchRelayerStatus = async () => {
        try {
            const res = await api.get(apiPath('/group-arb/relayer/status'));
            const st = res.data?.status || null;
            setRelayerStatus(st);
            if (st?.relayerUrl) setRelayerUrl(String(st.relayerUrl));
            if (st?.activeIndex != null) setBuilderActiveIndex(Number(st.activeIndex));
        } catch {
            setRelayerStatus(null);
        }
    };

    const fetchSetupStatus = async () => {
        try {
            const res = await api.get(apiPath('/group-arb/setup/status'));
            const st = res.data?.status || null;
            setSetupStatus(st);
            if (st?.proxyAddress != null) setSetupProxyAddress(String(st.proxyAddress || ''));
        } catch {
            setSetupStatus(null);
        }
    };

    const saveSetup = async () => {
        setSetupSaveLoading(true);
        setSetupSaveError(null);
        setSetupSaveSuccess(null);
        try {
            const res = await api.post(apiPath('/group-arb/setup/config'), { privateKey: setupPrivateKey || undefined, proxyAddress: setupProxyAddress || undefined });
            setSetupStatus(res.data?.status || null);
            setSetupPrivateKey('');
            setSetupSaveSuccess('Saved and applied.');
            await Promise.all([fetchSetupStatus(), fetchPortfolio(), fetchRedeemStatus(), fetchHistory()]);
        } catch (e: any) {
            setSetupSaveError(e?.response?.data?.error || e?.message || String(e));
        } finally {
            setSetupSaveLoading(false);
        }
    };

    const saveRelayerKeys = async () => {
        setRelayerSaveLoading(true);
        setRelayerSaveError(null);
        setRelayerSaveSuccess(null);
        try {
            const nextKeys = [
                ...builderKeys,
                {
                    label: relayerKeyLabel || undefined,
                    apiKey: relayerApiKey,
                    secret: relayerSecret,
                    passphrase: relayerPassphrase,
                },
            ];
            const nextActive = nextKeys.length - 1;
            const res = await api.post(apiPath('/group-arb/relayer/config'), {
                keys: nextKeys,
                activeIndex: nextActive,
                relayerUrl: relayerUrl || undefined,
                persist: true,
                testRedeem: false,
            });
            const st = res.data?.status;
            setBuilderKeys(nextKeys);
            persistLocalBuilderKeys(nextKeys);
            if (st?.activeApiKey) {
                setRelayerSaveSuccess(`Active key: ${String(st.activeApiKey)}`);
            } else {
                setRelayerSaveSuccess('Relayer keys saved.');
            }
            setBuilderActiveIndex(nextActive);
            setRelayerApiKey('');
            setRelayerSecret('');
            setRelayerPassphrase('');
            setRelayerKeyLabel('');
            await Promise.all([fetchRelayerStatus(), fetchRedeemStatus(), fetchHistory(), fetchPortfolio()]);
        } catch (e: any) {
            setRelayerSaveError(e?.response?.data?.error || e?.message || String(e));
        } finally {
            setRelayerSaveLoading(false);
        }
    };

    const pushAllRelayerKeys = async (activeIndex?: number) => {
        setRelayerSaveLoading(true);
        setRelayerSaveError(null);
        setRelayerSaveSuccess(null);
        try {
            const res = await api.post(apiPath('/group-arb/relayer/config'), {
                keys: builderKeys,
                activeIndex: activeIndex != null ? activeIndex : builderActiveIndex,
                relayerUrl: relayerUrl || undefined,
                persist: true,
                testRedeem: false,
            });
            setRelayerSaveSuccess(`Saved. Active key: ${String(res.data?.status?.activeApiKey || '-')}`);
            await fetchRelayerStatus();
        } catch (e: any) {
            setRelayerSaveError(e?.response?.data?.error || e?.message || String(e));
        } finally {
            setRelayerSaveLoading(false);
        }
    };

    const removeRelayerKey = async (index: number) => {
        const next = builderKeys.filter((_: any, i: number) => i !== index);
        setBuilderKeys(next);
        persistLocalBuilderKeys(next);
        if (builderActiveIndex >= next.length) setBuilderActiveIndex(Math.max(0, next.length - 1));
        try {
            await api.post(apiPath('/group-arb/relayer/config'), { keys: next, activeIndex: Math.min(builderActiveIndex, Math.max(0, next.length - 1)), relayerUrl: relayerUrl || undefined, persist: true, testRedeem: false });
            await fetchRelayerStatus();
        } catch {
        }
    };

    const refreshAll = async () => {
        await Promise.all([fetchPortfolio(), fetchHistory(), fetchOpenOrders(), fetchTrades(), fetchRedeemStatus(), fetchRelayerStatus(), fetchSetupStatus()]);
        if (pnlMode === 'portfolio') await fetchPnl(range);
        else await fetchCashflow(range);
    };

    useEffect(() => {
        refreshAll();
        const t = setInterval(() => {
            fetchPortfolio();
            fetchOpenOrders();
            fetchTrades();
            fetchRedeemStatus();
            fetchRelayerStatus();
            fetchSetupStatus();
        }, 15000);
        return () => clearInterval(t);
    }, [activeAccountId]);

    useEffect(() => {
        if (!pnlChartElRef.current || pnlChartRef.current) return;
        const chart = createChart(pnlChartElRef.current, {
            height: 180,
            layout: { background: { color: 'transparent' }, textColor: '#E5E7EB' },
            grid: { vertLines: { color: 'rgba(255,255,255,0.06)' }, horzLines: { color: 'rgba(255,255,255,0.06)' } },
            rightPriceScale: { borderColor: 'rgba(255,255,255,0.12)' },
            timeScale: { borderColor: 'rgba(255,255,255,0.12)', timeVisible: true, secondsVisible: false },
            crosshair: { vertLine: { color: 'rgba(255,255,255,0.2)' }, horzLine: { color: 'rgba(255,255,255,0.2)' } },
        });
        const series = chart.addLineSeries({ color: '#3b82f6', lineWidth: 2 });
        pnlChartRef.current = chart;
        pnlSeriesRef.current = series;
        return () => {
            try { chart.remove(); } catch {}
            pnlChartRef.current = null;
            pnlSeriesRef.current = null;
        };
    }, []);

    useEffect(() => {
        if (!pnlSeriesRef.current) return;
        const series = pnl?.series || [];
        if (!Array.isArray(series) || series.length === 0) return;
        const data = series.map((p: any) => ({ time: Number(p.ts), value: Number(p.profitLoss ?? 0) }));
        pnlSeriesRef.current.setData(data);
    }, [pnl]);

    useEffect(() => {
        if (pnlMode === 'portfolio') fetchPnl(range);
        else fetchCashflow(range);
    }, [pnlMode, range]);

    const claimableCount = Number(portfolio?.claimableCount || 0);
    const positions = useMemo(() => (Array.isArray(portfolio?.positions) ? portfolio.positions : []), [portfolio]);

    const activityRows = useMemo(() => {
        return history.flatMap((entry) => {
            const mode = entry?.mode;
            const strategy = mode === 'manual' ? 'manual' : mode === 'auto' ? 'auto' : mode === 'semi' ? 'semi' : 'system';
            return (entry.results || []).map((r: any) => ({
                key: `${entry.id}-${r.orderId || r.conditionId || r.outcome}`,
                time: entry.timestamp,
                strategy,
                source: 'tool',
                marketId: entry.marketId,
                marketQuestion: entry.marketQuestion,
                slug: entry.slug,
                eventSlug: entry.eventSlug,
                outcome: r.outcome,
                success: !!r.success,
                orderId: r.orderId,
                orderStatus: r.orderStatus,
                filledSize: r.filledSize,
                error: r.error,
            }));
        });
    }, [history]);

    const filteredOpenOrders = useMemo(() => {
        const q = search.trim().toLowerCase();
        return openOrders.filter((r: any) => {
            const src = String(r.source || 'external') as SourceFilter;
            const strat = String(r.strategy || 'external') as StrategyFilter;
            const st = bucketStatus(r.status);
            if (sourceFilter !== 'all' && src !== sourceFilter) return false;
            if (strategyFilter !== 'all' && strat !== strategyFilter) return false;
            if (statusFilter !== 'all' && st !== statusFilter) return false;
            if (q) {
                const hay = [r.marketQuestion, r.marketId, r.slug, r.outcome, r.side, r.status, r.strategy, r.source];
                if (!hay.some((v: any) => String(v || '').toLowerCase().includes(q))) return false;
            }
            return true;
        });
    }, [openOrders, sourceFilter, strategyFilter, statusFilter, search]);

    const filteredTrades = useMemo(() => {
        const q = search.trim().toLowerCase();
        return trades.filter((r: any) => {
            const src = String(r.source || 'external') as SourceFilter;
            const strat = String(r.strategy || 'external') as StrategyFilter;
            const st = bucketStatus(r.status);
            if (sourceFilter !== 'all' && src !== sourceFilter) return false;
            if (strategyFilter !== 'all' && strat !== strategyFilter) return false;
            if (statusFilter !== 'all' && st !== statusFilter) return false;
            if (q) {
                const hay = [r.title, r.marketId, r.slug, r.outcome, r.side, r.status, r.strategy, r.source];
                if (!hay.some((v: any) => String(v || '').toLowerCase().includes(q))) return false;
            }
            return true;
        });
    }, [trades, sourceFilter, strategyFilter, statusFilter, search]);

    const filteredHistory = useMemo(() => {
        const q = search.trim().toLowerCase();
        return activityRows.filter((r: any) => {
            const strat = String(r.strategy || 'system') as StrategyFilter;
            const st: any = r.success ? bucketStatus(r.orderStatus || '') : 'failed';
            if (sourceFilter !== 'all' && sourceFilter !== 'tool') return false;
            if (strategyFilter !== 'all' && strat !== strategyFilter) return false;
            if (statusFilter !== 'all' && st !== statusFilter) return false;
            if (q) {
                const hay = [r.marketQuestion, r.marketId, r.slug, r.outcome, r.orderId, r.orderStatus, r.error, r.strategy];
                if (!hay.some((v: any) => String(v || '').toLowerCase().includes(q))) return false;
            }
            return true;
        });
    }, [activityRows, sourceFilter, strategyFilter, statusFilter, search]);

    const redeemInfo = redeemStatus?.status;
    const topPortfolioValue = portfolio?.portfolioValue;
    const topCash = portfolio?.cash;
    const topProfitLoss = pnlMode === 'portfolio' ? Number(pnl?.profitLoss || 0) : Number(cashflow?.total?.netCashflow || 0);
    const accountOptions = useMemo(() => {
        const list = Array.isArray(accounts) ? accounts : [];
        return list.map((a: any) => {
            const id = String(a?.id || '').trim();
            const name = String(a?.name || 'Account').trim();
            const funder = a?.status?.funderAddress ? String(a.status.funderAddress) : '';
            const tail = funder ? `${funder.slice(0, 6)}…${funder.slice(-4)}` : 'not configured';
            return { value: id, label: `${name} (${tail})` };
        });
    }, [accounts]);

    return (
        <div style={{ padding: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
                <Title level={2} style={{ color: 'white', margin: 0 }}>Portfolio</Title>
                <Space size={8} wrap>
                    <Select
                        value={activeAccountId}
                        loading={accountsLoading}
                        style={{ minWidth: 260 }}
                        options={accountOptions}
                        onChange={(v) => setActiveAccountId(String(v))}
                    />
                    <Input
                        placeholder="New account name"
                        value={createAccountName}
                        onChange={(e) => setCreateAccountName(e.target.value)}
                        style={{ width: 180 }}
                    />
                    <Button onClick={createAccount} disabled={accountsLoading}>Add</Button>
                    <Input
                        placeholder="Rename account"
                        value={renameAccountName}
                        onChange={(e) => setRenameAccountName(e.target.value)}
                        style={{ width: 180 }}
                    />
                    <Button onClick={renameActiveAccount} disabled={!renameAccountName.trim()}>Rename</Button>
                    <Button icon={<ReloadOutlined />} onClick={refreshAll}>Refresh</Button>
                </Space>
            </div>

            <Row gutter={16} style={{ marginBottom: 16 }}>
                <Col span={8}>
                    <Card loading={loadingPortfolio}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div style={{ fontSize: 12, color: '#9CA3AF' }}>Portfolio</div>
                            <a href="https://polymarket.com/portfolio" target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>Open Polymarket</a>
                        </div>
                        <div style={{ marginTop: 6, fontSize: 28, fontWeight: 700 }}>{fmtUsd(topPortfolioValue)}</div>
                        <div style={{ marginTop: 8, fontSize: 12, color: '#9CA3AF' }}>Holdings: {fmtUsd(portfolio?.positionsValue)} • Cash: {fmtUsd(topCash)}</div>
                    </Card>
                </Col>
                <Col span={8}>
                    <Card loading={loadingPortfolio}>
                        <div style={{ fontSize: 12, color: '#9CA3AF' }}>Cash</div>
                        <div style={{ marginTop: 6, fontSize: 28, fontWeight: 700 }}>{fmtUsd(topCash)}</div>
                        <div style={{ marginTop: 8, fontSize: 12, color: '#9CA3AF' }}>USDC.e balance on Polygon</div>
                    </Card>
                </Col>
                <Col span={8}>
                    <Card loading={pnlMode === 'portfolio' ? loadingPnl : loadingCashflow}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div>
                                <div style={{ fontSize: 12, color: '#9CA3AF' }}>{pnlMode === 'portfolio' ? 'Profit/Loss' : 'Cashflow P/L'}</div>
                                <div style={{ marginTop: 6, fontSize: 28, fontWeight: 700, color: topProfitLoss >= 0 ? '#22c55e' : '#ef4444' }}>{fmtUsd(topProfitLoss)}</div>
                                <div style={{ marginTop: 8 }}>
                                    <Space size={6}>
                                        <Button size="small" type={range === '1D' ? 'primary' : 'default'} onClick={() => setRange('1D')}>1D</Button>
                                        <Button size="small" type={range === '1W' ? 'primary' : 'default'} onClick={() => setRange('1W')}>1W</Button>
                                        <Button size="small" type={range === '1M' ? 'primary' : 'default'} onClick={() => setRange('1M')}>1M</Button>
                                        <Button size="small" type={range === 'ALL' ? 'primary' : 'default'} onClick={() => setRange('ALL')}>All</Button>
                                    </Space>
                                    <Space size={6} style={{ marginLeft: 10 }}>
                                        <Button size="small" type={pnlMode === 'portfolio' ? 'primary' : 'default'} onClick={() => setPnlMode('portfolio')}>Portfolio</Button>
                                        <Button size="small" type={pnlMode === 'cashflow' ? 'primary' : 'default'} onClick={() => setPnlMode('cashflow')}>Cashflow</Button>
                                    </Space>
                                </div>
                            </div>
                            <div>
                                <Button
                                    type="primary"
                                    disabled={claimableCount <= 0}
                                    loading={loadingRedeem}
                                    onClick={async () => {
                                        setLoadingRedeem(true);
                                        try {
                                            await api.post(apiPath('/group-arb/redeem-drain'), { maxTotal: Math.max(1, Math.min(50, claimableCount || 1)) });
                                            await Promise.all([fetchPortfolio(), fetchRedeemStatus(), fetchHistory()]);
                                        } finally {
                                            setLoadingRedeem(false);
                                        }
                                    }}
                                >
                                    Claim
                                </Button>
                                <div style={{ marginTop: 6, fontSize: 12, color: '#9CA3AF', textAlign: 'right' }}>{claimableCount > 0 ? `${claimableCount} redeemable` : 'No claimable'}</div>
                            </div>
                        </div>
                        {pnlMode === 'portfolio' ? (
                            <div style={{ marginTop: 10 }}>
                                <div ref={pnlChartElRef} />
                            </div>
                        ) : (
                            <div style={{ marginTop: 10 }}>
                                {!cashflow?.success ? (
                                    <Alert message="No cashflow data" type="info" showIcon />
                                ) : (
                                    <Table
                                        size="small"
                                        loading={loadingCashflow}
                                        dataSource={(cashflow.byStrategy || []).map((r: any) => ({ ...r, key: r.strategy }))}
                                        pagination={false}
                                        columns={[
                                            { title: 'Strategy', dataIndex: 'strategy', key: 'strategy', render: (v: string) => <Tag>{v}</Tag> },
                                            { title: 'Net Cashflow', dataIndex: 'netCashflow', key: 'netCashflow', render: (v: number) => <Tag color={Number(v) >= 0 ? 'green' : 'red'}>{fmtUsd(v)}</Tag> },
                                            { title: 'Trades', dataIndex: 'tradeCount', key: 'tradeCount' },
                                        ]}
                                    />
                                )}
                            </div>
                        )}
                        <div style={{ marginTop: 8, fontSize: 12, color: '#9CA3AF' }}>
                            {pnlMode === 'portfolio'
                                ? 'P/L is computed from equity (cash + holdings value) change over the selected timeframe.'
                                : 'Cashflow P/L is trade cash-in/cash-out and may not match mark-to-market.'}
                        </div>
                    </Card>
                </Col>
            </Row>

            <Card style={{ marginBottom: 16 }}>
                <Title level={4} style={{ marginTop: 0 }}>Redeem (Auto)</Title>
                {!redeemInfo ? (
                    <Alert message="Redeem status unavailable" description="Backend did not return /group-arb/auto-redeem/status. Click Refresh." type="warning" showIcon />
                ) : (
                    <div>
                        <div style={{ fontSize: 12, color: '#9CA3AF', marginBottom: 8 }}>
                            Funder: {String(redeemInfo.funder || '')} | Owner: {String(redeemInfo.owner || '')} | Relayer: {redeemInfo.relayerConfigured ? 'configured' : 'not configured'}
                        </div>
                        {redeemInfo.lastError ? (
                            <Alert style={{ marginBottom: 8 }} message="Last auto redeem error" description={String(redeemInfo.lastError)} type="warning" showIcon />
                        ) : null}
                        <div style={{ marginBottom: 10, padding: 12, border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8 }}>
                            <div style={{ fontSize: 12, color: '#9CA3AF', marginBottom: 8 }}>
                                Trading Setup (PrivateKey → EOA address is derived automatically; no need to fill EOA).
                            </div>
                            {setupSaveError ? (
                                <Alert style={{ marginBottom: 8 }} message="Setup save failed" description={setupSaveError} type="error" showIcon />
                            ) : null}
                            {setupSaveSuccess ? (
                                <Alert style={{ marginBottom: 8 }} message="Setup saved" description={setupSaveSuccess} type="success" showIcon />
                            ) : null}
                            <Space size={8} wrap>
                                <Input.Password
                                    placeholder="PrivateKey (0x...)"
                                    value={setupPrivateKey}
                                    onChange={(e) => setSetupPrivateKey(e.target.value)}
                                    style={{ width: 360 }}
                                />
                                <Input
                                    placeholder="Funder / Proxy Address (optional, 0x...)"
                                    value={setupProxyAddress}
                                    onChange={(e) => setSetupProxyAddress(e.target.value)}
                                    style={{ width: 360 }}
                                />
                                <Button type="primary" loading={setupSaveLoading} disabled={!setupPrivateKey && !setupProxyAddress} onClick={saveSetup}>
                                    Save & Apply
                                </Button>
                                <Button loading={setupSaveLoading} onClick={() => fetchSetupStatus()}>
                                    Refresh
                                </Button>
                            </Space>
                            <div style={{ marginTop: 8, fontSize: 12, color: '#9CA3AF' }}>
                                EOA: <Tag>{String(setupStatus?.eoaAddress || '-')}</Tag>
                                Funder: <Tag>{String(setupStatus?.funderAddress || '-')}</Tag>
                                Proxy: <Tag>{String(setupStatus?.proxyAddress || '-')}</Tag>
                                Key: <Tag color={setupStatus?.hasPrivateKey ? 'green' : 'default'}>{setupStatus?.hasPrivateKey ? 'configured' : 'missing'}</Tag>
                            </div>
                        </div>
                        <div style={{ marginBottom: 10, padding: 12, border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8 }}>
                            <div style={{ fontSize: 12, color: '#9CA3AF', marginBottom: 8 }}>
                                Relayer Setup (Builder credentials). Stored on disk. Add multiple keys to avoid daily quota stops.
                            </div>
                            {relayerSaveError ? (
                                <Alert style={{ marginBottom: 8 }} message="Relayer setup failed" description={relayerSaveError} type="error" showIcon />
                            ) : null}
                            {relayerSaveSuccess ? (
                                <Alert style={{ marginBottom: 8 }} message="Relayer configured + redeem test ok" description={relayerSaveSuccess} type="success" showIcon />
                            ) : null}
                            {relayerStatus?.keys?.length ? (
                                <div style={{ marginBottom: 10 }}>
                                    <Table
                                        size="small"
                                        pagination={false}
                                        dataSource={(relayerStatus.keys || []).map((k: any) => ({ ...k, key: k.index }))}
                                        columns={[
                                            { title: 'Idx', dataIndex: 'index', key: 'index', width: 60 },
                                            { title: 'Label', dataIndex: 'label', key: 'label', render: (v: any) => (v ? String(v) : '-') },
                                            { title: 'API Key', dataIndex: 'apiKey', key: 'apiKey', render: (v: any) => <Tag>{String(v || '')}</Tag> },
                                            { title: 'Status', key: 'status', render: (_: any, r: any) => (r.exhausted ? <Tag color="orange">EXHAUSTED</Tag> : <Tag color="green">OK</Tag>) },
                                            { title: 'Reset', dataIndex: 'exhaustedUntil', key: 'exhaustedUntil', render: (v: any) => (v ? new Date(String(v)).toLocaleString() : '-') },
                                            { title: 'Last Error', dataIndex: 'lastError', key: 'lastError', render: (v: any) => (v ? String(v).slice(0, 80) : '-') },
                                            {
                                                title: 'Action',
                                                key: 'action',
                                                render: (_: any, r: any) => (
                                                    <Space size={8}>
                                                        <Button
                                                            size="small"
                                                            type="default"
                                                            disabled={Number(r.index) === Number(relayerStatus.activeIndex)}
                                                            onClick={async () => {
                                                                const idx = Number(r.index);
                                                                setBuilderActiveIndex(idx);
                                                                await api.post(apiPath('/group-arb/relayer/active'), { activeIndex: idx, persist: true });
                                                                await fetchRelayerStatus();
                                                            }}
                                                        >
                                                            Set Active
                                                        </Button>
                                                        {Number(r.index) === Number(relayerStatus.activeIndex) ? <Tag color="blue">Active</Tag> : null}
                                                        <Button size="small" danger onClick={() => removeRelayerKey(Number(r.index))}>Remove</Button>
                                                    </Space>
                                                )
                                            }
                                        ]}
                                    />
                                </div>
                            ) : null}
                            <Space size={8} wrap>
                                <Input
                                    placeholder="Label (optional)"
                                    value={relayerKeyLabel}
                                    onChange={(e) => setRelayerKeyLabel(e.target.value)}
                                    style={{ width: 180 }}
                                />
                                <Input.Password
                                    placeholder="Builder API Key"
                                    value={relayerApiKey}
                                    onChange={(e) => setRelayerApiKey(e.target.value)}
                                    style={{ width: 260 }}
                                />
                                <Input.Password
                                    placeholder="Builder Secret"
                                    value={relayerSecret}
                                    onChange={(e) => setRelayerSecret(e.target.value)}
                                    style={{ width: 260 }}
                                />
                                <Input.Password
                                    placeholder="Builder Passphrase"
                                    value={relayerPassphrase}
                                    onChange={(e) => setRelayerPassphrase(e.target.value)}
                                    style={{ width: 260 }}
                                />
                                <Input
                                    placeholder="Relayer URL (optional)"
                                    value={relayerUrl}
                                    onChange={(e) => setRelayerUrl(e.target.value)}
                                    style={{ width: 260 }}
                                />
                                <Button
                                    type="primary"
                                    loading={relayerSaveLoading}
                                    disabled={!relayerApiKey || !relayerSecret || !relayerPassphrase}
                                    onClick={saveRelayerKeys}
                                >
                                    Add Key
                                </Button>
                                <Button
                                    loading={relayerSaveLoading}
                                    disabled={!builderKeys.length}
                                    onClick={() => pushAllRelayerKeys()}
                                >
                                    Save All Keys
                                </Button>
                            </Space>
                        </div>
                        <Space size={12} wrap>
                            <Space size={6}>
                                <span>Auto Redeem</span>
                                <Switch
                                    checked={autoRedeemEnabled}
                                    onChange={async (v) => {
                                        setAutoRedeemEnabled(v);
                                        await api.post(apiPath('/group-arb/auto-redeem/config'), { enabled: v, maxPerCycle: autoRedeemMaxPerCycle });
                                        await fetchRedeemStatus();
                                        await fetchHistory();
                                    }}
                                />
                            </Space>
                            <Space size={6}>
                                <span>Max / cycle</span>
                                <InputNumber min={1} value={autoRedeemMaxPerCycle} onChange={(v) => setAutoRedeemMaxPerCycle(Number(v || 1))} />
                            </Space>
                            <Button
                                loading={loadingRedeem}
                                onClick={async () => {
                                    setLoadingRedeem(true);
                                    try {
                                        await api.post(apiPath('/group-arb/auto-redeem/config'), { enabled: autoRedeemEnabled, maxPerCycle: autoRedeemMaxPerCycle });
                                        await fetchRedeemStatus();
                                    } finally {
                                        setLoadingRedeem(false);
                                    }
                                }}
                            >
                                Save
                            </Button>
                            <Button
                                danger
                                loading={loadingRedeem}
                                onClick={async () => {
                                    setLoadingRedeem(true);
                                    try {
                                        await api.post(apiPath('/group-arb/redeem-drain'), { maxTotal: autoRedeemMaxPerCycle });
                                        await fetchRedeemStatus();
                                        await fetchHistory();
                                        await fetchPortfolio();
                                    } finally {
                                        setLoadingRedeem(false);
                                    }
                                }}
                            >
                                Redeem Now
                            </Button>
                        </Space>
                        <div style={{ marginTop: 8, fontSize: 12, color: '#9CA3AF' }}>
                            Polling: every 5 seconds • Next check: {redeemInfo.nextAt ? new Date(redeemInfo.nextAt).toLocaleString() : '-'}
                        </div>
                        {redeemInfo.last ? (
                            <Alert
                                style={{ marginTop: 8 }}
                                type="info"
                                showIcon
                                message="Last redeem run"
                                description={
                                    <div>
                                        <div>{`${redeemInfo.last.at} • ok ${redeemInfo.last.ok} • fail ${redeemInfo.last.fail}`}</div>
                                        {redeemInfo?.drainLast?.cashDelta != null ? (
                                            <div style={{ marginTop: 4 }}>
                                                {`Δ cash: ${fmtUsd(redeemInfo.drainLast.cashDelta)} • claimable: ${String(redeemInfo.drainLast.claimableCountBefore ?? '-') } → ${String(redeemInfo.drainLast.claimableCountAfter ?? '-')}`}
                                            </div>
                                        ) : null}
                                    </div>
                                }
                            />
                        ) : (
                            <div style={{ marginTop: 8, fontSize: 12, color: '#9CA3AF' }}>
                                No redeem runs yet. If Relayer is not configured, Owner must have some MATIC for gas.
                            </div>
                        )}
                    </div>
                )}
            </Card>

            <Card>
                <div style={{ marginBottom: 12 }}>
                    <Space size={10} wrap>
                        <Input placeholder="Search markets/orders" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 240 }} allowClear />
                        <Select value={sourceFilter} style={{ width: 140 }} onChange={(v) => setSourceFilter(v)} options={[
                            { value: 'all', label: 'Source: All' },
                            { value: 'tool', label: 'Source: Tool' },
                            { value: 'external', label: 'Source: External' },
                        ]} />
                        <Select value={strategyFilter} style={{ width: 170 }} onChange={(v) => setStrategyFilter(v)} options={[
                            { value: 'all', label: 'Strategy: All' },
                            { value: 'manual', label: 'Strategy: Manual' },
                            { value: 'auto', label: 'Strategy: Auto' },
                            { value: 'semi', label: 'Strategy: Semi' },
                            { value: 'external', label: 'Strategy: External' },
                        ]} />
                        <Select value={statusFilter} style={{ width: 160 }} onChange={(v) => setStatusFilter(v)} options={[
                            { value: 'all', label: 'Status: All' },
                            { value: 'open', label: 'Status: Open' },
                            { value: 'filled', label: 'Status: Filled' },
                            { value: 'canceled', label: 'Status: Canceled' },
                            { value: 'failed', label: 'Status: Failed' },
                        ]} />
                    </Space>
                </div>

                <Tabs
                    defaultActiveKey="positions"
                    items={[
                        {
                            key: 'positions',
                            label: `Positions (${positions.length})`,
                            children: (
                                <Table
                                    loading={loadingPortfolio}
                                    dataSource={positions.map((r: any, i: number) => ({ ...r, key: String(r.conditionId || i) }))}
                                    pagination={{ pageSize: 10 }}
                                    columns={[
                                        {
                                            title: 'Market',
                                            key: 'market',
                                            render: (_: any, r: any) => {
                                                const url = eventUrlForMarket(String(r.slug || ''), String(r.eventSlug || ''));
                                                const title = String(r.title || r.conditionId || '');
                                                return url ? <a href={url} target="_blank" rel="noreferrer">{title}</a> : title;
                                            }
                                        },
                                        { title: 'Outcome', dataIndex: 'outcome', key: 'outcome', render: (v: string) => <Tag>{v}</Tag> },
                                        { title: 'Size', dataIndex: 'size', key: 'size', render: (v: any) => Number(v || 0).toFixed(2) },
                                        { title: 'Value', dataIndex: 'currentValue', key: 'currentValue', render: (v: any) => fmtUsd(v) },
                                        { title: 'Cash PnL', dataIndex: 'cashPnl', key: 'cashPnl', render: (v: any) => <span style={{ color: Number(v || 0) >= 0 ? '#22c55e' : '#ef4444' }}>{fmtUsd(v)}</span> },
                                        { title: 'Redeemable', dataIndex: 'redeemable', key: 'redeemable', render: (v: any) => v ? <Tag color="green">Yes</Tag> : <Tag>—</Tag> },
                                    ]}
                                />
                            )
                        },
                        {
                            key: 'open',
                            label: `Open orders (${filteredOpenOrders.length})`,
                            children: (
                                <Table
                                    loading={loadingOrders}
                                    dataSource={filteredOpenOrders.map((r: any) => ({ ...r, key: r.id }))}
                                    pagination={{ pageSize: 10 }}
                                    columns={[
                                        {
                                            title: 'Market',
                                            key: 'market',
                                            render: (_: any, r: any) => {
                                                const url = eventUrlForMarket(String(r.slug || ''), String(r.eventSlug || ''));
                                                const title = String(r.marketQuestion || r.marketId || '');
                                                return url ? <a href={url} target="_blank" rel="noreferrer">{title}</a> : title;
                                            }
                                        },
                                        { title: 'Side', dataIndex: 'side', key: 'side', render: (v: string) => <Tag color={String(v).toUpperCase() === 'BUY' ? 'green' : 'red'}>{String(v).toUpperCase()}</Tag> },
                                        { title: 'Outcome', dataIndex: 'outcome', key: 'outcome', render: (v: string) => <Tag>{v}</Tag> },
                                        { title: 'Price', dataIndex: 'price', key: 'price', render: (v: any) => Number(v || 0).toFixed(4) },
                                        { title: 'Filled', dataIndex: 'filledSize', key: 'filledSize', render: (v: any) => Number(v || 0).toFixed(2) },
                                        { title: 'Total', dataIndex: 'originalSize', key: 'originalSize', render: (v: any) => Number(v || 0).toFixed(2) },
                                        { title: 'Status', dataIndex: 'status', key: 'status', render: (v: string) => <Tag>{String(v || '').toUpperCase()}</Tag> },
                                        { title: 'Source', dataIndex: 'source', key: 'source', render: (v: string) => <Tag>{v}</Tag> },
                                        { title: 'Strategy', dataIndex: 'strategy', key: 'strategy', render: (v: string) => <Tag color={v === 'external' ? 'default' : 'blue'}>{v}</Tag> },
                                    ]}
                                />
                            )
                        },
                        {
                            key: 'trades',
                            label: `Trades (${filteredTrades.length})`,
                            children: (
                                <Table
                                    loading={loadingTrades}
                                    dataSource={filteredTrades.map((r: any, i: number) => ({ ...r, key: String(r.id || `${r.marketId}-${i}`) }))}
                                    pagination={{ pageSize: 10 }}
                                    columns={[
                                        { title: 'Time', dataIndex: 'match_time', key: 'match_time', render: (v: any) => v ? new Date(v).toLocaleString() : '-' },
                                        {
                                            title: 'Market',
                                            key: 'market',
                                            render: (_: any, r: any) => {
                                                const url = eventUrlForMarket(String(r.slug || ''), String(r.eventSlug || ''));
                                                const title = String(r.title || r.marketId || '');
                                                return url ? <a href={url} target="_blank" rel="noreferrer">{title}</a> : title;
                                            }
                                        },
                                        { title: 'Side', dataIndex: 'side', key: 'side', render: (v: string) => <Tag color={String(v).toUpperCase() === 'BUY' ? 'green' : 'red'}>{String(v).toUpperCase()}</Tag> },
                                        { title: 'Outcome', dataIndex: 'outcome', key: 'outcome', render: (v: string) => <Tag>{v}</Tag> },
                                        { title: 'Price', dataIndex: 'price', key: 'price', render: (v: any) => Number(v || 0).toFixed(4) },
                                        { title: 'Size', dataIndex: 'size', key: 'size', render: (v: any) => Number(v || 0).toFixed(2) },
                                        { title: 'Status', dataIndex: 'status', key: 'status', render: (v: string) => <Tag>{String(v || '').toUpperCase()}</Tag> },
                                        { title: 'Source', dataIndex: 'source', key: 'source', render: (v: string) => <Tag>{v}</Tag> },
                                        { title: 'Strategy', dataIndex: 'strategy', key: 'strategy', render: (v: string) => <Tag color={v === 'external' ? 'default' : 'blue'}>{v}</Tag> },
                                    ]}
                                />
                            )
                        },
                        {
                            key: 'history',
                            label: `History (${filteredHistory.length})`,
                            children: (
                                <Table
                                    loading={loadingHistory}
                                    dataSource={filteredHistory}
                                    pagination={{ pageSize: 10 }}
                                    columns={[
                                        { title: 'Time', dataIndex: 'time', key: 'time', render: (v: string) => new Date(v).toLocaleString() },
                                        {
                                            title: 'Market',
                                            key: 'market',
                                            render: (_: any, r: any) => {
                                                const url = eventUrlForMarket(String(r.slug || ''), String(r.eventSlug || ''));
                                                const title = String(r.marketQuestion || r.marketId || '');
                                                return url ? <a href={url} target="_blank" rel="noreferrer">{title}</a> : title;
                                            }
                                        },
                                        { title: 'Strategy', dataIndex: 'strategy', key: 'strategy', render: (v: string) => <Tag color={v === 'manual' ? 'blue' : v === 'auto' ? 'purple' : v === 'semi' ? 'geekblue' : 'default'}>{v}</Tag> },
                                        { title: 'Outcome', dataIndex: 'outcome', key: 'outcome', render: (v: string) => <Tag>{v}</Tag> },
                                        { title: 'Order', dataIndex: 'orderId', key: 'orderId', render: (v: any) => v ? <span>{String(v).slice(0, 10)}…</span> : '-' },
                                        { title: 'CLOB', dataIndex: 'orderStatus', key: 'orderStatus', render: (v: any) => v ? <Tag>{String(v)}</Tag> : '-' },
                                        { title: 'Filled', dataIndex: 'filledSize', key: 'filledSize', render: (v: any) => v != null ? Number(v).toFixed(2) : '-' },
                                        { title: 'Result', key: 'result', render: (_: any, r: any) => r.success ? <Tag color="green">OK</Tag> : <Tag color="red">Fail</Tag> },
                                        { title: 'Error', dataIndex: 'error', key: 'error', render: (v: any) => v ? <span style={{ color: '#ef4444' }}>{String(v)}</span> : '-' },
                                    ]}
                                />
                            )
                        },
                    ]}
                />
            </Card>
        </div>
    );
}
