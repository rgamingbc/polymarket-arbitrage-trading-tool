import { Layout, Select, Space, Typography } from 'antd';
import { LineChartOutlined } from '@ant-design/icons';
import { useContext, useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import { AccountContext } from '../account/AccountContext';

const { Header } = Layout;
const { Title } = Typography;

function AppHeader() {
    const { activeAccountId, setActiveAccountId } = useContext(AccountContext);
    const [accounts, setAccounts] = useState<any[]>([]);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        let mounted = true;
        const run = async () => {
            setLoading(true);
            try {
                const res = await api.get('/accounts');
                const list = Array.isArray(res.data?.accounts) ? res.data.accounts : [];
                if (mounted) setAccounts(list);
            } catch {
                if (mounted) setAccounts([]);
            } finally {
                if (mounted) setLoading(false);
            }
        };
        run();
        return () => {
            mounted = false;
        };
    }, []);

    const options = useMemo(() => {
        const list = Array.isArray(accounts) ? accounts : [];
        return list.map((a: any) => {
            const id = String(a?.id || '').trim() || 'default';
            const name = String(a?.name || id);
            const funder = String(a?.status?.funderAddress || '');
            const label = funder ? `${name} (${funder.slice(0, 6)}…${funder.slice(-4)})` : name;
            return { value: id, label };
        });
    }, [accounts]);

    return (
        <Header
            style={{
                background: '#1f1f1f',
                borderBottom: '1px solid #333',
                display: 'flex',
                alignItems: 'center',
                padding: '0 24px',
            }}
        >
            <LineChartOutlined style={{ fontSize: 24, color: '#1890ff', marginRight: 12 }} />
            <Title level={4} style={{ margin: 0, color: '#fff' }}>
                FK Polymarket Tools
            </Title>
            <div style={{ flex: 1 }} />
            <Space>
                <Select
                    showSearch
                    style={{ width: 320, maxWidth: '60vw' }}
                    loading={loading}
                    value={activeAccountId}
                    onChange={(v) => setActiveAccountId(String(v || 'default'))}
                    options={options}
                    placeholder="Account"
                    filterOption={(input, option) => String((option as any)?.label || '').toLowerCase().includes(String(input || '').toLowerCase())}
                />
            </Space>
        </Header>
    );
}

export default AppHeader;
