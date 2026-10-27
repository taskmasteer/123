import { AppError } from '../../contracts/src/model.js';
import type { Checkpoint, Job, Lease, Queue, Site, SitePatch, Principal } from '../../contracts/src/model.js';
import { authorize } from '../../core/src/permissions.js';
import { parseSitePatch } from '../../contracts/src/inputs.js';
import { randomUUID } from 'node:crypto';
import { validJob } from './local-queue.js';
import { SupabaseRepository, type SqlTransaction, type LeaseAuthority, type WorkerSiteMutation, type Admission } from './supabase-repository.js';
export class PostgresQueue implements Queue, LeaseAuthority, WorkerSiteMutation {
    constructor(readonly repository: SupabaseRepository) {
    }
    /** Called only after locking the job and its site; session roles are not authority. */
    private async authorizeControl(tx: SqlTransaction, actor: Principal, job: Job): Promise<void> {
        const current = await this.repository.fresh(tx, actor);
        const site = (await this.repository.get(job.siteId, tx))!;
        authorize(current, job.kind === 'edit' ? 'site:edit' : 'site:read', site);
        if (job.kind === 'generate' && current.role !== 'admin' && site.ownerId !== current.userId)
            throw new AppError('FORBIDDEN', 'Можно управлять только собственной генерацией.');
    }
    async reserveControllerPublication(tx: SqlTransaction, admission: Admission, requestKey: string, binding: {
        revisionId: string;
        manifestId: string;
        expectedRevision: number;
    }): Promise<{
        id: string;
    }> {
        await tx.query('select id from public.sites where id=$1 for update', [admission.siteId]);
        const site = (await this.repository.get(admission.siteId, tx))!;
        authorize(await this.repository.fresh(tx, admission.actor), 'site:publish', site);
        const previous = (await tx.query('select *,binding=$2::jsonb identical from private.publication_reservations where request_key=$1', [requestKey, binding])).rows[0];
        if (previous) {
            if (previous.site_id !== site.id || !previous.identical || previous.origin_controller_id !== admission.token)
                throw new AppError('CONFLICT', 'Запрос публикации уже использован.');
            return { id: previous.id };
        }
        await this.repository.guard(tx, admission);
        const revision = await this.repository.revision(binding.revisionId, tx);
        if (site.revision !== binding.expectedRevision || site.draftId !== binding.revisionId || revision?.siteId !== site.id || revision.manifestId !== binding.manifestId)
            throw new AppError('CONFLICT', 'Принятый черновик изменился.');
        const id = randomUUID();
        await tx.query('insert into private.publication_reservations(id,site_id,request_key,binding,origin_controller_id) values($1,$2,$3,$4,$5)', [id, site.id, requestKey, binding, admission.token]);
        await tx.query("update private.site_operations set operation_id=$2,kind='publication',generation=null,expires_at=null where site_id=$1", [site.id, id]);
        return { id };
    }
    async pauseAtBoundary(lease: Lease): Promise<boolean> {
        return this.repository.transaction(async (tx) => {
            await this.assertCurrent(tx, lease.workerId, lease);
            const paused = (await tx.query('select w.paused or j.pause_requested paused from private.jobs j join private.workers w on w.id=j.worker_id where j.id=$1', [lease.jobId])).rows[0].paused;
            if (paused)
                await tx.query("update private.jobs set worker_id=null,expires_at=null,data=jsonb_set(data,'{state}','\"paused\"') where id=$1", [lease.jobId]);
            return paused;
        });
    }
    /** Server-only Task9 seam. The caller must verify provider evidence before this
     * SQL-only transaction and install the matching pointer within it. Never expose as HTTP. */
    async settlePublicationInTransaction(tx: SqlTransaction, id: string, resolution: 'settled' | 'cancelled'): Promise<void> {
        const initial = (await tx.query('select site_id,origin_job_id from private.publication_reservations where id=$1', [id])).rows[0];
        if (!initial)
            throw new AppError('NOT_FOUND', 'Публикация не найдена.');
        if (initial.origin_job_id)
            await this.lockJob(tx, initial.origin_job_id);
        else {
            await tx.query('select id from public.sites where id=$1 for update', [initial.site_id]);
            await tx.query('select site_id from private.site_operations where site_id=$1 for update', [initial.site_id]);
        }
        const reservation = (await tx.query('select * from private.publication_reservations where id=$1 for update', [id])).rows[0];
        if (reservation.resolution) {
            if (reservation.resolution !== resolution)
                throw new AppError('CONFLICT', 'Публикация уже разрешена иначе.');
            return;
        }
        const operation = (await tx.query('select * from private.site_operations where site_id=$1', [initial.site_id])).rows[0];
        if (operation?.kind !== 'publication' || operation.operation_id !== id)
            throw new AppError('CONFLICT', 'Владение публикацией изменилось.');
        if (resolution === 'settled') {
            const site = (await this.repository.get(initial.site_id, tx))!, revision = await this.repository.revision(reservation.binding.revisionId, tx);
            if (site.publishedId !== reservation.binding.revisionId || site.revision !== reservation.binding.expectedRevision + 1 || revision?.manifestId !== reservation.binding.manifestId || revision?.siteId !== site.id)
                throw new AppError('CONFLICT', 'Указатель публикации не подтверждён.');
        }
        await tx.query('update private.publication_reservations set resolution=$2,resolved_at=clock_timestamp() where id=$1', [id, resolution]);
        if (initial.origin_job_id && resolution === 'settled')
            await tx.query("update private.jobs set worker_id=null,expires_at=null,data=jsonb_set(data,'{state}','\"completed\"') where id=$1 and data->>'state'<>'cancelled'", [initial.origin_job_id]);
        await tx.query("delete from private.site_operations where site_id=$1 and operation_id=$2 and kind='publication'", [initial.site_id, id]);
    }
    async retry(jobId: string, recovery?: Job['providerRecovery'], actor?: Principal): Promise<void> {
        await this.repository.transaction(async (tx) => {
            const row = await this.lockJob(tx, jobId), job = row.data as Job;
            if (actor)
                await this.authorizeControl(tx, actor, job);
            if (!['paused', 'waiting_provider', 'needs_attention'].includes(job.state) || job.state === 'needs_attention' && !recovery)
                throw new AppError('CONFLICT', 'Повтор требует исправления причины и явного запроса.');
            if (recovery && (job.kind !== 'generate' || job.state !== 'needs_attention' || job.checkpointId !== recovery.checkpointId))
                throw new AppError('CONFLICT', 'Повтор не соответствует сохранённой ошибке.');
            const active = (await tx.query('select * from private.site_operations where site_id=$1', [job.siteId])).rows[0];
            if (active && (active.kind !== 'job' || active.operation_id !== jobId))
                throw new AppError('CONFLICT', 'Сайт занят другой операцией.');
            await tx.query("update private.jobs set data=$2,worker_id=null,expires_at=null,pause_requested=false where id=$1", [jobId, { ...job, state: 'queued', ...(recovery ? { providerRecovery: recovery } : {}) }]);
            await tx.query("insert into private.site_operations(site_id,operation_id,kind) values($1,$2,'job') on conflict(site_id) do update set generation=null,expires_at=null", [job.siteId, job.id]);
        });
    }
    /** Compose with caller's site/admission transaction; never opens a nested transaction. */
    async enqueueInTransaction(tx: SqlTransaction, job: Job, controllerToken?: string): Promise<void> {
        if (!validJob(job) || job.state !== 'queued' || job.checkpointId !== null)
            throw new AppError('INVALID_INPUT', 'Некорректное новое задание.');
        await tx.query('select id from public.sites where id=$1 for update', [job.siteId]);
        const admission = (await tx.query('select *,expires_at>clock_timestamp() fresh from private.site_operations where site_id=$1 for update', [job.siteId])).rows[0];
        if (admission && !(admission.kind === 'controller' && admission.operation_id === controllerToken && admission.fresh))
            throw new AppError('CONFLICT', 'Сайт занят.');
        await tx.query('insert into private.jobs(id,site_id,data) values($1,$2,$3)', [job.id, job.siteId, job]);
        await tx.query("insert into private.site_operations(site_id,operation_id,kind) values($1,$2,'job') on conflict(site_id) do update set operation_id=$2,kind='job',generation=null,expires_at=null", [job.siteId, job.id]);
    }
    async pauseWorker(workerId: string, paused: boolean, actor?: Principal): Promise<void> {
        await this.repository.transaction(async (tx) => {
            if (actor)
                authorize(await this.repository.fresh(tx, actor), 'admin:manage');
            await tx.query('update private.workers set paused=$2 where id=$1 and revoked_at is null', [workerId, paused]);
        });
        if (!paused) {
            const jobs = (await this.repository.pool.query("select id from private.jobs where last_worker_id=$1 and data->>'state'='paused' order by site_id,id", [workerId])).rows;
            for (const job of jobs) {
                try {
                    await this.retry(job.id, undefined, actor);
                }
                catch (error) {
                    if (!(error instanceof AppError && error.code === 'CONFLICT'))
                        throw error;
                }
            }
        }
    }
    async shouldPause(lease: Lease): Promise<boolean> {
        return this.repository.transaction(async (tx) => {
            await this.assertCurrent(tx, lease.workerId, lease);
            const row = (await tx.query('select w.paused or j.pause_requested paused from private.jobs j join private.workers w on w.id=j.worker_id where j.id=$1', [lease.jobId])).rows[0];
            return row.paused;
        });
    }
    private async lockJob(tx: SqlTransaction, jobId: string) {
        const initial = (await tx.query('select site_id,worker_id from private.jobs where id=$1', [jobId])).rows[0];
        if (!initial)
            throw new AppError('NOT_FOUND', 'Задание не найдено.');
        await tx.query('select id from public.sites where id=$1 for update', [initial.site_id]);
        // Re-read ownership only after the site lock: a reclaim may have won before it.
        const owner = (await tx.query('select coalesce(worker_id,last_worker_id) worker_id from private.jobs where id=$1', [jobId])).rows[0].worker_id;
        if (owner)
            await tx.query('select id from private.workers where id=$1 for update', [owner]);
        const job = (await tx.query('select * from private.jobs where id=$1 for update', [jobId])).rows[0];
        await tx.query('select site_id from private.site_operations where site_id=$1 for update', [initial.site_id]);
        return job;
    }
    async cancel(jobId: string, actor?: Principal): Promise<void> {
        await this.repository.transaction(async (tx) => {
            const job = await this.lockJob(tx, jobId);
            if (actor)
                await this.authorizeControl(tx, actor, job.data as Job);
            if (job.data.state === 'completed')
                throw new AppError('CONFLICT', 'Задание уже завершено.');
            await tx.query("update private.jobs set generation=generation+1,worker_id=null,expires_at=null,data=jsonb_set(data,'{state}','\"cancelled\"') where id=$1", [jobId]);
            await tx.query("delete from private.site_operations where site_id=$1 and operation_id=$2 and kind='job'", [job.site_id, jobId]);
        });
    }
    async revokeWorker(workerId: string): Promise<void> {
        // No job/site writes follow this device lock. Every guarded writer and claim
        // rechecks revocation after taking the same lock, including calls already authenticated.
        await this.repository.pool.query('update private.workers set revoked_at=clock_timestamp(),paused=true where id=$1', [workerId]);
    }
    async reservePublication(lease: Lease, binding: {
        requestKey: string;
        manifestId: string;
        revisionId: string;
        expectedRevision: number;
        checkpointId: string;
    }): Promise<{
        id: string;
    }> {
        return this.repository.transaction(async (tx) => {
            const bound = await this.authority(tx, lease.workerId, lease, true);
            const existing = (await tx.query('select *,binding=$2::jsonb identical from private.publication_reservations where request_key=$1', [binding.requestKey, binding])).rows[0];
            if (existing) {
                if (!existing.identical || existing.origin_job_id !== lease.jobId)
                    throw new AppError('CONFLICT', 'Идентичность публикации изменилась.');
                return { id: existing.id };
            }
            const job = (await tx.query('select checkpoint_id,data from private.jobs where id=$1', [lease.jobId])).rows[0];
            const cp = (await tx.query('select metadata from private.checkpoints where id=$1 and job_id=$2', [binding.checkpointId, lease.jobId])).rows[0];
            if (job.checkpoint_id !== binding.checkpointId || job.data.baseRevision !== binding.expectedRevision || job.data.kind !== 'generate' || !cp || cp.metadata.checkpoint.stage !== 'publication' || cp.metadata.checkpoint.manifestId !== binding.manifestId || binding.requestKey !== lease.jobId + ':' + binding.manifestId)
                throw new AppError('CONFLICT', 'Публикация не связана с сохранённым этапом.');
            const id = randomUUID();
            await tx.query('insert into private.publication_reservations(id,site_id,request_key,binding,origin_job_id) values($1,$2,$3,$4,$5)', [id, bound.siteId, binding.requestKey, binding, lease.jobId]);
            await tx.query("update private.site_operations set operation_id=$2,kind='publication',generation=null,expires_at=null where site_id=$1", [bound.siteId, id]);
            return { id };
        });
    }
    async claim(workerId: string): Promise<{
        job: Job;
        lease: Lease;
    } | null> {
        try {
            return (await this.repository.pool.query('select private.claim_job($1) result', [workerId])).rows[0].result;
        }
        catch (error) {
            if (error instanceof Error && error.message === 'STALE_LEASE')
                throw new AppError('STALE_LEASE', 'Устройство отозвано.');
            throw error;
        }
    }
    async assertCurrent(tx: SqlTransaction, workerId: string, lease: Lease) {
        return this.authority(tx, workerId, lease, false);
    }
    /** Read/replay only the publication already bound to this live lease. */
    async assertPublicationCurrent(tx: SqlTransaction, workerId: string, lease: Lease) {
        return this.authority(tx, workerId, lease, true);
    }
    private async authority(tx: SqlTransaction, workerId: string, lease: Lease, allowHandoff: boolean) {
        if (workerId !== lease.workerId)
            throw new AppError('STALE_LEASE', 'Чужая аренда.');
        try {
            const row = (await tx.query('select private.require_lease($1,$2,$3,$4) site_id', [workerId, lease.jobId, lease.generation, allowHandoff])).rows[0];
            return { jobId: lease.jobId, siteId: row.site_id as string, generation: lease.generation };
        }
        catch (error) {
            if (error instanceof Error && error.message === 'STALE_LEASE')
                throw new AppError('STALE_LEASE', 'Исполнитель больше не владеет заданием.');
            throw error;
        }
    }
    async enqueue(job: Job): Promise<void> {
        await this.repository.transaction(tx => this.enqueueInTransaction(tx, job));
    }
    async heartbeat(lease: Lease): Promise<Lease> {
        return this.repository.transaction(async (tx) => {
            await this.authority(tx, lease.workerId, lease, true);
            const row = (await tx.query("update private.jobs set expires_at=clock_timestamp()+interval '120 seconds' where id=$1 returning floor(extract(epoch from expires_at)*1000)::text expires", [lease.jobId])).rows[0];
            await tx.query('update private.workers set last_heartbeat=clock_timestamp() where id=$1', [lease.workerId]);
            return { ...lease, expiresAt: Number(row.expires) };
        });
    }
    async checkpoint(lease: Lease, checkpoint: Checkpoint, expectedCheckpointId?: string | null): Promise<void> {
        await this.repository.transaction(async (tx) => {
            await this.assertCurrent(tx, lease.workerId, lease);
            const job = (await tx.query('select checkpoint_id from private.jobs where id=$1', [lease.jobId])).rows[0];
            const saved = (await tx.query("select *,metadata->'checkpoint'=$3::jsonb identical from private.checkpoints where id=$1 and job_id=$2", [checkpoint.id, lease.jobId, checkpoint])).rows[0];
            if (!saved || !saved.identical)
                throw new AppError('CONFLICT', 'Контрольная точка не совпадает с сохранённой.');
            const predecessor = expectedCheckpointId === undefined ? saved.expected_checkpoint_id : expectedCheckpointId;
            if (saved.expected_checkpoint_id !== predecessor)
                throw new AppError('CONFLICT', 'Предыдущая контрольная точка не совпадает.');
            if (job.checkpoint_id === checkpoint.id)
                return;
            if (job.checkpoint_id !== predecessor || saved.worker_id !== lease.workerId || Number(saved.generation) !== lease.generation)
                throw new AppError('CONFLICT', 'Контрольная точка устарела.');
            await tx.query("update private.jobs set checkpoint_id=$2,data=data||jsonb_build_object('checkpointId',($2::uuid)::text,'stage',$3::text) where id=$1", [lease.jobId, checkpoint.id, checkpoint.stage]);
        });
    }
    async finish(lease: Lease, state: Job['state']): Promise<void> {
        if (!['paused', 'waiting_provider', 'needs_attention', 'completed', 'cancelled'].includes(state))
            throw new AppError('INVALID_INPUT', 'Некорректное конечное состояние.');
        await this.repository.transaction(async (tx) => {
            const current = await this.lockJob(tx, lease.jobId);
            if (state === 'completed' && current.data.state === 'completed' && current.last_worker_id === lease.workerId && Number(current.generation) === lease.generation) {
                const settled = (await tx.query("select 1 from private.publication_reservations r join private.workers w on w.id=$2 where r.origin_job_id=$1 and r.resolution='settled' and w.revoked_at is null", [lease.jobId, lease.workerId])).rowCount;
                if (settled)
                    return;
            }
            const bound = await this.authority(tx, lease.workerId, lease, true);
            if (state === 'completed' && (!current.checkpoint_id || current.data.stage !== 'completed'))
                throw new AppError('CONFLICT', 'Завершённый этап ещё не сохранён.');
            if (state === 'completed' && (await tx.query('select 1 from private.publication_reservations where origin_job_id=$1 and resolution is null', [lease.jobId])).rowCount)
                throw new AppError('CONFLICT', 'Публикация ещё не разрешена.');
            await tx.query("update private.jobs set worker_id=null,expires_at=null,data=jsonb_set(data,'{state}',to_jsonb($2::text)) where id=$1", [lease.jobId, state]);
            if (['completed', 'cancelled', 'needs_attention'].includes(state))
                await tx.query("delete from private.site_operations where site_id=$1 and operation_id=$2 and kind='job'", [bound.siteId, lease.jobId]);
        });
    }
    async compareAndSet(workerId: string, lease: Lease, expectedRevision: number, input: SitePatch): Promise<Site> {
        const patch = parseSitePatch(input);
        if (patch.assignedUserIds || patch.input)
            throw new AppError('FORBIDDEN', 'Исполнитель не меняет доступ или исходное задание.');
        return this.repository.transaction(async (tx) => {
            const bound = await this.assertCurrent(tx, workerId, lease), site = (await this.repository.get(bound.siteId, tx))!;
            if (site.revision !== expectedRevision)
                throw new AppError('CONFLICT', 'Версия сайта изменилась.');
            await tx.query('update public.sites set revision=revision+1,draft_id=$2,published_id=$3,generation_status=$4,domain_status=$5 where id=$1', [site.id, patch.draftId === undefined ? site.draftId : patch.draftId, patch.publishedId === undefined ? site.publishedId : patch.publishedId, patch.generationStatus ?? site.generationStatus, patch.domainStatus ?? site.domainStatus]);
            return (await this.repository.get(site.id, tx))!;
        });
    }
}
