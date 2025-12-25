import { useEffect, useState } from 'react';
import { Table, Typography, Spin, Alert, Card, Row, Col, Tag } from 'antd';
import { TrophyOutlined, UserOutlined } from '@ant-design/icons';
import { walletApi } from '../api/client';

const { Title } = Typography;

interface Trader {
    rank: number;
    address: string;
    pnl: number;
    volume: number;
}

function Wallets() {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [traders, setTraders] = useState<Trader[]>([]);

    useEffect(() => {
        loadData();
    }, []);

    const loadData = async () => {
        try {
            setLoading(true);
            const res = await walletApi.getLeaderboard(20);
            setTraders(res.data);
        } catch (err) {
            setError('无法加载排行榜数据');
        } finally {
            setLoading(false);
        }
    };

    const formatAmount = (amount: number) => {
        if (Math.abs(amount) >= 1000000) {
            return `$${(amount / 1000000).toFixed(2)}M`;
        }
        if (Math.abs(amount) >= 1000) {
            return `$${(amount / 1000).toFixed(1)}K`;
        }
        return `$${amount.toFixed(0)}`;
    };

    const columns = [
        {
            title: '排名',
            dataIndex: 'rank',
            key: 'rank',
            render: (rank: number) => {
                if (rank === 1) return <Tag color="gold"><TrophyOutlined /> 1</Tag>;
                if (rank === 2) return <Tag color="silver">2</Tag>;
                if (rank === 3) return <Tag color="orange">3</Tag>;
                return <Tag>#{rank}</Tag>;
            },
            width: 80,
        },
        {
            title: '地址',
            dataIndex: 'address',
            key: 'address',
            render: (addr: string) => (
                <span style={{ fontFamily: 'monospace' }}>
                    <UserOutlined style={{ marginRight: 8 }} />
                    {addr?.slice(0, 8)}...{addr?.slice(-6)}
                </span>
            ),
        },
        {
            title: '盈亏',
            dataIndex: 'pnl',
            key: 'pnl',
            render: (pnl: number) => (
                <span style={{ color: pnl >= 0 ? '#52c41a' : '#ff4d4f', fontWeight: 'bold' }}>
                    {pnl >= 0 ? '+' : ''}{formatAmount(pnl)}
                </span>
            ),
            width: 140,
            sorter: (a: Trader, b: Trader) => a.pnl - b.pnl,
        },
        {
            title: '交易量',
            dataIndex: 'volume',
            key: 'volume',
            render: (v: number) => formatAmount(v),
            width: 140,
        },
    ];

    if (loading) {
        return (
            <div style={{ textAlign: 'center', padding: 100 }}>
                <Spin size="large" />
            </div>
        );
    }

    if (error) {
        return <Alert message="错误" description={error} type="error" showIcon />;
    }

    const topTrader = traders[0];

    return (
        <div>
            <Title level={3} style={{ color: '#fff', marginBottom: 24 }}>
                <TrophyOutlined style={{ marginRight: 8 }} />
                交易员排行榜
            </Title>

            {topTrader && (
                <Card
                    style={{ marginBottom: 24, background: 'linear-gradient(135deg, #1f1f1f 0%, #2a2a2a 100%)' }}
                    bordered={false}
                >
                    <Row gutter={16} align="middle">
                        <Col>
                            <div style={{
                                width: 60,
                                height: 60,
                                borderRadius: '50%',
                                background: 'linear-gradient(135deg, #ffd700 0%, #ff8c00 100%)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontSize: 24,
                            }}>
                                🏆
                            </div>
                        </Col>
                        <Col flex={1}>
                            <div style={{ color: '#888', fontSize: 12 }}>第一名</div>
                            <div style={{ fontSize: 18, fontFamily: 'monospace' }}>
                                {topTrader.address?.slice(0, 10)}...{topTrader.address?.slice(-8)}
                            </div>
                        </Col>
                        <Col>
                            <div style={{ textAlign: 'right' }}>
                                <div style={{ color: '#888', fontSize: 12 }}>盈利</div>
                                <div style={{ fontSize: 24, color: '#52c41a', fontWeight: 'bold' }}>
                                    {formatAmount(topTrader.pnl)}
                                </div>
                            </div>
                        </Col>
                    </Row>
                </Card>
            )}

            <Table
                dataSource={traders}
                columns={columns}
                rowKey="address"
                pagination={{ pageSize: 20 }}
                style={{ background: '#1f1f1f', borderRadius: 8 }}
            />
        </div>
    );
}

export default Wallets;
