import { useEffect, useState } from 'react';
import { Row, Col, Card, Statistic, Table, Typography, Spin, Alert } from 'antd';
import { ArrowUpOutlined, ArrowDownOutlined, FireOutlined, DollarOutlined } from '@ant-design/icons';
import { marketApi, arbitrageApi, walletApi } from '../api/client';

const { Title } = Typography;

interface Market {
    conditionId: string;
    question: string;
    slug: string;
    volume24hr: number;
}

interface Opportunity {
    market: { question: string; volume24hr: number };
    arbType: string;
    profitPercent: number;
}

function Dashboard() {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [trendingMarkets, setTrendingMarkets] = useState<Market[]>([]);
    const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
    const [stats, setStats] = useState({
        totalMarkets: 0,
        totalOpportunities: 0,
        bestProfit: 0,
    });

    useEffect(() => {
        loadData();
    }, []);

    const loadData = async () => {
        try {
            setLoading(true);
            setError(null);

            const [marketsRes, arbRes] = await Promise.all([
                marketApi.getTrending(10),
                arbitrageApi.scan(5000, 30, 0.001),
            ]);

            setTrendingMarkets(marketsRes.data);
            setOpportunities(arbRes.data.opportunities || []);
            setStats({
                totalMarkets: marketsRes.data.length,
                totalOpportunities: arbRes.data.count || 0,
                bestProfit: arbRes.data.opportunities?.[0]?.profitPercent || 0,
            });
        } catch (err) {
            setError('无法连接到 API 服务。请确保 api_src 服务已启动 (端口 3000)');
        } finally {
            setLoading(false);
        }
    };

    const marketColumns = [
        {
            title: '市场',
            dataIndex: 'question',
            key: 'question',
            ellipsis: true,
        },
        {
            title: '24h 交易量',
            dataIndex: 'volume24hr',
            key: 'volume24hr',
            render: (v: number) => `$${(v / 1000).toFixed(1)}K`,
            width: 120,
        },
    ];

    const arbColumns = [
        {
            title: '市场',
            dataIndex: ['market', 'question'],
            key: 'question',
            ellipsis: true,
        },
        {
            title: '类型',
            dataIndex: 'arbType',
            key: 'arbType',
            render: (t: string) => t === 'long' ? '多头' : '空头',
            width: 80,
        },
        {
            title: '利润',
            dataIndex: 'profitPercent',
            key: 'profitPercent',
            render: (v: number) => (
                <span style={{ color: '#52c41a' }}>+{v.toFixed(2)}%</span>
            ),
            width: 100,
        },
    ];

    if (loading) {
        return (
            <div style={{ textAlign: 'center', padding: 100 }}>
                <Spin size="large" />
                <p style={{ marginTop: 16, color: '#888' }}>加载数据中...</p>
            </div>
        );
    }

    if (error) {
        return (
            <Alert
                message="连接错误"
                description={error}
                type="error"
                showIcon
                action={
                    <a onClick={loadData}>重试</a>
                }
            />
        );
    }

    return (
        <div>
            <Title level={3} style={{ color: '#fff', marginBottom: 24 }}>
                仪表盘
            </Title>

            <Row gutter={[16, 16]}>
                <Col span={8}>
                    <Card className="stat-card">
                        <Statistic
                            title="热门市场"
                            value={stats.totalMarkets}
                            prefix={<FireOutlined style={{ color: '#ff4d4f' }} />}
                        />
                    </Card>
                </Col>
                <Col span={8}>
                    <Card className="stat-card">
                        <Statistic
                            title="套利机会"
                            value={stats.totalOpportunities}
                            prefix={<DollarOutlined style={{ color: '#52c41a' }} />}
                        />
                    </Card>
                </Col>
                <Col span={8}>
                    <Card className="stat-card">
                        <Statistic
                            title="最佳利润"
                            value={stats.bestProfit}
                            precision={2}
                            suffix="%"
                            valueStyle={{ color: stats.bestProfit > 0 ? '#52c41a' : '#888' }}
                            prefix={stats.bestProfit > 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />}
                        />
                    </Card>
                </Col>
            </Row>

            <Row gutter={[16, 16]} style={{ marginTop: 24 }}>
                <Col span={12}>
                    <Card title="🔥 热门市场" bordered={false} style={{ background: '#1f1f1f' }}>
                        <Table
                            dataSource={trendingMarkets}
                            columns={marketColumns}
                            pagination={false}
                            size="small"
                            rowKey="conditionId"
                        />
                    </Card>
                </Col>
                <Col span={12}>
                    <Card title="💰 套利机会" bordered={false} style={{ background: '#1f1f1f' }}>
                        <Table
                            dataSource={opportunities.slice(0, 10)}
                            columns={arbColumns}
                            pagination={false}
                            size="small"
                            rowKey={(r) => r.market.question}
                        />
                    </Card>
                </Col>
            </Row>
        </div>
    );
}

export default Dashboard;
