import { authorize } from '../../core/src/permissions.js';
import { SupabaseRepository, type SqlTransaction } from './supabase-repository.js';
import { randomUUID } from 'node:crypto';
import { AppError, type Principal, type Manifest } from '../../contracts/src/model.js';
import { healthIntervalMs, healthObservation, codeStatus, type HealthClaim, type HealthCode, type HealthObservation } from '../../contracts/src/monitoring.js';
const publicationJoin = `join lateral(select * from private.provider_publications p where p.site_id=s.id and p.revision_id=s.published_id and p.settlement='settled' and p.verified_at is not null and p.evidence is not null order by p.settled_seq desc nulls last,p.verified_at desc,p.id desc limit 1) p on true`;
export class PostgresHealth {
    constructor(readonly repository: SupabaseRepository, readonly now?:()=>number) { }
    private async time(tx:SqlTransaction):Promise<number>{return this.now?this.now():Number((await tx.query("select floor(extract(epoch from clock_timestamp())*1000)::text ms")).rows[0].ms);}
    private async expectation(tx: SqlTransaction, siteId: string): Promise<Omit<HealthClaim, 'token' | 'generation' | 'expiresAt'> | null> {
        const r = (await tx.query(`select s.domain,p.* ,a.manifest from public.sites s ${publicationJoin} join public.revisions v on v.id=s.published_id and v.site_id=s.id and v.manifest_id=p.manifest_id join private.artifacts a on a.id=v.manifest_id and a.site_id=s.id and a.verified where s.id=$1`, [siteId])).rows[0];
        if (!r||!r.data||typeof r.data!=='object'||!r.evidence||typeof r.evidence!=='object')
            return null;
        const m = r.manifest as Manifest;if(!m||!Array.isArray(m.files))return null;const file = m.files.find(f => f.path === 'index.html');
        if (!file || typeof file.mediaType!=='string'||file.mediaType.length>100||typeof r.data.policyVersion!=='string'||!/^[a-f0-9]{64}$/.test(String(r.data.policyHash))||m.id!==r.manifest_id || m.siteId!==siteId || !Number.isSafeInteger(file.size)||file.size<0||file.size>4000000||!/^[a-f0-9]{64}$/.test(file.sha256)||r.evidence.policyHash!==r.data.policyHash|| r.data.domain !== r.domain || r.evidence.hostname !== r.domain || r.evidence.manifestHash !== r.manifest_hash || r.evidence.indexSha256 !== file.sha256)
            return null;
        return { siteId, revisionId: r.revision_id, outcomeId: r.id, hostname: r.domain, manifestId: r.manifest_id, manifestHash: r.manifest_hash, policyVersion: typeof r.data.policyVersion === 'string' ? r.data.policyVersion : 'unknown', policyHash: /^[a-f0-9]{64}$/.test(String(r.data.policyHash)) ? r.data.policyHash : '0'.repeat(64), file: { sha256: file.sha256, size: file.size, mediaType: file.mediaType } };
    }
    async claim(workerId: string): Promise<{
        claim: HealthClaim | null;
        nextWakeAt: number;serverNow:number;
    }> {
        const token=randomUUID();
        return this.repository.transaction(async (tx) => {
            const selectedAt = await this.time(tx);
            if ((await tx.query("select 1 from private.recovery_state where key='quarantine'")).rowCount)
                throw new AppError('CONFLICT', 'Восстановленная установка ожидает проверки.');
            const selected = (await tx.query(`select s.id,s.published_id,p.id outcome_id from public.sites s ${publicationJoin} left join private.health_observations h on h.site_id=s.id where (h.token is null or h.expires_at<=$1) and (h.next_due_at is null or h.next_due_at<=$1 or h.expectation->>'outcomeId' is distinct from p.id::text) order by coalesce(h.next_due_at,0),s.id for update of s skip locked limit 1`, [selectedAt])).rows[0];
            const worker = (await tx.query('select id from private.workers where id=$1 and revoked_at is null for update', [workerId])).rows[0];
            if (!worker)
                throw new AppError('STALE_LEASE', 'Устройство отозвано.');
            const now=await this.time(tx);
            const wake = async () => { const row = (await tx.query(`select min(case when h.token is not null and h.expires_at>$1 then h.expires_at else greatest(h.next_due_at,$1+1000) end) n from public.sites s ${publicationJoin} join private.health_observations h on h.site_id=s.id`, [now])).rows[0]; return Math.min(now + healthIntervalMs, Number(row?.n ?? now + healthIntervalMs)); };
            if (!selected || (await tx.query('select 1 from private.health_observations where worker_id=$1 and token is not null and expires_at>$2 limit 2', [workerId, now])).rowCount! >= 2)
                return {serverNow:now, claim: null, nextWakeAt: await wake() };
            const expected = await this.expectation(tx, selected.id);
            if (!expected) {
                await tx.query('insert into private.health_observations(site_id,next_due_at,expectation) values($1,$2,$3) on conflict(site_id) do update set next_due_at=excluded.next_due_at,expectation=excluded.expectation', [selected.id, now + healthIntervalMs, { outcomeId: selected.outcome_id }]);
                const value: HealthObservation = { siteId: selected.id, revisionId: selected.published_id, outcomeId: selected.outcome_id, checkedAt: now, status: 'unreachable', code: 'policy_unavailable', provenance: 'managed' };
                await tx.query('insert into public.health(site_id,status,checked_at,data) values($1,$2,$3,$4) on conflict(site_id) do update set status=excluded.status,checked_at=excluded.checked_at,data=excluded.data', [selected.id, value.status, now, value]);
                return {serverNow:now, claim: null, nextWakeAt: now + 1000 };
            }
            const expiresAt = now + 120000;
            const row = (await tx.query('insert into private.health_observations(site_id,next_due_at,generation,token,worker_id,expires_at,expectation) values($1,0,1,$2,$3,$4,$5) on conflict(site_id) do update set generation=private.health_observations.generation+1,token=excluded.token,worker_id=excluded.worker_id,expires_at=excluded.expires_at,expectation=excluded.expectation returning generation', [selected.id, token, workerId, expiresAt, expected])).rows[0];
            return {serverNow:now, claim: { ...expected, token, generation: Number(row.generation), expiresAt }, nextWakeAt: expiresAt };
        });
    }
    async complete(workerId: string, input: {
        siteId: string;
        token: string;
        generation: number;
        code: HealthCode;
    }): Promise<{
        accepted: boolean;
    }> {
        return this.repository.transaction(async (tx) => {
            await tx.query('select id from public.sites where id=$1 for update', [input.siteId]);
            const worker = (await tx.query('select id from private.workers where id=$1 and revoked_at is null for update', [workerId])).rows[0];
            const r = (await tx.query('select * from private.health_observations where site_id=$1 for update', [input.siteId])).rows[0];const now = await this.time(tx);
            if (!worker || !r || r.token !== input.token || Number(r.generation) !== input.generation || r.worker_id !== workerId || Number(r.expires_at) <= now)
                return { accepted: false };
            const current = await this.expectation(tx, input.siteId);
            if (!current || !(await tx.query('select expectation=$2::jsonb same from private.health_observations where site_id=$1',[input.siteId,current])).rows[0].same) {
                await tx.query('update private.health_observations set token=null,worker_id=null,expires_at=null,next_due_at=0 where site_id=$1', [input.siteId]);
                return { accepted: false };
            }
            const value: HealthObservation = { siteId: input.siteId, revisionId: current.revisionId, outcomeId: current.outcomeId, checkedAt: now, status: codeStatus(input.code), code: input.code, provenance: 'managed' };
            await tx.query('insert into public.health(site_id,status,checked_at,data) values($1,$2,$3,$4) on conflict(site_id) do update set status=excluded.status,checked_at=excluded.checked_at,data=excluded.data', [input.siteId, value.status, now, value]);
            await tx.query('update private.health_observations set token=null,worker_id=null,expires_at=null,next_due_at=$2 where site_id=$1', [input.siteId, now + healthIntervalMs]);
            return { accepted: true };
        });
    }
    async read(siteId: string, actor?: Principal): Promise<HealthObservation> { const read = async (query: Pick<SqlTransaction, 'query'>) => { const r = (await query.query(`select h.data,(select p.id from public.sites s ${publicationJoin} where s.id=$1) current_outcome from public.health h where h.site_id=$1`, [siteId])).rows[0]; const value = healthObservation(r?.data ?? { siteId, revisionId: null, outcomeId: null, checkedAt: null, status: null, code: 'unverified', provenance: 'managed' }); if (value.siteId !== siteId.toLowerCase())
        throw new AppError('CONFLICT', 'Наблюдение другого сайта.'); if (value.outcomeId !== r?.current_outcome) {
        value.status = null;
        value.code = 'unverified';
    } return value; }; if (!actor)
        return read(this.repository.pool); return this.repository.transaction(async (tx) => { const current = await this.repository.fresh(tx, actor), site = await this.repository.get(siteId, tx); if (!site)
        throw new AppError('NOT_FOUND', 'Сайт не найден.'); authorize(current, 'site:read', site); return read(tx); }); }
}
export async function postgresUsage(repository: SupabaseRepository, actor: Principal, siteId?: string) {
    return repository.transaction(async (tx) => {
        actor = await repository.fresh(tx, actor);
        if (siteId) {
            const site = await repository.get(siteId, tx);
            if (!site)
                throw new AppError('NOT_FOUND', 'Сайт не найден.');
            authorize(actor, 'site:read', site);
        }
        else if (actor.role !== 'admin')
            throw new AppError('FORBIDDEN', 'Только администратор.');
        const r = (await tx.query(`select count(*) jobs,count(u.job_id) projected,count(a.job_id) measured,coalesce(sum((u.data->>'inputTokens')::bigint),0) inputs,coalesce(sum((u.data->>'outputTokens')::bigint),0) outputs,coalesce(sum((u.data->>'uncertainRequests')::bigint),0) uncertain,coalesce(bool_or((u.data->>'requestPending')::boolean),false) pending,coalesce(bool_or((u.data->>'imagePending')::boolean),false) image_pending,coalesce(bool_or(u.data->>'coverage'='known-subtotal'),false) known,coalesce(sum((a.data->>'durationMs')::bigint),0) duration,array_remove(array_agg(distinct u.data->>'provenance'),null) provenance from private.jobs j left join private.job_usage u on u.job_id=j.id left join private.job_activity a on a.job_id=j.id where ($1::uuid is null or j.site_id=$1)`, [siteId ?? null])).rows[0];
        const storage = (await tx.query(`with physical as(select case when f->>'key' like 'database:%' then 'postgres:' else 'bucket:' end|| (f->>'key') identity,min((f->>'size')::bigint) size,count(distinct jsonb_build_array(f->'size',f->'sha256',f->'mediaType')) versions from private.payload_inventory p cross join lateral jsonb_array_elements(p.data->'objects') f where p.state='available' and ($1::uuid is null or p.site_id=$1) group by 1) select coalesce(sum(size),0) bytes,coalesce(bool_or(versions<>1),false) conflict from physical`, [siteId ?? null])).rows[0];
        if (storage.conflict)
            throw new AppError('CONFLICT', 'Опись одного объекта противоречива.');
        const n = (v: unknown) => { const x = Number(v); if (!Number.isSafeInteger(x) || x < 0)
            throw new AppError('INVALID_INPUT', 'Переполнение сводки.'); return x; };
        return { jobs: n(r.jobs), measuredJobs: n(r.measured), missingJobs: n(r.jobs) - n(r.projected), inputTokens: n(r.inputs), outputTokens: n(r.outputs), uncertainRequests: n(r.uncertain), requestPending: r.pending, tokenCoverage: r.known ? 'known-subtotal' : 'unknown', provenance: r.provenance, imageTokens: null, imagePending: r.image_pending ? true : null, durationMs: n(r.measured) ? n(r.duration) : null, durationCoverage: n(r.measured) ? 'partial' : 'unknown', bytesStored: null, knownBytesStored: n(storage.bytes), storageCoverage: 'partial', estimatedCostUsd: null };
    });
}
