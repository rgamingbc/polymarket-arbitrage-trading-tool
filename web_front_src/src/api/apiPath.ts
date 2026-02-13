import { useContext, useMemo } from 'react';
import { AccountContext } from '../account/AccountContext';

export function buildAccountApiPath(activeAccountId: string, path: string) {
    const p = String(path || '').startsWith('/') ? String(path || '') : `/${String(path || '')}`;
    const id = String(activeAccountId || 'default').trim() || 'default';
    return `/accounts/${encodeURIComponent(id)}${p}`;
}

export function useAccountApiPath() {
    const { activeAccountId } = useContext(AccountContext);
    return useMemo(() => {
        return (path: string) => buildAccountApiPath(activeAccountId, path);
    }, [activeAccountId]);
}

