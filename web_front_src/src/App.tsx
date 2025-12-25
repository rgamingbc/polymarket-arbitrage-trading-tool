import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from 'antd';
import AppHeader from './components/AppHeader';
import Sidebar from './components/Sidebar';
import Dashboard from './pages/Dashboard';
import Markets from './pages/Markets';
import Arbitrage from './pages/Arbitrage';
import Wallets from './pages/Wallets';

const { Content } = Layout;

function App() {
    return (
        <BrowserRouter>
            <Layout style={{ minHeight: '100vh' }}>
                <AppHeader />
                <Layout>
                    <Sidebar />
                    <Content style={{ padding: '24px', background: '#141414' }}>
                        <Routes>
                            <Route path="/" element={<Navigate to="/dashboard" replace />} />
                            <Route path="/dashboard" element={<Dashboard />} />
                            <Route path="/markets" element={<Markets />} />
                            <Route path="/arbitrage" element={<Arbitrage />} />
                            <Route path="/wallets" element={<Wallets />} />
                        </Routes>
                    </Content>
                </Layout>
            </Layout>
        </BrowserRouter>
    );
}

export default App;
