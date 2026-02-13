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
import Crypto15mHedge from './pages/Crypto15mHedge';
import Crypto15mAll from './pages/Crypto15mAll';
import CryptoAll from './pages/CryptoAll';
import CryptoAll2 from './pages/CryptoAll2';
import FollowActivity from './pages/FollowActivity';
import { AccountProvider } from './account/AccountContext';

const { Content } = Layout;

function App() {
    return (
        <BrowserRouter>
            <AccountProvider>
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
                                <Route path="/crypto-15m-hedge" element={<Crypto15mHedge />} />
                                <Route path="/crypto-15m-all" element={<Crypto15mAll />} />
                                <Route path="/crypto-all" element={<CryptoAll />} />
                                <Route path="/crypto-all2" element={<CryptoAll2 />} />
                                <Route path="/follow-activity" element={<FollowActivity />} />
                            </Routes>
                        </Content>
                    </Layout>
                </Layout>
            </AccountProvider>
        </BrowserRouter>
    );
}

export default App;
