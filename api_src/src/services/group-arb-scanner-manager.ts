import fs from 'fs';
import os from 'os';
import path from 'path';
import { AccountManager } from './account-manager.js';
import { GroupArbitrageScanner } from './group-arbitrage.js';
import { config } from '../config.js';

type SetupConfig = { privateKey?: string; proxyAddress?: string };

const normalizeProxyAddress = (raw: unknown): string | undefined => {
    const s = raw != null ? String(raw).trim() : '';
    if (!s) return undefined;
    const head = s.includes('-') ? s.split('-')[0] : s;
    if (/^0x[a-fA-F0-9]{40}$/.test(head)) return head;
    const m2 = s.match(/^(0x[a-fA-F0-9]{40})/);
    if (m2 && m2[1]) return m2[1];
    return undefined;
};

export class GroupArbScannerManager {
    private accountManager: AccountManager;
    private scanners: Map<string, GroupArbitrageScanner> = new Map();

    constructor(accountManager?: AccountManager) {
        this.accountManager = accountManager || new AccountManager();
        this.accountManager.ensureDefaultAccount();
    }

    getAccountManager(): AccountManager {
        return this.accountManager;
    }

    getOrCreateScanner(accountId: string): GroupArbitrageScanner {
        const id = String(accountId || '').trim() || 'default';
        const existing = this.scanners.get(id);
        if (existing) return existing;
        const setup = this.loadSetupConfig(id);
        if (id === 'default' && setup.proxyAddress) {
            process.env.POLY_PROXY_ADDRESS = String(setup.proxyAddress);
        }
        const fallbackKey =
            id === 'default' && config.polymarket.privateKey && String(config.polymarket.privateKey).trim()
                ? String(config.polymarket.privateKey).trim()
                : undefined;
        const effectiveKey = setup.privateKey || fallbackKey;
        const scanner = new GroupArbitrageScanner({ privateKey: effectiveKey, proxyAddress: setup.proxyAddress, accountId: id });
        scanner.start();
        this.scanners.set(id, scanner);
        return scanner;
    }

    shutdownScanner(accountId: string): void {
        const id = String(accountId || '').trim() || 'default';
        const s = this.scanners.get(id);
        if (!s) return;
        try {
            (s as any).shutdown?.();
        } catch {
        }
        this.scanners.delete(id);
    }

    getSetupStatus(accountId: string) {
        const scanner = this.getOrCreateScanner(accountId);
        const status = this.accountManager.getAccountStatus(accountId);
        return {
            ...status,
            hasPrivateKey: (scanner as any).hasPrivateKey ? (scanner as any).hasPrivateKey() : status.hasPrivateKey,
            eoaAddress: (scanner as any).getEoaAddress ? (scanner as any).getEoaAddress() : status.eoaAddress,
            funderAddress: (scanner as any).getFunderAddress ? (scanner as any).getFunderAddress() : status.funderAddress,
            proxyAddress: status.proxyAddress,
            trading: (scanner as any).getTradingInitStatus ? (scanner as any).getTradingInitStatus() : null,
        };
    }

    persistSetupConfig(accountId: string, cfg: SetupConfig): void {
        const id = String(accountId || '').trim() || 'default';
        const setupPath = this.accountManager.getSetupConfigPath(id);
        const dir = this.accountManager.getAccountDir(id);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(setupPath, JSON.stringify({ privateKey: cfg.privateKey || null, proxyAddress: cfg.proxyAddress || null }), { encoding: 'utf8', mode: 0o600 });
        try { fs.chmodSync(setupPath, 0o600); } catch {}
    }

    loadSetupConfig(accountId: string): SetupConfig {
        const id = String(accountId || '').trim() || 'default';
        const setupPath = this.accountManager.getSetupConfigPath(id);
        const readFile = (p: string): SetupConfig => {
            try {
                if (!fs.existsSync(p)) return {};
                const raw = fs.readFileSync(p, 'utf8');
                const parsed = JSON.parse(String(raw || '{}'));
                const privateKey = parsed?.privateKey != null ? String(parsed.privateKey).trim() : undefined;
                const proxyAddress = normalizeProxyAddress(parsed?.proxyAddress);
                return { privateKey: privateKey || undefined, proxyAddress };
            } catch {
                return {};
            }
        };

        const primary = readFile(setupPath);
        if (id !== 'default') return primary;

        const envProxy = normalizeProxyAddress(process.env.POLY_PROXY_ADDRESS);
        const legacySetupPath = process.env.POLY_SETUP_CONFIG_PATH
            ? String(process.env.POLY_SETUP_CONFIG_PATH)
            : path.join(os.tmpdir(), 'polymarket-tools', 'setup.json');
        const legacy = readFile(legacySetupPath);

        const merged: SetupConfig = {
            privateKey: primary.privateKey || legacy.privateKey || undefined,
            proxyAddress: primary.proxyAddress || envProxy || legacy.proxyAddress || undefined,
        };

        const needsPersist = (!primary.privateKey && !!merged.privateKey) || (!primary.proxyAddress && !!merged.proxyAddress);
        if (needsPersist && (merged.privateKey || merged.proxyAddress)) {
            try {
                this.persistSetupConfig(id, merged);
            } catch {
            }
        }

        return merged;
    }
}
