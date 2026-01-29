import { useState, useRef, useEffect } from 'react';
import { Tabs, Table, Card, Input, Button, Tag, Typography, Modal, InputNumber, Descriptions, Alert, Switch } from 'antd';
import { RadarChartOutlined, SearchOutlined, ShoppingCartOutlined, PauseCircleOutlined, HistoryOutlined, PlayCircleOutlined, CloudOutlined, ReloadOutlined } from '@ant-design/icons';
import axios from 'axios';

const { Title } = Typography;

const api = axios.create({
    baseURL: 'http://localhost:3000/api', // Explicitly set backend URL
});
const formatTimeWithAgo = (iso: string) => {
    const d = new Date(iso);
    const diffMs = Date.now() - d.getTime();
    const mins = Math.max(0, Math.floor(diffMs / 60000));
    return `${d.toLocaleString()} (UTC ${d.toUTCString()}) • ${mins}m ago`;
};


function GroupArbTab() {
    const [loading, setLoading] = useState(false);
    const [opps, setOpps] = useState<any[]>([]);
    const [orderHistory, setOrderHistory] = useState<any[]>([]); 
    const [autoHistoryRefresh, setAutoHistoryRefresh] = useState(true);
    const isScanningRef = useRef(false);
    
    // Order Modal State
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [selectedOpp, setSelectedOpp] = useState<any>(null);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [settings, setSettings] = useState<any>(() => {
        try {
            const raw = localStorage.getItem('tdl_settings');
            if (raw) return JSON.parse(raw);
        } catch {
        }
        return {
            targetProfitPercent: 10,
            defaultShares: 5,
            cutLossPercent: 25,
            trailingStopPercent: 10,
            enableOneLegTimeout: true,
            oneLegTimeoutMinutes: 10,
            autoCancelUnfilledOnTimeout: true,
            wideSpreadCents: 5,
            forceMarketExitFromPeakPercent: 15,
            enableHedgeComplete: false,
            oneLegTimeoutAction: 'UNWIND_EXIT',
            maxSpreadCentsForHedge: 5,
            maxSlippageCents: 2,
        };
    });
    const [orderShares, setOrderShares] = useState<number>(5);
    const [placingOrder, setPlacingOrder] = useState(false);

    // Order Monitoring Modal
    const [isMonitorOpen, setIsMonitorOpen] = useState(false);
    const [monitorData, setMonitorData] = useState<any[]>([]);
    const [monitorLoading, setMonitorLoading] = useState(false);

    // Fetch Global History
    const fetchHistory = async () => {
        try {
            const res = await api.get('/group-arb/history', { params: { refresh: true, intervalMs: 1000, maxEntries: 20 } });
            if (res.data.history) {
                setOrderHistory(res.data.history);
            }
        } catch (e) {
            console.error("Failed to fetch history", e);
        }
    };

    const toggleScan = async () => {
        if (isScanningRef.current) {
            isScanningRef.current = false;
            setLoading(false);
            return;
        }

        isScanningRef.current = true;
        setLoading(true);
        
        try { 
            while (isScanningRef.current) {
                const res = await api.get('/group-arb/scan'); 
                const newOpps = Array.isArray(res.data.opportunities) ? res.data.opportunities : []; 
                
                setOpps(() => {
                    const combined = Array.isArray(newOpps) ? newOpps : [];
                    return combined;
                });

                // Also fetch history periodically to keep it synced
                fetchHistory();

                if (isScanningRef.current) await new Promise(r => setTimeout(r, 3000)); 
            } 
        } catch (e) { 
            console.error(e); 
        } finally { 
            setLoading(false); 
            isScanningRef.current = false;
        }
    };

    useEffect(() => {
        fetchHistory(); // Fetch on mount
        const tHistory = setInterval(() => {
            if (autoHistoryRefresh) fetchHistory();
        }, 1000);
        if (!isScanningRef.current) {
            toggleScan();
        }
        return () => {
            clearInterval(tHistory);
            isScanningRef.current = false;
        };
    }, [autoHistoryRefresh]);

    const handleBuyClick = (record: any) => {
        setSelectedOpp(record);
        setOrderShares(Number(settings?.defaultShares) || 5);
        setIsModalOpen(true);
    };

    const handleMonitorClick = async (record: any) => {
        setSelectedOpp(record);
        setIsMonitorOpen(true);
        fetchActiveOrders(record.marketId);
    };

    const fetchActiveOrders = async (marketId: string) => {
        setMonitorLoading(true);
        try {
            const res = await api.get('/group-arb/orders', { params: { marketId } });
            setMonitorData(res.data.orders);
        } catch (e) {
            console.error(e);
        } finally {
            setMonitorLoading(false);
        }
    };

    const executeOrder = async () => {
        if (!selectedOpp) return;
        setPlacingOrder(true);
        try {
            const res = await api.post('/group-arb/execute-shares', {
                marketId: selectedOpp.marketId,
                slug: selectedOpp.slug,
                question: selectedOpp.question,
                shares: orderShares,
                targetProfitPercent: Number(settings?.targetProfitPercent ?? 10),
                cutLossPercent: Number(settings?.cutLossPercent ?? 25),
                trailingStopPercent: Number(settings?.trailingStopPercent ?? 10),
                enableOneLegTimeout: !!settings?.enableOneLegTimeout,
                oneLegTimeoutMinutes: Number(settings?.oneLegTimeoutMinutes ?? 10),
                autoCancelUnfilledOnTimeout: !!settings?.autoCancelUnfilledOnTimeout,
                enableHedgeComplete: !!settings?.enableHedgeComplete,
                oneLegTimeoutAction: settings?.enableHedgeComplete ? 'HEDGE_COMPLETE' : 'UNWIND_EXIT',
                maxSpreadCentsForHedge: Number(settings?.maxSpreadCentsForHedge ?? 5),
                maxSlippageCents: Number(settings?.maxSlippageCents ?? 2),
                wideSpreadCents: Number(settings?.wideSpreadCents ?? 5),
                forceMarketExitFromPeakPercent: Number(settings?.forceMarketExitFromPeakPercent ?? 15),
            });
            
            // Refresh history immediately
            await fetchHistory();

            alert(`Orders submitted for ${selectedOpp.question}! Check Dashboard/History and Open Orders.`);
            setIsModalOpen(false);
            
            handleMonitorClick(selectedOpp);

        } catch (e: any) {
            alert(`Failed to place order: ${e.response?.data?.error || e.message}`);
        } finally {
            setPlacingOrder(false);
        }
    };

    const columns = [
        { title: 'Market', dataIndex: 'question', key: 'question', render: (text: string, record: any) => { 
            const slug = String(record.slug || '');
            const m = slug.match(/^(.*-on-[a-z]+-\d{1,2})-/i);
            const groupSlug = m ? m[1] : slug;
            const eventUrl = slug ? `https://polymarket.com/event/${groupSlug}/${slug}` : '';
            const marketUrl = eventUrl;
            const tradeUrl = eventUrl; 
            
            return ( 
                <div style={{display:'flex', flexDirection:'column'}}> 
                    <span style={{fontWeight: 'bold'}}>
                        {record.isWeather && <Tag color="blue" icon={<CloudOutlined />}>Weather</Tag>}
                        {text}
                    </span> 
                    <div style={{fontSize: 12, marginTop: 4}}> 
                        <a href={marketUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#2b9af3', marginRight: 8 }}>[Market Page]</a> 
                        <a href={tradeUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#2b9af3' }}>[Trade Page]</a> 
                        <span style={{ marginLeft: 8, color: 'gray' }}>
                           Ends: {record.endDate ? new Date(record.endDate).toLocaleString() : 'N/A'}
                           <span style={{ marginLeft: 8, color: 'gray' }}>
                               Vol: {record.volume24hr ? `$${Number(record.volume24hr).toLocaleString()}` : 'N/A'}
                           </span>
                        </span>
                    </div> 
                    <span style={{fontSize: 10, color: 'gray', marginTop: 2}}>ID: {record.gammaId || 'N/A'}</span> 
                </div> 
            ); 
        }},
        { 
            title: 'Split', 
            key: 'split',
            render: (_: any, record: any) => {
                const yes = Number(record.yesPrice);
                const no = Number(record.noPrice);
                if (!Number.isFinite(yes) || !Number.isFinite(no)) return <Tag>-</Tag>;
                const total = yes + no;
                const ratio = total > 0 ? yes / total : 0.5;
                const isBalanced = Math.abs(ratio - 0.5) <= 0.05;
                
                return (
                    <Tag color={isBalanced ? 'green' : 'default'}>
                        {yes.toFixed(1)}/{no.toFixed(1)}
                    </Tag>
                );
            }
        },
        { 
            title: 'Profit', 
            dataIndex: 'profitPercent', 
            key: 'profitPercent',
            render: (v: number) => <span style={{ color: v > 0 ? 'green' : 'orange', fontWeight: 'bold' }}>{Number(v).toFixed(1)}%</span>,
            sorter: (a: any, b: any) => a.profitPercent - b.profitPercent,
        },
        {
            title: 'Spread',
            dataIndex: 'spreadSum',
            key: 'spreadSum',
            render: (v: number) => (v != null ? `${Number(v).toFixed(1)}c` : '-'),
            sorter: (a: any, b: any) => (a.spreadSum ?? 1e9) - (b.spreadSum ?? 1e9),
        },
        { title: 'Total Cost', dataIndex: 'totalCost', key: 'totalCost', render: (v: number) => `${Number(v).toFixed(1)}` },
        { 
            title: 'Outcomes', 
            dataIndex: 'outcomes', 
            key: 'outcomes',
            render: (tags: string[]) => (
                <>
                    {tags.slice(0, 3).map(tag => <Tag key={tag}>{tag}</Tag>)}
                    {tags.length > 3 && <Tag>+{tags.length - 3} more</Tag>}
                </>
            )
        },
        {
            title: 'Action',
            key: 'action',
            render: (_: any, record: any) => (
                <div style={{display:'flex', gap: 8}}>
                    <Button 
                        type="primary" 
                        size="small" 
                        icon={<ShoppingCartOutlined />}
                        onClick={() => handleBuyClick(record)}
                    >
                        Buy All
                    </Button>
                    <Button 
                        size="small" 
                        icon={<HistoryOutlined />}
                        onClick={() => handleMonitorClick(record)}
                    >
                        Check Orders
                    </Button>
                </div>
            )
        }
    ];

    const historyColumns = [
        { title: 'Time', dataIndex: 'timestamp', key: 'timestamp', render: (v: string) => formatTimeWithAgo(v) },
        { title: 'Market', dataIndex: 'marketQuestion', key: 'market' },
        {
            title: 'Polymarket',
            key: 'polymarket',
            render: (_: any, record: any) => {
                const slug = String(record.slug || '');
                const m = slug.match(/^(.*-on-[a-z]+-\d{1,2})-/i);
                const groupSlug = m ? m[1] : slug;
                const marketUrl = slug ? `https://polymarket.com/event/${groupSlug}/${slug}` : '';
                return (
                    <div style={{ display: 'flex', gap: 8 }}>
                        {marketUrl ? (
                            <a href={marketUrl} target="_blank" rel="noopener noreferrer">Market</a>
                        ) : (
                            <span style={{ color: 'gray' }}>-</span>
                        )}
                        <a href="https://polymarket.com/portfolio" target="_blank" rel="noopener noreferrer">Portfolio</a>
                    </div>
                );
            }
        },
        { title: 'Mode', dataIndex: 'mode', key: 'mode', render: (v: string) => <Tag color={v === 'manual' ? 'geekblue' : v === 'auto' ? 'purple' : 'green'}>{String(v || 'semi')}</Tag> },
        { title: 'Shares', dataIndex: 'shares', key: 'shares', render: (_: any, r: any) => (r.shares != null ? Number(r.shares).toFixed(2) : '-') },
        { title: 'Target Profit', key: 'targetProfit', render: (_: any, r: any) => (r.settings?.targetProfitPercent != null ? `${Number(r.settings.targetProfitPercent).toFixed(1)}%` : '-') },
        { title: 'Execution Results', key: 'results', render: (_: any, record: any) => (
            <div style={{fontSize: 12}}>
                {record.results?.map((r: any, idx: number) => (
                    <div key={idx} style={{color: r.success ? 'green' : 'red'}}>
                        {r.success ? '✅' : '❌'} {r.outcome || 'Unknown'}: {r.success ? (r.confirmed ? 'Confirmed' : (r.redeemStatus ? String(r.redeemStatus).toUpperCase() : 'Sent')) : (r.errorSummary || r.error)} {r.orderId ? `(${String(r.orderId).slice(0, 10)}…)` : ''} {r.orderStatus ? `• ${r.orderStatus}` : ''} {r.filledSize != null ? `• filled ${Number(r.filledSize).toFixed(2)}` : ''} {r.canceledBy ? `• canceledBy ${r.canceledBy}` : ''} {r.txHash ? ` • ${String(r.txHash).slice(0, 10)}…` : ''} {r.transactionId ? ` • relayer ${String(r.transactionId).slice(0, 8)}…` : ''}
                    </div>
                ))}
            </div>
        )},
        { title: 'Status', key: 'status', render: (_: any, record: any) => (
            <Tag color={record.openOrdersCount > 0 ? 'blue' : 'green'}>
                {record.openOrdersCount > 0 ? `${record.openOrdersCount} Open` : 'Filled/Done'}
            </Tag>
        )}
    ];

    return (
        <div>
            <div style={{ marginBottom: 16, display: 'flex', gap: 8 }}>
                <Button
                    type={loading ? 'default' : 'primary'}
                    danger={loading}
                    onClick={toggleScan}
                    icon={loading ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                >
                    {loading ? 'Pause Scanning' : 'Resume Scanning'}
                </Button>
                <Button onClick={() => setSettingsOpen(true)} icon={<RadarChartOutlined />}>
                    Settings
                </Button>
                <Button onClick={() => setAutoHistoryRefresh((v: boolean) => !v)} type={autoHistoryRefresh ? 'primary' : 'default'}>
                    {autoHistoryRefresh ? 'Auto Refresh: 1s' : 'Auto Refresh: Off'}
                </Button>
            </div>
            
            <Title level={5} style={{color:'white'}}>Live Opportunities</Title>
            <Table 
                dataSource={opps} 
                columns={columns} 
                rowKey="marketId" 
                pagination={{ 
                    pageSize: 50, 
                    showSizeChanger: true, 
                    pageSizeOptions: ['10', '20', '50', '100'] 
                }} 
            />

            <div style={{marginTop: 24}}>
                <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
                    <Title level={5} style={{color:'white'}}><HistoryOutlined /> Global Order History</Title>
                    <Button size="small" icon={<ReloadOutlined />} onClick={fetchHistory}>Refresh History</Button>
                </div>
                <Table dataSource={orderHistory} columns={historyColumns} rowKey="id" pagination={false} />
            </div>

            <Modal
                title="TDL Settings"
                open={settingsOpen}
                onOk={() => {
                    localStorage.setItem('tdl_settings', JSON.stringify(settings));
                    setSettingsOpen(false);
                }}
                onCancel={() => setSettingsOpen(false)}
                okText="Save"
            >
                <Descriptions column={1} bordered size="small">
                    <Descriptions.Item label="Target Profit (%)">
                        <InputNumber style={{ width: '100%' }} value={settings.targetProfitPercent} onChange={(v) => setSettings((s: any) => ({ ...s, targetProfitPercent: Number(v || 0) }))} />
                    </Descriptions.Item>
                    <Descriptions.Item label="Default Shares">
                        <InputNumber style={{ width: '100%' }} value={settings.defaultShares} onChange={(v) => setSettings((s: any) => ({ ...s, defaultShares: Number(v || 0) }))} />
                    </Descriptions.Item>
                    <Descriptions.Item label="Cut Loss (%)">
                        <InputNumber style={{ width: '100%' }} value={settings.cutLossPercent} onChange={(v) => setSettings((s: any) => ({ ...s, cutLossPercent: Number(v || 0) }))} />
                    </Descriptions.Item>
                    <Descriptions.Item label="Trailing Stop (%)">
                        <InputNumber style={{ width: '100%' }} value={settings.trailingStopPercent} onChange={(v) => setSettings((s: any) => ({ ...s, trailingStopPercent: Number(v || 0) }))} />
                    </Descriptions.Item>
                    <Descriptions.Item label="Enable One-Leg Timeout">
                        <Switch checked={!!settings.enableOneLegTimeout} onChange={(v) => setSettings((s: any) => ({ ...s, enableOneLegTimeout: v }))} />
                    </Descriptions.Item>
                    <Descriptions.Item label="One-Leg Timeout Minutes (1–120)">
                        <InputNumber
                            style={{ width: '100%' }}
                            min={1}
                            max={120}
                            disabled={!settings.enableOneLegTimeout}
                            value={settings.oneLegTimeoutMinutes}
                            onChange={(v) => setSettings((s: any) => ({ ...s, oneLegTimeoutMinutes: Number(v || 0) }))}
                        />
                    </Descriptions.Item>
                    <Descriptions.Item label="Auto-cancel Unfilled Leg on Timeout">
                        <Switch
                            checked={!!settings.autoCancelUnfilledOnTimeout}
                            disabled={!settings.enableOneLegTimeout}
                            onChange={(v) => setSettings((s: any) => ({ ...s, autoCancelUnfilledOnTimeout: v }))}
                        />
                    </Descriptions.Item>
                    <Descriptions.Item label="Enable Hedge-Complete (A/B, default OFF)">
                        <Switch
                            checked={!!settings.enableHedgeComplete}
                            onChange={(v) =>
                                setSettings((s: any) => ({
                                    ...s,
                                    enableHedgeComplete: v,
                                    oneLegTimeoutAction: v ? 'HEDGE_COMPLETE' : 'UNWIND_EXIT',
                                }))
                            }
                        />
                    </Descriptions.Item>
                    <Descriptions.Item label="Max Hedge Spread (cents)">
                        <InputNumber
                            style={{ width: '100%' }}
                            min={0}
                            disabled={!settings.enableHedgeComplete}
                            value={settings.maxSpreadCentsForHedge}
                            onChange={(v) => setSettings((s: any) => ({ ...s, maxSpreadCentsForHedge: Number(v || 0) }))}
                        />
                    </Descriptions.Item>
                    <Descriptions.Item label="Max Hedge Slippage (cents)">
                        <InputNumber
                            style={{ width: '100%' }}
                            min={0}
                            disabled={!settings.enableHedgeComplete}
                            value={settings.maxSlippageCents}
                            onChange={(v) => setSettings((s: any) => ({ ...s, maxSlippageCents: Number(v || 0) }))}
                        />
                    </Descriptions.Item>
                    <Descriptions.Item label="Wide Spread Threshold (cents)">
                        <InputNumber style={{ width: '100%' }} value={settings.wideSpreadCents} onChange={(v) => setSettings((s: any) => ({ ...s, wideSpreadCents: Number(v || 0) }))} />
                    </Descriptions.Item>
                    <Descriptions.Item label="Force Exit From Peak (%)">
                        <InputNumber style={{ width: '100%' }} value={settings.forceMarketExitFromPeakPercent} onChange={(v) => setSettings((s: any) => ({ ...s, forceMarketExitFromPeakPercent: Number(v || 0) }))} />
                    </Descriptions.Item>
                </Descriptions>
            </Modal>

            <Modal
                title="⚡ One-Click Arbitrage Execution"
                open={isModalOpen}
                onOk={executeOrder}
                onCancel={() => setIsModalOpen(false)}
                confirmLoading={placingOrder}
                okText="Confirm & Place Orders"
                cancelText="Cancel"
            >
                {selectedOpp && (
                    <div>
                        <Alert 
                            message="Strategy: Buy All Outcomes" 
                            description="This will place limit orders for ALL outcomes to lock in the profit."
                            type="info" 
                            showIcon 
                            style={{marginBottom: 16}}
                        />
                        <Descriptions column={1} bordered size="small">
                            <Descriptions.Item label="Market">{selectedOpp.question}</Descriptions.Item>
                            <Descriptions.Item label="Current Cost">${selectedOpp.totalCost.toFixed(4)}</Descriptions.Item>
                            <Descriptions.Item label="Target Profit">{selectedOpp.profitPercent.toFixed(2)}%</Descriptions.Item>
                        </Descriptions>
                        
                        <div style={{marginTop: 16}}>
                            <div style={{marginBottom: 8, fontWeight: 'bold'}}>Shares (Size):</div>
                            <InputNumber
                                style={{width: '100%'}}
                                value={orderShares}
                                min={0}
                                onChange={(v) => setOrderShares(Number(v || 0))}
                            />
                            <div style={{marginTop: 8, color: 'gray', fontSize: 12}}>
                                Est. Cost (using current displayed cost): ${((Number(selectedOpp.totalCost) / 100) * Number(orderShares || 0)).toFixed(2)}
                            </div>
                            <div style={{marginTop: 4, color: 'gray', fontSize: 12}}>
                                Target Profit: {Number(settings?.targetProfitPercent ?? 10).toFixed(1)}%
                            </div>
                        </div>
                    </div>
                )}
            </Modal>

            <Modal
                title={`Active Orders: ${selectedOpp?.question || 'Unknown'}`}
                open={isMonitorOpen}
                onCancel={() => setIsMonitorOpen(false)}
                footer={[
                    <Button key="refresh" icon={<ReloadOutlined />} onClick={() => fetchActiveOrders(selectedOpp?.marketId)}>Refresh</Button>,
                    <Button
                        key="exitNow"
                        danger
                        onClick={async () => {
                            if (!selectedOpp?.marketId) return;
                            await api.post('/group-arb/exit-now', { marketId: selectedOpp.marketId });
                            await fetchHistory();
                            await fetchActiveOrders(selectedOpp.marketId);
                        }}
                    >
                        Exit Now
                    </Button>,
                    <Button key="close" type="primary" onClick={() => setIsMonitorOpen(false)}>Close</Button>
                ]}
                width={700}
            >
                {monitorLoading ? <div>Loading orders...</div> : (
                    monitorData.length === 0 ? (
                        <Alert message="No active open orders found for this market." type="warning" showIcon />
                    ) : (
                        <Table 
                            dataSource={monitorData} 
                            rowKey="id"
                            pagination={false}
                            columns={[
                                { title: 'Side', dataIndex: 'side', key: 'side', render: (v: string) => <Tag color={v === 'BUY' ? 'green' : 'red'}>{v}</Tag> },
                                { title: 'Size', dataIndex: 'originalSize', key: 'size' },
                                { title: 'Price', dataIndex: 'price', key: 'price' },
                                { title: 'Filled', dataIndex: 'sizeMatched', key: 'filled' },
                                { title: 'Status', key: 'status', render: (_:any, r:any) => r.sizeMatched > 0 ? 'Partially Filled' : 'Open' }
                            ]}
                        />
                    )
                )}
            </Modal>
        </div>
    );
}

function AutoTradeTab() {
    const [enabled, setEnabled] = useState(() => {
        try {
            return localStorage.getItem('auto_trade_enabled') === 'true';
        } catch {
            return false;
        }
    });

    const toggle = (v: boolean) => {
        setEnabled(v);
        try {
            localStorage.setItem('auto_trade_enabled', v ? 'true' : 'false');
        } catch {
        }
    };

    return (
        <div>
            <Alert
                type="warning"
                showIcon
                message="自動交易 (Auto Trade)"
                description="OFF by default. This page is scaffolding for Strategy I (TDL) auto mode. Semi-Auto remains the recommended mode."
                style={{ marginBottom: 16 }}
            />
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <Tag color={enabled ? 'green' : 'red'}>{enabled ? 'ENABLED' : 'DISABLED'}</Tag>
                <Button type={enabled ? 'default' : 'primary'} danger={enabled} onClick={() => toggle(!enabled)}>
                    {enabled ? 'Disable Auto Trade' : 'Enable Auto Trade'}
                </Button>
            </div>
        </div>
    );
}

function ThetaFarmerTab() {
    const [query, setQuery] = useState('us-strikes-iran');
    const [loading, setLoading] = useState(false);
    const [data, setData] = useState<any>(null);

    const analyze = async () => {
        setLoading(true);
        try {
            const res = await api.get('/theta/analyze', { params: { query } });
            setData(res.data);
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    const seriesColumns = [
        { title: 'End Date', dataIndex: 'endDate', key: 'endDate', render: (v: string) => new Date(v).toLocaleDateString() },
        { title: 'Question', dataIndex: 'question', key: 'question' },
        { title: 'YES Price', dataIndex: 'yesPrice', key: 'yesPrice', render: (v: number) => v.toFixed(2) },
        { title: 'NO Price', dataIndex: 'noPrice', key: 'noPrice', render: (v: number) => v.toFixed(2) },
    ];

    const analysisColumns = [
        { title: 'Interval', dataIndex: 'interval', key: 'interval' },
        { title: 'Spread', dataIndex: 'spread', key: 'spread', render: (v: any) => <Tag color={parseFloat(v) < 0 ? 'red' : 'green'}>{v}</Tag> },
        { title: 'Implied Prob', dataIndex: 'impliedProbability', key: 'impliedProbability' },
        { title: 'Action', dataIndex: 'action', key: 'action' },
    ];

    return (
        <div>
            <div style={{ marginBottom: 16, display: 'flex', gap: 10 }}>
                <Input 
                    value={query} 
                    onChange={e => setQuery(e.target.value)} 
                    placeholder="Search series (e.g. us-strikes-iran)" 
                    style={{ width: 300 }}
                />
                <Button type="primary" onClick={analyze} loading={loading} icon={<SearchOutlined />}>
                    Analyze
                </Button>
            </div>

            {data && (
                <>
                    <Title level={4} style={{color:'white'}}>Market Series Data</Title>
                    <Table dataSource={data.series} columns={seriesColumns} pagination={false} style={{marginBottom: 24}} />
                    
                    <Title level={4} style={{color:'white'}}>Spread Analysis</Title>
                    <Table dataSource={data.analysis} columns={analysisColumns} pagination={false} />
                </>
            )}
        </div>
    );
}

export default function Advanced() {
    return (
        <Card title="🚀 Advanced Strategies" style={{ margin: 24 }}>
            <Tabs defaultActiveKey="1" items={[
                { key: '1', label: '🧩 Group Arbitrage', children: <GroupArbTab /> },
                { key: '2', label: '⏳ Theta Farmer (Calendar)', children: <ThetaFarmerTab /> },
                { key: '3', label: '🤖 自動交易', children: <AutoTradeTab /> },
            ]} />
        </Card>
    );
}
