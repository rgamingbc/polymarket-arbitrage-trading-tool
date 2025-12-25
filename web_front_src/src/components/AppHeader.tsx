import { Layout, Typography } from 'antd';
import { LineChartOutlined } from '@ant-design/icons';

const { Header } = Layout;
const { Title } = Typography;

function AppHeader() {
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
                Polymarket Dashboard
            </Title>
        </Header>
    );
}

export default AppHeader;
