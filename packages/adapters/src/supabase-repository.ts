import { sitePagePrefix, siteFilters, filterBinding, encodeCursor, decodeCursor, type SiteFilters } from '../../core/src/site-pagination.js';
// Server only: no service credential or SQL driver belongs in the renderer graph.
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AppError } from '../../contracts/src/model.js';
import type { Site, SiteInput, SitePatch, Principal, Role, Job, Lease, Revision } from '../../contracts/src/model.js';
import type { EditingState, EditingStore } from '../../contracts/src/editing.js';
import { normalizeDomain } from '../../core/src/sites.js';
import { authorize } from '../../core/src/permissions.js';
import { parseSiteInput, parseSitePatch } from '../../contracts/src/inputs.js';
import { completeVisualAcceptance, failVisualAcceptance, installedVisualAcceptance, type VisualAcceptanceReceipt } from '../../core/src/visual/acceptance.js';
import type { Candidate } from '../../contracts/src/editing.js';
export type SqlTransaction = PoolClient;
/** Task8 must lock sites -> workers -> jobs -> site_operations; sample clock_timestamp AFTER locks. */
export interface LeaseAuthority {
    assertCurrent(tx: SqlTransaction, workerId: string, lease: Lease): Promise<{
        jobId: string;
        siteId: string;
        generation: number;
    }>;
}
/** Task8 supplies this writer. Worker authority, durable admission and revision CAS must share one transaction. */
export interface WorkerSiteMutation {
    compareAndSet(workerId: string, lease: Lease, expectedRevision: number, patch: SitePatch): Promise<Site>;
}
export interface Admission {
    siteId: string;
    token: string;
    actor: Principal;
}
type DbSite = {
    id: string;
    domain: string;
    owner_id: string;
    input: SiteInput;
    revision: number;
    draft_id: string | null;
    published_id: string | null;
    generation_status: string;
    domain_status: string;
    assigned: string[];
};
const siteSelect = `select s.*,coalesce((select array_agg(distinct a.user_id) from (select user_id from public.assignments where site_id=s.id union select a.user_id from private.batch_assignments a join private.batch_rows r on r.batch_id=a.batch_id where r.site_id=s.id) a),'{}') assigned from public.sites s`;
function site(row: DbSite): Site { return { id: row.id, domain: row.domain, ownerId: row.owner_id, assignedUserIds: row.assigned, input: row.input, revision: row.revision, draftId: row.draft_id, publishedId: row.published_id, generationStatus: row.generation_status, domainStatus: row.domain_status }; }
const snapshotModes = new WeakMap<Pool, 'direct' | 'session' | 'transaction' | 'unknown'>();
/** Trusted deployment declaration, never inferred from URL/port or a lock probe. */
export function configureSnapshotConnection(pool: Pool, mode: unknown) { snapshotModes.set(pool, mode === 'direct' || mode === 'session' || mode === 'transaction' ? mode : 'unknown'); return pool; }
export class SupabaseRepository {
    constructor(readonly pool: Pool) { }
    requireSnapshotConnection() { const mode = snapshotModes.get(this.pool); if (mode !== 'direct' && mode !== 'session')
        throw new AppError('UNAVAILABLE', 'Для согласованной копии DATABASE_CONNECTION_MODE должен явно указывать direct или session. Transaction pooler и неизвестный режим не поддерживают сессионную блокировку.'); }
    /** Session fence precedes BEGIN RR: the MVCC snapshot must be AFTER a queued collector. */
    async captureSnapshot<T>(action: (tx: SqlTransaction) => Promise<T>, freshAfterCommit: (tx: SqlTransaction) => Promise<void>): Promise<T> { this.requireSnapshotConnection(); const tx = await this.pool.connect(), started = performance.now(), guard = () => { if (performance.now() - started > 105000)
        throw new AppError('NEEDS_ATTENTION', 'Снимок превысил двухминутный бюджет SQL; источник сохранён.'); }, bounded = new Proxy(tx, { get(target, key) { if (key === 'query')
            return (...args: any[]) => { guard(); return (target.query as any)(...args); }; const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } }); let locked = false, open = false, result: T | undefined, failure: unknown, destroy: Error | undefined; try {
        await tx.query("set statement_timeout='15s'");
        await tx.query('select pg_advisory_lock_shared(73212,1)');
        locked = true;
        await tx.query('begin isolation level repeatable read');
        open = true;
        await tx.query("set local work_mem='4MB'");
        result = await action(bounded);
        guard();
        await tx.query('commit');
        open = false;
        await freshAfterCommit(bounded);
    }
    catch (error) {
        failure = error;
        if (!locked)
            destroy = error instanceof Error ? error : new Error('Uncertain snapshot fence');
        if (open)
            try {
                await tx.query('rollback');
                open = false;
            }
            catch (rollback) {
                destroy = rollback instanceof Error ? rollback : new Error('Snapshot rollback failed');
            }
    }
    finally {
        if (locked)
            try {
                const unlocked = (await tx.query('select pg_advisory_unlock_shared(73212,1) unlocked')).rows[0]?.unlocked;
                if (unlocked !== true)
                    throw new Error('Snapshot session fence not released');
            }
            catch (error) {
                destroy = error instanceof Error ? error : new Error('Snapshot unlock failed');
                failure ??= new AppError('UNAVAILABLE', 'Не удалось подтвердить освобождение снимка; соединение закрыто.');
            }
        if (!destroy)
            try {
                await tx.query('reset statement_timeout');
            }
            catch (error) {
                destroy = error instanceof Error ? error : new Error('Snapshot session reset failed');
                failure ??= new AppError('UNAVAILABLE', 'Не удалось завершить сеанс снимка; соединение закрыто.');
            }
        tx.release(destroy);
    } if (failure) {
        if ((failure as {
            code?: string;
        }).code === '57014')
            throw new AppError('NEEDS_ATTENTION', 'SQL-обработка снимка превысила 15 секунд на один запрос. Источник сохранён.');
        throw failure;
    } return result!; }
    async transaction<T>(action: (tx: SqlTransaction) => Promise<T>, fence: 'shared' | 'exclusive' = 'shared'): Promise<T> {
        const tx = await this.pool.connect();
        try {
            await tx.query('begin');
            await tx.query(fence === 'exclusive' ? 'select pg_advisory_xact_lock(73212,1)' : 'select pg_advisory_xact_lock_shared(73212,1)');
            const result = await action(tx);
            await tx.query('commit');
            return result;
        }
        catch (error) {
            await tx.query('rollback');
            if (error instanceof Error && ['PAYLOAD_PRUNED', 'RECOVERY_QUARANTINED'].includes(error.message))
                throw new AppError('CONFLICT', error.message === 'PAYLOAD_PRUNED' ? 'Содержимое версии уже очищено.' : 'Восстановленная установка ожидает проверки.');
            if ((error as {
                code?: string;
            }).code === '23505')
                throw new AppError('CONFLICT', 'Запись уже существует.');
            throw error;
        }
        finally {
            tx.release();
        }
    }
    async membership(id: string): Promise<Role | null> { return (await this.pool.query('select role from public.memberships where user_id=$1 and active', [id])).rows[0]?.role ?? null; }
    async worker(hash: string): Promise<{
        workerId: string;
    } | null> { const row = (await this.pool.query('select id from private.workers where token_hash=$1 and revoked_at is null', [hash])).rows[0]; return row ? { workerId: row.id } : null; }
    async get(id: string, tx: Pick<PoolClient, 'query'> = this.pool): Promise<Site | null> { const row = (await tx.query<DbSite>(siteSelect + ' where s.id=$1', [id])).rows[0]; return row ? site(row) : null; }
    async scoped(actor: Principal, id: string, action: 'site:read' | 'site:edit' | 'site:publish' | 'site:export' = 'site:read') {
        const s = await this.get(id);
        if (!s)
            throw new AppError('NOT_FOUND', 'Сайт не найден.');
        if (actor.role !== 'admin' && s.ownerId !== actor.userId && !s.assignedUserIds.includes(actor.userId))
            throw new AppError('NOT_FOUND', 'Сайт не найден.');
        authorize(actor, action, s);
        return s;
    }
    async fresh(tx: SqlTransaction, actor: Principal) {
        const row = (await tx.query('select role from public.memberships where user_id=$1 and active for share', [actor.userId])).rows[0];
        if (!row)
            throw new AppError('FORBIDDEN', 'Нет доступа.');
        return { userId: actor.userId, role: row.role } as Principal;
    }
    async insertSiteInTransaction(tx: SqlTransaction, input: SiteInput, actor: Principal, id = randomUUID(), batchId?: string): Promise<Site> {
        input = parseSiteInput(input);
        const domain = normalizeDomain(input.domain);
        if ((input.about?.length ?? 0) > 8000)
            throw new AppError('INVALID_INPUT', 'Слишком длинное описание.');
        const inserted = await tx.query('insert into public.sites(id,domain,owner_id,input) values($1,$2,$3,$4) on conflict(domain) do nothing returning id', [id, domain, actor.userId, { ...input, domain }]);
        if (!inserted.rowCount)
            throw new AppError('DUPLICATE_DOMAIN', 'Домен уже существует.');
        const job: Job = { id, siteId: id, kind: 'generate', stage: 'brief', state: 'queued', checkpointId: null, baseRevision: 0 };
        await tx.query('insert into private.jobs(id,site_id,data,batch_id) values($1,$1,$2,$3)', [id, job, batchId ?? null]);
        await tx.query("insert into private.site_operations(site_id,operation_id,kind) values($1,$1,'job')", [id]);
        return (await this.get(id, tx))!;
    }
    async create(input: SiteInput, actor: Principal): Promise<Site> { return this.transaction(async (tx) => { actor = await this.fresh(tx, actor); authorize(actor, 'site:create'); return this.insertSiteInTransaction(tx, input, actor); }); }
    async list(actor: Principal, cursor?: string, limit = 50, filters: SiteFilters = {}) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 100)
            throw new AppError('INVALID_INPUT', 'Некорректный размер страницы.');
        filters = siteFilters(filters);
        const filtered = Object.values(filters).some(Boolean), binding = filterBinding(actor, filters);
        const key = cursor === undefined ? null : !filtered && /^[0-9a-f-]{36}$/i.test(cursor) ? cursor : decodeCursor(cursor, binding);
        // Match current() and the displayed job state; stored status is only a no-job fallback.
        const rows = (await this.pool.query<DbSite>(siteSelect + ` where ($1='admin' or s.owner_id=$2 or exists(select 1 from public.assignments a where a.site_id=s.id and a.user_id=$2) or private.has_batch_assignment(s.id,$2)) and ($3::uuid is null or s.id>$3) and ($5='' or position($5 in s.domain)>0) and ($6='' or coalesce((select j.data->>'state' from private.jobs j where j.site_id=s.id order by case when j.data->>'state' in ('completed','cancelled') then 1 else 0 end,j.id desc limit 1),s.generation_status)=$6) and ($7::uuid is null or exists(select 1 from private.batch_rows b where b.batch_id=$7 and b.site_id=s.id)) order by s.id limit $4`, [actor.role, actor.userId, key, limit + 1, filters.domain ?? '', filters.status ?? '', filters.batchId || null])).rows;
        const page = sitePagePrefix(rows, site, limit);
        return { items: page.map(site), nextCursor: rows.length > page.length ? (filtered ? encodeCursor(page.at(-1)!.id, binding) : page.at(-1)!.id) : null };
    }
    async current(siteId: string) { return (await this.pool.query('select data from private.jobs where site_id=$1 order by case when data->>\'state\' in (\'completed\',\'cancelled\') then 1 else 0 end,id desc limit 1', [siteId])).rows[0]?.data as Job | undefined ?? null; }
    async acquire(actor: Principal, siteId: string): Promise<Admission> {
        return this.transaction(async (tx) => {
            await tx.query('select id from public.sites where id=$1 for update', [siteId]);
            actor = await this.fresh(tx, actor);
            const s = await this.get(siteId, tx);
            if (!s)
                throw new AppError('NOT_FOUND', 'Сайт не найден.');
            authorize(actor, 'site:edit', s);
            const old = (await tx.query('select * from private.site_operations where site_id=$1 for update', [siteId])).rows[0];
            if (old) {
                const terminal = old.kind === 'job' && (await tx.query("select 1 from private.jobs where id=$1 and data->>'state' in ('completed','cancelled','needs_attention') and (worker_id is null or expires_at<=clock_timestamp())", [old.operation_id])).rowCount;
                const expired = old.kind === 'controller' && (await tx.query('select $1::timestamptz<=clock_timestamp() expired', [old.expires_at])).rows[0].expired;
                if (!terminal && !expired)
                    throw new AppError('CONFLICT', 'Операция уже выполняется.');
            }
            const token = randomUUID();
            await tx.query("insert into private.site_operations(site_id,operation_id,kind,expires_at) values($1,$2,'controller',clock_timestamp()+interval '120 seconds') on conflict(site_id) do update set operation_id=$2,kind='controller',generation=null,expires_at=clock_timestamp()+interval '120 seconds'", [siteId, token]);
            return { siteId, token, actor };
        });
    }
    async guard(tx: SqlTransaction, a: Admission) {
        await tx.query('select id from public.sites where id=$1 for update', [a.siteId]);
        const actor = await this.fresh(tx, a.actor);
        const s = await this.get(a.siteId, tx);
        if (!s)
            throw new AppError('NOT_FOUND', 'Сайт не найден.');
        authorize(actor, 'site:edit', s);
        const row = (await tx.query("select 1 from private.site_operations where site_id=$1 and operation_id=$2 and kind='controller' and expires_at>clock_timestamp() for update", [a.siteId, a.token])).rows[0];
        if (!row)
            throw new AppError('STALE_LEASE', 'Срок операции истёк.');
    }
    async release(a: Admission) { await this.transaction(async (tx) => { await tx.query('select id from public.sites where id=$1 for update', [a.siteId]); await tx.query("delete from private.site_operations where site_id=$1 and operation_id=$2 and kind='controller'", [a.siteId, a.token]); }); }
    /** Monotone denial only; never grants admission or changes source/pointers, even while a worker owns the site. */
    async denyRevokedVisualSave(actor: Principal, siteId: string, saveId: string, observedOwnDenial = false): Promise<boolean> {
        return this.transaction(async (tx) => {
            await tx.query('select id from public.sites where id=$1 for update', [siteId]);
            const row = (await tx.query("select data from private.edit_requests where id=$1 and site_id=$2 and data#>>'{visualSave,actorId}'=$3 for update", [saveId, siteId, actor.userId])).rows[0];
            if (!row || row.data.visualSave.state !== 'pending')
                return false;
            const candidate = row.data as Candidate, site = await this.get(siteId, tx), revision = await this.revision(saveId, tx);
            if (site && installedVisualAcceptance(site, candidate, revision)) {
                await tx.query('update private.edit_requests set data=$2 where id=$1', [saveId, completeVisualAcceptance(candidate)]);
                return false;
            }
            let denied = observedOwnDenial;
            try {
                if (!site)
                    throw new AppError('NOT_FOUND', 'Нет сайта.');
                authorize(await this.fresh(tx, actor), 'site:edit', site);
            }
            catch (error) {
                if (!(error instanceof AppError && ['FORBIDDEN', 'NOT_FOUND'].includes(error.code)))
                    throw error;
                denied = true;
            }
            if (!denied)
                return false;
            await tx.query('update private.edit_requests set data=$2 where id=$1', [saveId, failVisualAcceptance(candidate, 'Доступ к сохранению отозван.')]);
            return true;
        });
    }
    /** Same acceptance intent as core; authority decision, pointer CAS and its terminal journal receipt are atomic. */
    async commitVisualSave(siteId: string, expectedRevision: number, patch: SitePatch, a: Admission, actorId: string): Promise<VisualAcceptanceReceipt> {
        if (a.siteId !== siteId || Object.keys(patch).length !== 1 || typeof patch.draftId !== 'string')
            throw new AppError('INVALID_INPUT', 'Недопустимая установка сохранения.');
        return this.transaction(async (tx) => {
            await tx.query('select id from public.sites where id=$1 for update', [siteId]);
            const candidate = (await tx.query('select data from private.edit_requests where id=$1 and site_id=$2 for update', [patch.draftId, siteId])).rows[0]?.data as Candidate | undefined;
            if (!candidate?.visualSave || candidate.visualSave.actorId !== actorId || candidate.baseRevision !== expectedRevision || candidate.job.edit?.candidateId !== candidate.id || candidate.job.baseRevision !== expectedRevision)
                throw new AppError('INVALID_INPUT', 'Намерение сохранения не совпадает.');
            const site = await this.get(siteId, tx);
            if (!site)
                throw new AppError('NOT_FOUND', 'Нет сайта.');
            const revision = await this.revision(candidate.id, tx);
            const save = async (value: Candidate) => { await tx.query('update private.edit_requests set data=$2 where id=$1', [candidate.id, value]); };
            if (candidate.visualSave.state === 'completed' || installedVisualAcceptance(site, candidate, revision)) {
                await save(completeVisualAcceptance(candidate));
                return { state: 'completed', site, journalCommitted: true };
            }
            if (candidate.visualSave.state === 'failed')
                return { state: 'failed', code: 'FORBIDDEN', message: candidate.visualSave.error ?? 'Сохранение отклонено.', journalCommitted: true };
            if (candidate.acceptance?.expectedRevision !== expectedRevision)
                throw new AppError('INVALID_INPUT', 'Намерение принятия не совпадает.');
            try {
                authorize(await this.fresh(tx, { userId: actorId, role: 'user' }), 'site:edit', site);
            }
            catch (error) {
                if (!(error instanceof AppError && error.code === 'FORBIDDEN'))
                    throw error;
                const message = 'Доступ к сохранению отозван.';
                await save(failVisualAcceptance(candidate, message));
                return { state: 'failed', code: 'FORBIDDEN', message, journalCommitted: true };
            }
            const admitted = (await tx.query("select 1 from private.site_operations where site_id=$1 and operation_id=$2 and kind='controller' and expires_at>clock_timestamp() for update", [siteId, a.token])).rowCount;
            if (!admitted)
                throw new AppError('STALE_LEASE', 'Срок операции истёк.');
            if (candidate.visualSave.state !== 'pending' || candidate.acceptance.state !== 'pending' || revision?.siteId !== siteId || revision.manifestId !== candidate.manifestId || revision.parentId !== candidate.parentRevisionId)
                throw new AppError('INVALID_INPUT', 'Проверенная версия не совпадает.');
            if (site.revision !== expectedRevision || (site.draftId ?? site.publishedId) !== candidate.baseDraftId) {
                const message = 'Черновик изменился; сохранённый вариант доступен отдельно.';
                await save(failVisualAcceptance(candidate, message));
                return { state: 'failed', code: 'CONFLICT', message, journalCommitted: true };
            }
            await tx.query('update public.sites set revision=revision+1,draft_id=$3 where id=$1 and revision=$2', [siteId, expectedRevision, candidate.id]);
            await save(completeVisualAcceptance(candidate));
            return { state: 'completed', site: (await this.get(siteId, tx))!, journalCommitted: true };
        });
    }
    async compareAndSet(siteId: string, expectedRevision: number, patch: SitePatch, a?: Admission, visualActorId?: string): Promise<Site> {
        if (!a || a.siteId !== siteId)
            throw new AppError('UNAVAILABLE', 'Требуется полномочие операции.');
        patch = parseSitePatch(patch);
        if (visualActorId) {
            const receipt = await this.commitVisualSave(siteId, expectedRevision, patch, a, visualActorId);
            if (receipt.state === 'failed')
                throw new AppError(receipt.code, receipt.message);
            return receipt.site;
        }
        return this.transaction(async (tx) => {
            await this.guard(tx, a);
            const s = (await this.get(siteId, tx))!;
            if (s.revision !== expectedRevision)
                throw new AppError('CONFLICT', 'Версия изменилась.');
            if (patch.assignedUserIds || patch.input)
                throw new AppError('INVALID_INPUT', 'Используйте административный маршрут.');
            await tx.query('update public.sites set revision=revision+1,draft_id=$3,published_id=$4,generation_status=$5,domain_status=$6 where id=$1 and revision=$2', [siteId, expectedRevision, patch.draftId === undefined ? s.draftId : patch.draftId, patch.publishedId === undefined ? s.publishedId : patch.publishedId, patch.generationStatus ?? s.generationStatus, patch.domainStatus ?? s.domainStatus]);
            return (await this.get(siteId, tx))!;
        });
    }
    async revision(id: string, tx: Pick<PoolClient, 'query'> = this.pool): Promise<Revision | null> { const r = (await tx.query('select * from public.revisions where id=$1', [id])).rows[0]; return r ? { id: r.id, siteId: r.site_id, parentId: r.parent_id, manifestId: r.manifest_id, kind: r.kind, createdAt: Number(r.created_at) } : null; }
    async putRevision(r: Revision, a: Admission) {
        await this.transaction(async (tx) => {
            await this.guard(tx, a);
            if (r.siteId !== a.siteId)
                throw new AppError('FORBIDDEN', 'Чужая версия.');
            const existing = await this.revision(r.id, tx);
            if (existing) {
                if (JSON.stringify(existing) !== JSON.stringify(r))
                    throw new AppError('CONFLICT', 'Неизменяемая версия.');
                return;
            }
            await tx.query('insert into public.revisions values($1,$2,$3,$4,$5,$6)', [r.id, r.siteId, r.parentId, r.manifestId, r.kind, r.createdAt]);
        });
    }
    async editingState(siteId: string, tx: Pick<PoolClient, 'query'> = this.pool): Promise<EditingState> { const candidates = (await tx.query("select data from private.edit_requests where site_id=$1 order by (data->>'createdAt')::bigint,id", [siteId])).rows.map(r => r.data); const messages = (await tx.query('select * from public.chat where site_id=$1 order by created_at,id', [siteId])).rows.map(r => ({ id: r.id, siteId: r.site_id, candidateId: r.candidate_id, role: r.role, text: r.text, createdAt: Number(r.created_at) })); const publications = (await tx.query('select data from private.deployments where site_id=$1 order by id', [siteId])).rows.map(r => r.data); return { version: 1, candidates, messages, publications }; }
    editingStore(a: Admission): EditingStore {
        return { transaction: async (operation) => this.transaction(async (tx) => {
                await this.guard(tx, a);
                const state = await this.editingState(a.siteId, tx), result = await operation(state);
                if (result.value) {
                    for (const c of result.value.candidates) {
                        if (c.siteId !== a.siteId)
                            throw new AppError('FORBIDDEN', 'Чужой вариант.');
                        const previous = (await tx.query('select data from private.edit_requests where id=$1', [c.id])).rows[0]?.data;
                        const terminal = previous?.visualSave?.state;
                        if ((terminal === 'failed' || terminal === 'completed') && (c.visualSave?.state !== terminal || (terminal === 'completed' && (c.status !== 'accepted' || c.acceptance?.state !== 'completed')) || (terminal === 'failed' && c.acceptance?.state === 'pending')))
                            throw new AppError('CONFLICT', 'Завершённое сохранение нельзя изменить.');
                        // Write-ahead candidate and queued job are atomic; enqueue below transfers admission.
                        await tx.query('insert into private.jobs(id,site_id,data) values($1,$2,$3) on conflict(id) do nothing', [c.jobId, a.siteId, c.job]);
                        const inserted = !(await tx.query('select 1 from private.edit_requests where id=$1', [c.id])).rowCount;
                        await tx.query('insert into private.edit_requests values($1,$2,$3,$4) on conflict(id) do update set data=$4', [c.id, c.siteId, c.jobId, c]);
                        if (inserted)
                            await tx.query("update private.site_operations set operation_id=$2,kind='job',expires_at=null where site_id=$1", [a.siteId, c.jobId]);
                    }
                    for (const m of result.value.messages)
                        await tx.query('insert into public.chat values($1,$2,$3,$4,$5,$6) on conflict(id) do nothing', [m.id, a.siteId, m.candidateId, m.role, m.text, m.createdAt]);
                    for (const p of result.value.publications)
                        await tx.query('insert into private.deployments values($1,$2,$3) on conflict(id) do update set data=$3', [p.id, a.siteId, p]);
                }
                return result.result;
            }) };
    }
    queue(a: Admission) {
        const unavailable = async () => { throw new AppError('UNAVAILABLE', 'Исполнение очереди ещё не подключено.'); };
        return { claim: unavailable, heartbeat: unavailable, checkpoint: unavailable, finish: unavailable, get: async (id: string) => (await this.pool.query('select data from private.jobs where id=$1 and site_id=$2', [id, a.siteId])).rows[0]?.data ?? null, current: async () => this.current(a.siteId),
            enqueue: async (job: Job) => {
                await this.transaction(async (tx) => {
                    await tx.query('select id from public.sites where id=$1 for update', [a.siteId]);
                    const active = (await tx.query("select 1 from private.site_operations where site_id=$1 and operation_id=$2 and kind='job'", [a.siteId, job.id])).rowCount;
                    if (active) {
                        authorize(await this.fresh(tx, a.actor), 'site:edit', (await this.get(a.siteId, tx))!);
                        return;
                    }
                    await this.guard(tx, a);
                    if (job.siteId !== a.siteId)
                        throw new AppError('FORBIDDEN', 'Чужое задание.');
                    await tx.query('insert into private.jobs(id,site_id,data) values($1,$2,$3) on conflict(id) do nothing', [job.id, job.siteId, job]);
                    await tx.query("update private.site_operations set operation_id=$2,kind='job',expires_at=null where site_id=$1", [a.siteId, job.id]);
                });
            },
            cancel: async (id: string) => {
                await this.transaction(async (tx) => {
                    await this.guard(tx, a);
                    const r = (await tx.query('select data from private.jobs where id=$1 and site_id=$2 for update', [id, a.siteId])).rows[0];
                    if (!r)
                        throw new AppError('NOT_FOUND', 'Задание не найдено.');
                    if (r.data.state === 'running')
                        throw new AppError('CONFLICT', 'Задание выполняется.');
                    await tx.query("update private.jobs set data=jsonb_set(data,'{state}','\"cancelled\"'),worker_id=null,expires_at=null where id=$1", [id]);
                });
            } };
    }
}
