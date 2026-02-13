import { FastifyPluginAsync } from 'fastify';
import { AccountManager } from '../services/account-manager.js';

const manager = new AccountManager();

export const accountsRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.get('/', {
        schema: {
            tags: ['Accounts'],
            summary: 'List accounts',
        },
        handler: async () => {
            const accounts = manager.listAccounts();
            return { success: true, stateDir: manager.getStateDir(), accounts };
        }
    });

    fastify.post('/', {
        schema: {
            tags: ['Accounts'],
            summary: 'Create account',
            body: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                },
            }
        },
        handler: async (request, reply) => {
            try {
                const b = (request.body || {}) as any;
                const name = b?.name != null ? String(b.name).trim() : '';
                const acc = manager.createAccount({ name });
                return { success: true, account: { ...acc, status: manager.getAccountStatus(acc.id) } };
            } catch (e: any) {
                return reply.status(400).send({ success: false, error: e?.message || String(e) });
            }
        }
    });

    fastify.patch('/:accountId', {
        schema: {
            tags: ['Accounts'],
            summary: 'Rename account',
            params: {
                type: 'object',
                properties: {
                    accountId: { type: 'string' },
                },
                required: ['accountId'],
            },
            body: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                },
                required: ['name'],
            }
        },
        handler: async (request, reply) => {
            try {
                const p = request.params as any;
                const id = String(p?.accountId || '').trim();
                const b = (request.body || {}) as any;
                const name = String(b?.name || '').trim();
                const acc = manager.renameAccount(id, { name });
                return { success: true, account: { ...acc, status: manager.getAccountStatus(acc.id) } };
            } catch (e: any) {
                return reply.status(400).send({ success: false, error: e?.message || String(e) });
            }
        }
    });

    fastify.delete('/:accountId', {
        schema: {
            tags: ['Accounts'],
            summary: 'Delete account and its local data',
            params: {
                type: 'object',
                properties: {
                    accountId: { type: 'string' },
                },
                required: ['accountId'],
            },
        },
        handler: async (request, reply) => {
            try {
                const p = request.params as any;
                const id = String(p?.accountId || '').trim();
                manager.deleteAccount(id);
                return { success: true };
            } catch (e: any) {
                return reply.status(400).send({ success: false, error: e?.message || String(e) });
            }
        }
    });
};

