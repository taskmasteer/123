// Server only. Never import this module from the desktop renderer.
import { AppError, type Principal } from '../../../packages/contracts/src/model.js';
import { uuid } from '../../../packages/contracts/src/http.js';
import { authorize } from '../../../packages/core/src/permissions.js';
import type { SupabaseRepository } from '../../../packages/adapters/src/supabase-repository.js';
export type InvitationAttempt = {
    userId: string | null;
    evidence: 'invite' | 'existing' | null;
};
export interface InvitationLedger {
    read(email: string, operationId: string, actor: Principal): Promise<InvitationAttempt | null>;
    claim(email: string, operationId: string, actor: Principal, bound?: InvitationAttempt): Promise<boolean>;
    bind(email: string, operationId: string, actor: Principal, userId: string, evidence: 'invite' | 'existing'): Promise<void>;
}
const attention = (): never => { throw new AppError('NEEDS_ATTENTION', 'Исход приглашения не подтверждён. Получатель должен принять код; затем администратор может повторить приглашение с тем же email и ролью. Письмо повторно не отправлено.'); };
const unavailable = (): never => { throw new AppError('UNAVAILABLE', 'Сервис приглашений временно недоступен.'); };
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : attention();
const normalized = (v: unknown) => typeof v === 'string' ? v.trim().toLowerCase() : null;
const timestamp = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
function identity(value: unknown, email: string, confirmed: boolean, expectedId?: string) {
    const raw = record(value), u = raw.user === undefined ? raw : record(raw.user);
    if (normalized(u.email) !== email || u.aud !== 'authenticated' || u.is_anonymous === true || u.deleted_at ||
        (confirmed && !timestamp(u.email_confirmed_at)) || (expectedId !== undefined && u.id !== expectedId))
        return attention();
    try {
        return uuid(u.id);
    }
    catch {
        return attention();
    }
}
export class SupabaseInvitationProvider {
    private readonly origin: string;
    private readonly headers: Record<string, string>;
    constructor(config: {
        url: string;
        serviceRoleKey: string;
    }, private ledger: InvitationLedger, private fetcher: typeof fetch = fetch) {
        const u = new URL(config.url);
        if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash || !config.serviceRoleKey.trim() || config.serviceRoleKey.startsWith('sb_publishable_'))
            throw new Error('Invalid server invitation configuration');
        this.origin = u.origin;
        this.headers = { apikey: config.serviceRoleKey, authorization: 'Bearer ' + config.serviceRoleKey, 'content-type': 'application/json' };
    }
    private async request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
        try {
            const transport = this.fetcher, response = await transport(this.origin + '/auth/v1' + path, { method, headers: this.headers, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
            if (!response.ok)
                return method === 'POST' ? attention() : unavailable();
            return await response.json();
        }
        catch {
            return method === 'POST' ? attention() : unavailable();
        }
    }
    private async existing(email: string) {
        let found: unknown;
        // Admin API has page/per_page, not an email-filter contract. Bound work; never follow provider URLs.
        for (let page = 1; page <= 1000; page++) {
            const data = record(await this.request(`/admin/users?page=${page}&per_page=100`));
            if (!Array.isArray(data.users) || data.users.length > 100)
                return unavailable();
            for (const value of data.users) {
                const u = record(value);
                if (normalized(u.email) === email) {
                    if (found !== undefined)
                        return attention();
                    found = u;
                }
            }
            if (data.users.length < 100)
                return found;
        }
        return unavailable();
    }
    private async verify(email: string, bound: InvitationAttempt) {
        if (!bound.userId || !bound.evidence)
            return attention();
        const verifiedUserId = identity(await this.request('/admin/users/' + uuid(bound.userId)), email, bound.evidence === 'existing', bound.userId);
        return { verifiedUserId };
    }
    async ensureInvited(email: string, operationId: string, actor: Principal): Promise<{
        verifiedUserId: string;
    }> {
        authorize(actor, 'admin:manage');
        uuid(operationId);
        const previous = await this.ledger.read(email, operationId, actor);
        if (previous?.userId)
            return this.verify(email, previous);
        const existing = await this.existing(email);
        if (existing !== undefined) {
            // A privileged GET, not user_metadata or invited_at, proves a confirmed recipient.
            const id = identity(existing, email, true);
            identity(await this.request('/admin/users/' + id), email, true, id);
            if (previous)
                await this.ledger.bind(email, operationId, actor, id, 'existing');
            else if (!await this.ledger.claim(email, operationId, actor, { userId: id, evidence: 'existing' }))
                return attention();
            return { verifiedUserId: id };
        }
        // An explicit retry may recover a confirmed recipient above, but must never resend an unknown outcome.
        if (previous)
            return attention();
        if (!await this.ledger.claim(email, operationId, actor))
            return attention();
        const invited = await this.request('/invite', 'POST', { email });
        const id = identity(invited, email, false);
        // Only an acknowledged, validated response to THIS claimed POST supplies invite evidence.
        await this.ledger.bind(email, operationId, actor, id, 'invite');
        return this.verify(email, { userId: id, evidence: 'invite' });
    }
    async verifiedIdentity(userId: string) { const value = record(await this.request('/admin/users/' + uuid(userId))), user = value.user === undefined ? value : record(value.user), email = normalized(user.email); if (!email)
        throw new AppError('FORBIDDEN', 'Получатель Auth не подтверждён.'); const id = identity(user, email, true, userId); return { id, email }; }
}
export class PostgresInvitationLedger implements InvitationLedger {
    constructor(private repo: SupabaseRepository) { }
    private async locked<T>(email: string, id: string, actor: Principal, action: (tx: import('../../../packages/adapters/src/supabase-repository.js').SqlTransaction) => Promise<T>) {
        return this.repo.transaction(async (tx) => {
            authorize(await this.repo.fresh(tx, actor), 'admin:manage');
            const row = (await tx.query('select email from private.invitations where id=$1 for update', [id])).rows[0];
            if (row?.email !== email)
                throw new AppError('CONFLICT', 'Приглашение не найдено.');
            return action(tx);
        });
    }
    read(email: string, id: string, actor: Principal) {
        return this.locked(email, id, actor, async (tx) => {
            const r = (await tx.query('select user_id,evidence from private.invitation_attempts where operation_id=$1', [id])).rows[0];
            return r ? { userId: r.user_id, evidence: r.evidence } as InvitationAttempt : null;
        });
    }
    claim(email: string, id: string, actor: Principal, bound?: InvitationAttempt) { return this.locked(email, id, actor, async (tx) => Boolean((await tx.query('insert into private.invitation_attempts(operation_id,user_id,evidence) values($1,$2,$3) on conflict do nothing', [id, bound?.userId ?? null, bound?.evidence ?? null])).rowCount)); }
    bind(email: string, id: string, actor: Principal, userId: string, evidence: 'invite' | 'existing') {
        return this.locked(email, id, actor, async (tx) => {
            const result = await tx.query('update private.invitation_attempts set user_id=$2,evidence=$3 where operation_id=$1 and (user_id is null or (user_id=$2 and evidence=$3))', [id, userId, evidence]);
            if (!result.rowCount)
                throw new AppError('CONFLICT', 'Идентификатор приглашения изменился.');
        });
    }
}
export function configuredInvitations(repo: SupabaseRepository, env: Record<string, string | undefined>, fetcher: typeof fetch = fetch): SupabaseInvitationProvider | undefined {
    if (!env.SUPABASE_SERVICE_ROLE_KEY)
        return undefined;
    if (!env.SUPABASE_URL)
        throw new Error('Missing server Auth origin');
    return new SupabaseInvitationProvider({ url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY }, new PostgresInvitationLedger(repo), fetcher);
}
