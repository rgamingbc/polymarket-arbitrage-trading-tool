import { useEffect, useState } from 'react';
import { Table, Typography, Card, Alert, Button, Tag, Row, Col, Statistic, Modal, InputNumber, message, Descriptions, Switch, Slider, Space } from 'antd';
import { SyncOutlined, ThunderboltOutlined, SettingOutlined } from '@ant-design/icons';
import { arbitrageApi } from '../api/client';

const { Title, Text } = Typography;

interface Opportunity {
    market: {
        conditionId: string;
        question: string;
        volume24hr: number;
        yesTokenId: string;
        noTokenId: string;
    };
    arbType: 'long' | 'short';
    profit: number;
    profitPercent: number;
    description: string;
    orderbook: {
        yesAsk: number;
        yesBid: number;
        noAsk: number;
        noBid: number;
    };
    recommendedSize: number;
}

function Arbitrage() {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
    const [scannedAt, setScannedAt] = useState<string>('');
    const [scanStatus, setScanStatus] = useState<any>(null);

    // Settings
    const [autoRefresh, setAutoRefresh] = useState(true);
    const [minProfit, setMinProfit] = useState(0.1); // 0.1%
    const [minVolume, setMinVolume] = useState(500); // $500

    // Execution State
    const [modalVisible, setModalVisible] = useState(false);
    const [selectedOpp, setSelectedOpp] = useState<Opportunity | null>(null);
    const [tradeSize, setTradeSize] = useState<number>(10);
    const [executing, setExecuting] = useState(false);

    // Poll timer
    useEffect(() => {
        let interval: any;
        
        const fetch = () => loadData();
        
        fetch(); // Initial fetch

        if (autoRefresh) {
            interval = setInterval(fetch, 5000); // Poll every 5s
        }

        return () => {
            if (interval) clearInterval(interval);
        };
    }, [autoRefresh, minProfit, minVolume]);

    const loadData = async () => {
        try {
            // Don't show loading spinner on auto-refresh to avoid flickering
            if (!autoRefresh) setLoading(true);
            setError(null);
            
            // Convert percent to decimal (0.1% -> 0.001)
            const res = await arbitrageApi.scan(minVolume, 100, minProfit / 100);
            
            setOpportunities(res.data.opportunities || []);
            setScannedAt(res.data.scannedAt);
            setScanStatus(res.data.status);
        } catch (err: any) {
            console.error('Scan Error:', err);
            // Only show error if not auto-refreshing (to avoid spam)
            if (!autoRefresh) {
                setError(`无法获取数据: ${err.message || 'Unknown error'}`);
            }
        } finally {
            setLoading(false);
        }
    };

    const handleExecuteClick = (opp: Opportunity) => {
        setSelectedOpp(opp);
        setTradeSize(opp.recommendedSize || 10);
        setModalVisible(true);
    };

    const handleConfirmExecute = async () => {
        if (!selectedOpp) return;

        try {
            setExecuting(true);
            const res = await arbitrageApi.execute(selectedOpp.market, selectedOpp, tradeSize);
            
            if (res.data.success) {
                message.success({
                    content: `✅ 执行成功! 利润: $${res.data.profit.toFixed(4)}`,
                    duration: 5,
                });
                setModalVisible(false);
                loadData(); 
            } else {
                message.warning('⚠️ 执行部分成功或无利润，请检查钱包');
            }
        } catch (err: any) {
            message.error(`❌ 执行失败: ${err.response?.data?.error || err.message}`);
        } finally {
            setExecuting(false);
        }
    };

    const columns = [
        {
            title: '类型',
            dataIndex: 'arbType',
            key: 'arbType',
            render: (t: string) => (
                <Tag color={t === 'long' ? 'green' : 'orange'}>
                    {t === 'long' ? '多头' : '空头'}
                </Tag>
            ),
            width: 80,
        },
        {
            title: '市场',
            dataIndex: ['market', 'question'],
            key: 'question',
            ellipsis: true,
        },
        {
            title: '利润',
            dataIndex: 'profitPercent',
            key: 'profitPercent',
            render: (v: number) => (
                <span style={{ color: '#52c41a', fontWeight: 'bold' }}>
                    +{v.toFixed(2)}%
                </span>
            ),
            width: 100,
            sorter: (a: Opportunity, b: Opportunity) => a.profitPercent - b.profitPercent,
            defaultSortOrder: 'descend' as const,
        },
        {
            title: '24h 交易量',
            dataIndex: ['market', 'volume24hr'],
            key: 'volume24hr',
            render: (v: number) => `$${(v / 1000).toFixed(1)}K`,
            width: 120,
        },
        {
            title: 'YES Ask',
            dataIndex: ['orderbook', 'yesAsk'],
            key: 'yesAsk',
            render: (v: number) => v?.toFixed(4),
            width: 100,
        },
        {
            title: 'NO Ask',
            dataIndex: ['orderbook', 'noAsk'],
            key: 'noAsk',
            render: (v: number) => v?.toFixed(4),
            width: 100,
        },
        {
            title: '操作',
            key: 'action',
            render: (_: any, record: Opportunity) => (
                <Button 
                    type="primary" 
                    danger 
                    size="small" 
                    icon={<ThunderboltOutlined />}
                    onClick={() => handleExecuteClick(record)}
                >
                    执行
                </Button>
            ),
            width: 100,
        }
    ];

    const profitableCount = opportunities.filter((o) => o.profitPercent > 0.5).length;

    // Progress Bar Calculation
    const progressPercent = scanStatus ? Math.floor((scanStatus.progress.current / (scanStatus.progress.total || 1)) * 100) : 0;

    return (
        <div>
            {/* Header & Controls */}
            <div style={{ marginBottom: 24 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                    <Title level={3} style={{ color: '#fff', margin: 0 }}>
                        <ThunderboltOutlined style={{ marginRight: 8 }} />
                        套利雷达
                        <Tag color="blue" style={{ marginLeft: 12, verticalAlign: 'middle' }}>YES+NO=1</Tag>
                    </Title>
                    <Space>
                        <Switch 
                            checkedChildren="自动刷新" 
                            unCheckedChildren="暂停" 
                            checked={autoRefresh} 
                            onChange={setAutoRefresh} 
                        />
                        <Button
                            type="primary"
                            icon={<SyncOutlined spin={loading} />}
                            onClick={() => loadData()}
                            loading={loading}
                        >
                            刷新
                        </Button>
                    </Space>
                </div>

                <Card size="small" style={{ background: '#1f1f1f', borderColor: '#333' }}>
                    <Row gutter={24} align="middle">
                        <Col span={8}>
                            <Text type="secondary" style={{ marginRight: 8 }}>最小利润 (%):</Text>
                            <InputNumber 
                                min={0} max={10} step={0.1} 
                                value={minProfit} 
                                onChange={(v) => setMinProfit(v || 0)}
                                style={{ width: 80 }}
                            />
                        </Col>
                        <Col span={8}>
                            <Text type="secondary" style={{ marginRight: 8 }}>最小交易量 ($):</Text>
                            <InputNumber 
                                min={0} step={100} 
                                value={minVolume} 
                                onChange={(v) => setMinVolume(v || 0)}
                                style={{ width: 100 }}
                            />
                        </Col>
                        <Col span={8} style={{ textAlign: 'right' }}>
                            {scanStatus && (
                                <Text type="secondary">
                                    扫描进度: {scanStatus.progress.current} / {scanStatus.progress.total} 
                                    {scanStatus.progress.current < scanStatus.progress.total && <SyncOutlined spin style={{ marginLeft: 8 }} />}
                                </Text>
                            )}
                        </Col>
                    </Row>
                </Card>
            </div>

            {error && <Alert message="错误" description={error} type="error" showIcon style={{ marginBottom: 16 }} />}

            {/* Stats */}
            <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
                <Col span={8}>
                    <Card className="stat-card">
                        <Statistic
                            title="缓存机会"
                            value={scanStatus?.totalCached || 0}
                            suffix={`/ ${opportunities.length} 展示`}
                            valueStyle={{ color: '#1890ff' }}
                        />
                    </Card>
                </Col>
                <Col span={8}>
                    <Card className="stat-card">
                        <Statistic
                            title="高利润 (>0.5%)"
                            value={profitableCount}
                            valueStyle={{ color: '#52c41a' }}
                        />
                    </Card>
                </Col>
                <Col span={8}>
                    <Card className="stat-card">
                        <Statistic
                            title="最后更新"
                            value={scannedAt ? new Date(scannedAt).toLocaleTimeString() : '-'}
                            valueStyle={{ fontSize: 18 }}
                        />
                    </Card>
                </Col>
            </Row>

            <Table
                dataSource={opportunities}
                columns={columns}
                rowKey={(r) => r.market.conditionId}
                pagination={{ pageSize: 20 }}
                loading={loading && !autoRefresh}
                style={{ background: '#1f1f1f', borderRadius: 8 }}
            />

            <Modal
                title="⚡ 确认套利执行"
                open={modalVisible}
                onOk={handleConfirmExecute}
                onCancel={() => !executing && setModalVisible(false)}
                confirmLoading={executing}
                okText={executing ? "执行中..." : "确认下单"}
                cancelText="取消"
                width={600}
            >
                {selectedOpp && (
                    <div>
                        <Alert
                            message="风险提示"
                            description="套利存在滑点和部分成交风险。系统会自动尝试修复不平衡仓位。"
                            type="warning"
                            showIcon
                            style={{ marginBottom: 16 }}
                        />
                        <Descriptions bordered column={1} size="small">
                            <Descriptions.Item label="市场">{selectedOpp.market.question}</Descriptions.Item>
                            <Descriptions.Item label="策略">{selectedOpp.description}</Descriptions.Item>
                            <Descriptions.Item label="预期利润率">
                                <span style={{ color: 'green', fontWeight: 'bold' }}>
                                    {selectedOpp.profitPercent.toFixed(2)}%
                                </span>
                            </Descriptions.Item>
                            <Descriptions.Item label="YES 价格">{selectedOpp.orderbook.yesAsk}</Descriptions.Item>
                            <Descriptions.Item label="NO 价格">{selectedOpp.orderbook.noAsk}</Descriptions.Item>
                        </Descriptions>
                        
                        <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span style={{ fontWeight: 'bold' }}>交易金额 (USDC):</span>
                            <InputNumber
                                min={1}
                                max={1000}
                                value={tradeSize}
                                onChange={(v) => setTradeSize(v || 10)}
                                addonAfter="$"
                            />
                        </div>
                        <div style={{ marginTop: 10, color: '#888' }}>
                            预计投入: ${(tradeSize * (selectedOpp.orderbook.yesAsk + selectedOpp.orderbook.noAsk)).toFixed(2)}
                        </div>
                    </div>
                )}
            </Modal>
        </div>
    );
}

export default Arbitrage;
