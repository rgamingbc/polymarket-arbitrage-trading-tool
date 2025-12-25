import { useEffect, useState } from 'react';
import { Table, Typography, Card, Spin, Alert, Button, Tag, Row, Col, Statistic } from 'antd';
import { SyncOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { arbitrageApi } from '../api/client';

const { Title } = Typography;

interface Opportunity {
    market: {
        conditionId: string;
        question: string;
        volume24hr: number;
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
}

function Arbitrage() {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
    const [scannedAt, setScannedAt] = useState<string>('');

    useEffect(() => {
        loadData();
    }, []);

    const loadData = async () => {
        try {
            setLoading(true);
            setError(null);
            const res = await arbitrageApi.scan(5000, 50, 0.001);
            setOpportunities(res.data.opportunities || []);
            setScannedAt(res.data.scannedAt);
        } catch (err) {
            setError('无法扫描套利机会');
        } finally {
            setLoading(false);
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
    ];

    const profitableCount = opportunities.filter((o) => o.profitPercent > 0.5).length;
    const totalPotentialProfit = opportunities.reduce((sum, o) => sum + o.profitPercent, 0);

    if (error) {
        return <Alert message="错误" description={error} type="error" showIcon />;
    }

    return (
        <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
                <Title level={3} style={{ color: '#fff', margin: 0 }}>
                    <ThunderboltOutlined style={{ marginRight: 8 }} />
                    套利扫描
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

            {loading ? (
                <div style={{ textAlign: 'center', padding: 60 }}>
                    <Spin size="large" />
                    <p style={{ marginTop: 16, color: '#888' }}>扫描市场中...</p>
                </div>
            ) : (
                <Table
                    dataSource={opportunities}
                    columns={columns}
                    rowKey={(r) => r.market.conditionId}
                    pagination={{ pageSize: 20 }}
                    style={{ background: '#1f1f1f', borderRadius: 8 }}
                />
            )}
        </div>
    );
}

export default Arbitrage;
