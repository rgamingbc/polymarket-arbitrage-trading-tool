import React, { createContext, useCallback, useEffect, useMemo, useState } from 'react';

type AccountContextValue = {
    activeAccountId: string;
    setActiveAccountId: (id: string) => void;
};

const STORAGE_KEY = 'pm_active_account_id';
const EVENT_NAME = 'pm_active_account_id_changed';

export const AccountContext = createContext<AccountContextValue>({
    activeAccountId: 'default',
    setActiveAccountId: () => { },
});

export function AccountProvider(props: { children: React.ReactNode }) {
    const [activeAccountId, setActiveAccountIdState] = useState<string>(() => {
        try {
            return String(localStorage.getItem(STORAGE_KEY) || 'default') || 'default';
        } catch {
            return 'default';
        }
    });

    const setActiveAccountId = useCallback((idRaw: string) => {
        const id = String(idRaw || 'default').trim() || 'default';
        setActiveAccountIdState(id);
        try {
            localStorage.setItem(STORAGE_KEY, id);
        } catch {
        }
        try {
            window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { activeAccountId: id } }));
        } catch {
        }
    }, []);

    useEffect(() => {
        const onStorage = (e: StorageEvent) => {
            if (e.key !== STORAGE_KEY) return;
            const id = String(e.newValue || 'default').trim() || 'default';
            setActiveAccountIdState(id);
        };
        const onCustom = (e: any) => {
            const id = String(e?.detail?.activeAccountId || 'default').trim() || 'default';
            setActiveAccountIdState(id);
        };
        window.addEventListener('storage', onStorage);
        window.addEventListener(EVENT_NAME, onCustom as any);
        return () => {
            window.removeEventListener('storage', onStorage);
            window.removeEventListener(EVENT_NAME, onCustom as any);
        };
    }, []);

    const value = useMemo(() => ({ activeAccountId, setActiveAccountId }), [activeAccountId, setActiveAccountId]);

    return (
        <AccountContext.Provider value={value}>
            {props.children}
        </AccountContext.Provider>
    );
}

