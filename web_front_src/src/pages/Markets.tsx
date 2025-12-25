import { useEffect, useState } from 'react';
import { Table, Typography, Input, Spin, Alert, Tag } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { marketApi } from '../api/client';

const { Title } = Typography;
const { Search } = Input;

interface Market {
    conditionId: string;
    question: string;
    slug: string;
    volume24hr: number;
}

function Markets() {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [markets, setMarkets] = useState<Market[]>([]);
    const [searchText, setSearchText] = useState('');

    useEffect(() => {
        loadMarkets();
    }, []);

    const loadMarkets = async () => {
        try {
            setLoading(true);
            const res = await marketApi.getTrending(50);
            setMarkets(res.data);
        } catch (err) {
            setError('无法加载市场数据');
        } finally {
            setLoading(false);
        }
    };

    const filteredMarkets = markets.filter((m) =>
        m.question?.toLowerCase().includes(searchText.toLowerCase())
    );

    const columns = [
        {
            title: '市场问题',
            dataIndex: 'question',
            key: 'question',
            ellipsis: true,
        },
        {
            title: '24h 交易量',
            dataIndex: 'volume24hr',
            key: 'volume24hr',
            render: (v: number) => {
                if (v >= 100000) return <Tag color="gold">${(v / 1000).toFixed(0)}K</Tag>;
                if (v >= 10000) return <Tag color="blue">${(v / 1000).toFixed(0)}K</Tag>;
                return <Tag>${(v / 1000).toFixed(1)}K</Tag>;
            },
            width: 140,
            sorter: (a: Market, b: Market) => (a.volume24hr || 0) - (b.volume24hr || 0),
        },
        {
            title: 'Condition ID',
            dataIndex: 'conditionId',
            key: 'conditionId',
            render: (id: string) => id?.slice(0, 16) + '...',
            width: 180,
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

    return (
        <div>
            <Title level={3} style={{ color: '#fff', marginBottom: 24 }}>
                市场列表
            </Title>

            <Search
                placeholder="搜索市场..."
                prefix={<SearchOutlined />}
                style={{ marginBottom: 16, maxWidth: 400 }}
                onChange={(e) => setSearchText(e.target.value)}
                allowClear
            />

            <Table
                dataSource={filteredMarkets}
                columns={columns}
                rowKey="conditionId"
                pagination={{ pageSize: 20 }}
                style={{ background: '#1f1f1f', borderRadius: 8 }}
            />
        </div>
    );
}

export default Markets;
