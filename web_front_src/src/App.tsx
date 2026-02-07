import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from 'antd';
import AppHeader from './components/AppHeader';
import Sidebar from './components/Sidebar';
import Dashboard from './pages/Dashboard';
import Markets from './pages/Markets';
import Arbitrage from './pages/Arbitrage';
import Wallets from './pages/Wallets';
import WhaleDiscovery from './pages/WhaleDiscovery';
import TopWhaleDiscovery from './pages/TopWhaleDiscovery';
import WatchedWhales from './pages/WatchedWhales';
import Advanced from './pages/Advanced'; // Advanced Strategy
import Crypto15m from './pages/Crypto15m';
import CryptoAll from './pages/CryptoAll';
import CryptoAll2 from './pages/CryptoAll2';

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
                            <Route path="/whale" element={<WhaleDiscovery />} />
                            <Route path="/top-whale" element={<TopWhaleDiscovery />} />
                            <Route path="/watched-whales" element={<WatchedWhales />} />
                            <Route path="/advanced" element={<Advanced />} />
                            <Route path="/crypto-15m" element={<Crypto15m />} />
                            <Route path="/crypto-all" element={<CryptoAll />} />
                            <Route path="/crypto-all2" element={<CryptoAll2 />} />
                        </Routes>
                    </Content>
                </Layout>
            </Layout>
        </BrowserRouter>
    );
}

export default App;
