import { useEffect, useState } from 'react';
import { Table, Typography, Card, Alert, Button, Tag, Row, Col, Statistic, Modal, InputNumber, message, Descriptions } from 'antd';
import { SyncOutlined, ThunderboltOutlined, DollarOutlined } from '@ant-design/icons';
import { arbitrageApi } from '../api/client';

const { Title } = Typography;

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
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
    const [scannedAt, setScannedAt] = useState<string>('');

    // Execution State
    const [modalVisible, setModalVisible] = useState(false);
    const [selectedOpp, setSelectedOpp] = useState<Opportunity | null>(null);
    const [tradeSize, setTradeSize] = useState<number>(10);
    const [executing, setExecuting] = useState(false);

    useEffect(() => {
        loadData();
    }, []);

    const loadData = async () => {
        try {
            setLoading(true);
            setError(null);
            // Default: minVolume $1000, minProfit 0.3%
            const res = await arbitrageApi.scan(1000, 500, 0.003);
            setOpportunities(res.data.opportunities || []);
            setScannedAt(res.data.scannedAt);
        } catch (err) {
            setError('无法扫描套利机会');
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
                loadData(); // Reload opportunities
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

    if (error) {
        return <Alert message="错误" description={error} type="error" showIcon />;
    }

    return (
        <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
                <Title level={3} style={{ color: '#fff', margin: 0 }}>
                    <ThunderboltOutlined style={{ marginRight: 8 }} />
                    套利 YES+NO=1
                </Title>
                <Button
                    type="primary"
                    icon={<SyncOutlined spin={loading} />}
                    onClick={loadData}
                    loading={loading}
                >
                    刷新扫描
                </Button>
            </div>

            <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
                <Col span={8}>
                    <Card className="stat-card">
                        <Statistic
                            title="发现机会"
                            value={opportunities.length}
                            valueStyle={{ color: '#1890ff' }}
                        />
                    </Card>
                </Col>
                <Col span={8}>
                    <Card className="stat-card">
                        <Statistic
                            title="高利润机会 (>0.5%)"
                            value={profitableCount}
                            valueStyle={{ color: '#52c41a' }}
                        />
                    </Card>
                </Col>
                <Col span={8}>
                    <Card className="stat-card">
                        <Statistic
                            title="最后扫描"
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
                loading={loading}
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
