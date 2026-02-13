import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'node:crypto';
import { Wallet } from 'ethers';

export type AccountRecord = {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
};

export type AccountStatus = {
    hasPrivateKey: boolean;
    eoaAddress: string | null;
    proxyAddress: string | null;
    funderAddress: string | null;
    setupConfigPath: string;
    setupConfigFilePresent: boolean;
};

export type AccountListItem = AccountRecord & {
    status: AccountStatus;
};

type AccountsIndex = {
    version: 1;
    accounts: AccountRecord[];
};

const normalizeProxyAddress = (raw: unknown): string | undefined => {
    const s = raw != null ? String(raw).trim() : '';
    if (!s) return undefined;
    const head = s.includes('-') ? s.split('-')[0] : s;
    if (/^0x[a-fA-F0-9]{40}$/.test(head)) return head;
    const m2 = s.match(/^(0x[a-fA-F0-9]{40})/);
    if (m2 && m2[1]) return m2[1];
    return undefined;
};

export class AccountManager {
    private stateDir: string;
    private accountsDir: string;
    private indexPath: string;

    constructor(options?: { stateDir?: string }) {
        const envDir = process.env.POLY_STATE_DIR != null ? String(process.env.POLY_STATE_DIR).trim() : '';
        const fallback = path.join(os.tmpdir(), 'polymarket-tools');
        const base = (options?.stateDir && String(options.stateDir).trim()) || envDir || fallback;
        this.stateDir = path.isAbsolute(base) ? base : path.resolve(process.cwd(), base);
        this.accountsDir = path.join(this.stateDir, 'accounts');
        this.indexPath = path.join(this.accountsDir, 'index.json');
        this.ensureInitialized();
    }

    getStateDir(): string {
        return this.stateDir;
    }

    getAccountDir(accountId: string): string {
        const id = String(accountId || '').trim();
        if (!id) throw new Error('Missing accountId');
        return path.join(this.accountsDir, id);
    }

    getSetupConfigPath(accountId: string): string {
        return path.join(this.getAccountDir(accountId), 'setup.json');
    }

    listAccounts(): AccountListItem[] {
        const idx = this.readIndex();
        return idx.accounts.map((a) => ({
            ...a,
            status: this.getAccountStatus(a.id),
        }));
    }

    getAccount(accountId: string): AccountRecord {
        const id = String(accountId || '').trim();
        if (!id) throw new Error('Missing accountId');
        const idx = this.readIndex();
        const acc = idx.accounts.find((a) => a.id === id);
        if (!acc) throw new Error(`Unknown accountId: ${id}`);
        return acc;
    }

    createAccount(options: { name?: string }): AccountRecord {
        const name = (options?.name != null ? String(options.name) : '').trim() || 'Account';
        const now = new Date().toISOString();
        const id = crypto.randomUUID();
        const acc: AccountRecord = { id, name, createdAt: now, updatedAt: now };
        const idx = this.readIndex();
        idx.accounts.push(acc);
        this.writeIndex(idx);
        fs.mkdirSync(this.getAccountDir(id), { recursive: true });
        return acc;
    }

    renameAccount(accountId: string, options: { name: string }): AccountRecord {
        const id = String(accountId || '').trim();
        if (!id) throw new Error('Missing accountId');
        const name = (options?.name != null ? String(options.name) : '').trim();
        if (!name) throw new Error('Missing name');
        const idx = this.readIndex();
        const i = idx.accounts.findIndex((a) => a.id === id);
        if (i < 0) throw new Error(`Unknown accountId: ${id}`);
        const next = { ...idx.accounts[i], name, updatedAt: new Date().toISOString() };
        idx.accounts[i] = next;
        this.writeIndex(idx);
        return next;
    }

    deleteAccount(accountId: string): void {
        const id = String(accountId || '').trim();
        if (!id) throw new Error('Missing accountId');
        const idx = this.readIndex();
        const nextAccounts = idx.accounts.filter((a) => a.id !== id);
        if (nextAccounts.length === idx.accounts.length) throw new Error(`Unknown accountId: ${id}`);
        if (!nextAccounts.length) throw new Error('Cannot delete last account');
        this.writeIndex({ ...idx, accounts: nextAccounts });
        const dir = this.getAccountDir(id);
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {
        }
    }

    ensureDefaultAccount(): AccountRecord {
        const idx = this.readIndex();
        if (idx.accounts.length) return idx.accounts[0];
        const now = new Date().toISOString();
        const acc: AccountRecord = { id: 'default', name: 'Default', createdAt: now, updatedAt: now };
        idx.accounts.push(acc);
        this.writeIndex(idx);
        fs.mkdirSync(this.getAccountDir(acc.id), { recursive: true });
        return acc;
    }

    getAccountStatus(accountId: string): AccountStatus {
        const setupConfigPath = this.getSetupConfigPath(accountId);
        const setupConfigFilePresent = fs.existsSync(setupConfigPath);
        let privateKey: string | undefined;
        let proxyAddress: string | undefined;
        try {
            if (setupConfigFilePresent) {
                const raw = fs.readFileSync(setupConfigPath, 'utf8');
                const parsed = JSON.parse(String(raw || '{}'));
                privateKey = parsed?.privateKey != null ? String(parsed.privateKey).trim() : undefined;
                proxyAddress = normalizeProxyAddress(parsed?.proxyAddress);
            }
        } catch {
        }
        const hasPrivateKey = !!(privateKey && privateKey.trim());
        let eoaAddress: string | null = null;
        if (hasPrivateKey) {
            try {
                eoaAddress = new Wallet(String(privateKey)).address;
            } catch {
                eoaAddress = null;
            }
        }
        const proxy = proxyAddress ? String(proxyAddress) : null;
        const funderAddress = proxy || eoaAddress;
        return {
            hasPrivateKey,
            eoaAddress,
            proxyAddress: proxy,
            funderAddress,
            setupConfigPath,
            setupConfigFilePresent,
        };
    }

    private ensureInitialized(): void {
        fs.mkdirSync(this.accountsDir, { recursive: true });
        if (!fs.existsSync(this.indexPath)) {
            const idx: AccountsIndex = { version: 1, accounts: [] };
            fs.writeFileSync(this.indexPath, JSON.stringify(idx, null, 2), { encoding: 'utf8', mode: 0o600 });
            try { fs.chmodSync(this.indexPath, 0o600); } catch {}
        }
        this.ensureDefaultAccount();
    }

    private readIndex(): AccountsIndex {
        try {
            const raw = fs.readFileSync(this.indexPath, 'utf8');
            const parsed = JSON.parse(String(raw || '{}'));
            const version = parsed?.version === 1 ? 1 : 1;
            const accounts = Array.isArray(parsed?.accounts) ? parsed.accounts : [];
            const normalized: AccountRecord[] = accounts
                .map((a: any) => ({
                    id: a?.id != null ? String(a.id).trim() : '',
                    name: a?.name != null ? String(a.name).trim() : 'Account',
                    createdAt: a?.createdAt != null ? String(a.createdAt) : new Date().toISOString(),
                    updatedAt: a?.updatedAt != null ? String(a.updatedAt) : new Date().toISOString(),
                }))
                .filter((a: AccountRecord) => !!a.id);
            return { version, accounts: normalized };
        } catch {
            return { version: 1, accounts: [] };
        }
    }

    private writeIndex(idx: AccountsIndex): void {
        const dir = path.dirname(this.indexPath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(this.indexPath, JSON.stringify({ version: 1, accounts: idx.accounts }, null, 2), { encoding: 'utf8', mode: 0o600 });
        try { fs.chmodSync(this.indexPath, 0o600); } catch {}
    }
}

