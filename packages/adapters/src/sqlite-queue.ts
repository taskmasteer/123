import { AppError } from '../../contracts/src/model.js';
import type { Clock, Job, Lease } from '../../contracts/src/model.js';
import { nonemptyString } from '../../contracts/src/inputs.js';
import { openLocalDatabase, insertLocalJob, type LocalDatabase } from './local-database.js';
import { validJob, type LocalQueue } from './local-queue.js';
import { commitLocalProjection } from './retention-schema.js';
import {nextActivity} from '../../core/src/activity.js';
export async function createSqliteQueue(directory: string, clock: Clock, database?: LocalDatabase): Promise<LocalQueue> {
    const db = database ?? await openLocalDatabase(directory);
    let closed = false;
    type Stored = {
        id: string;
        data: string;
        lease: string | null;
        generation: number;
        pause: number;
        batch_id: string | null;
    };
    const entry = (id: string) => db.sql.prepare('select * from jobs where id=?').get(id) as unknown as Stored | undefined;
    const job = (row: Stored) => JSON.parse(row.data) as Job;
    const run = <T>(action: () => T): Promise<T> => {
        if (closed)
            return Promise.reject(new AppError('CONFLICT', 'Queue is closed.'));
        try {
            return Promise.resolve(db.transaction(action));
        }
        catch (e) {
            return Promise.reject(e);
        }
    };
    const now = () => {
        const t = clock.now();
        if (!Number.isSafeInteger(t))
            throw new AppError('INVALID_INPUT', 'Invalid clock.');
        return t;
    };
    const owned = (lease: Lease) => {
        const r = entry(lease.jobId), l = r?.lease ? JSON.parse(r.lease) as Lease : null;
        if (!r || !l || job(r).state !== 'running' || l.workerId !== lease.workerId || l.generation !== lease.generation || l.expiresAt <= now())
            throw new AppError('STALE_LEASE', 'The worker no longer owns this job.');
        return r;
    };
    const save = (r: Stored, j: Job, lease: string | null = r.lease) => {
        db.sql.prepare('update jobs set data=?,state=?,lease=?,generation=?,pause=? where id=?').run(JSON.stringify(j), j.state, lease, r.generation, r.pause, r.id);
        if (['completed', 'cancelled', 'needs_attention'].includes(j.state))
            db.sql.prepare('delete from operations where site_id=? and operation_id=?').run(j.siteId, j.id);
    };
    const batchActive = (r: Stored) => !r.batch_id || db.sql.prepare('select state from batches where id=?').get(r.batch_id)?.state === 'active';
    return {
        recordActivity(lease,segment){return run(()=>{owned(lease);if(db.sql.prepare("select 1 from recovery_state where key='quarantine'").get())throw new AppError('CONFLICT','Установка ожидает проверки.');const old=db.sql.prepare('select data from job_activity where job_id=?').get(lease.jobId);const next=nextActivity(old?JSON.parse(String(old.data)):null,lease.jobId,lease.generation,segment);db.sql.prepare('insert into job_activity values(?,?) on conflict(job_id) do update set data=excluded.data').run(lease.jobId,JSON.stringify(next));});},
        enqueue(j) {
            return run(() => {
                if (!validJob(j) || j.state !== 'queued' || j.checkpointId !== null)
                    throw new AppError('INVALID_INPUT', 'New jobs must be queued without a checkpoint.');
                if (entry(j.id))
                    throw new AppError('CONFLICT', 'Job already exists.');
                insertLocalJob(db, j);
            });
        },
        claim(workerId, mode = 'all') {
            return run(() => {
                if (!nonemptyString(workerId))
                    throw new AppError('INVALID_INPUT', 'Worker ID is required.');
                if (!['all', 'visual'].includes(mode))
                    throw new AppError('INVALID_INPUT', 'Invalid claim mode.');
                const t = now();
                const running = db.sql.prepare("select * from jobs where state='running'").all() as unknown as Stored[];
                if (running.filter(r => { const l = JSON.parse(r.lease!) as Lease; return l.workerId === workerId && l.expiresAt > t; }).length >= 2)
                    return null;
                const r = db.sql.prepare(`select j.* from jobs j left join batches b on b.id=j.batch_id where (?='all' or (json_extract(j.data,'$.kind')='edit' and json_extract(j.data,'$.edit.producer.kind')='visual')) and j.pause=0 and (j.batch_id is null or b.state='active') and (j.state='queued' or (j.state='running' and json_extract(j.lease,'$.expiresAt')<=?)) and not exists(select 1 from jobs x where x.site_id=j.site_id and x.seq<>j.seq and x.state not in ('completed','cancelled') and (x.seq<j.seq or x.state='running')) order by j.seq limit 1`).get(mode, t) as unknown as Stored | undefined;
                if (!r)
                    return null;
                const admission = db.sql.prepare('select operation_id from operations where site_id=?').get(job(r).siteId);
                if (admission && admission.operation_id !== r.id)
                    return null;
                db.sql.prepare('insert into operations values(?,?,?) on conflict(site_id) do update set operation_id=excluded.operation_id').run(job(r).siteId, r.id, 'job');
                r.generation++;
                const j = { ...job(r), state: 'running' as const }, lease = { jobId: j.id, workerId, generation: r.generation, expiresAt: t + 120000 };
                save(r, j, JSON.stringify(lease));
                return { job: j, lease };
            });
        },
        heartbeat(lease) { return run(() => { const r = owned(lease), next = { ...lease, expiresAt: now() + 120000 }; save(r, job(r), JSON.stringify(next)); return next; }); },
        checkpoint(lease, cp, expected, projection) {
            return run(() => {
                const r = owned(lease), j = job(r);
                if (cp.jobId !== j.id || !nonemptyString(cp.id) || !nonemptyString(cp.stage))
                    throw new AppError('INVALID_INPUT', 'Checkpoint belongs to another job.');
                if (expected !== undefined && j.checkpointId !== expected)
                    throw new AppError('CONFLICT', 'Checkpoint changed.');
                if (projection) {
                    if (projection.evidence.checkpoint.id !== cp.id || projection.usage.predecessor !== (expected ?? j.checkpointId))
                        throw new AppError('CONFLICT', 'Проекция не соответствует контрольной точке.');
                    commitLocalProjection(db.sql, projection, true, lease);
                }
                db.sql.prepare("update payload_inventory set data=json_set(data,'$.accepted',json('true')) where kind='checkpoint' and id=?").run(cp.id);
                save(r, { ...j, checkpointId: cp.id, stage: cp.stage });
            });
        },
        shouldPause(lease) { return run(() => { const r = owned(lease); return !!r.pause || !batchActive(r); }); },
        pauseAtBoundary(lease,activity) {
            return run(() => {
                const r = owned(lease);
                if (!r.pause && batchActive(r))
                    return false;
                if(activity){const old=db.sql.prepare('select data from job_activity where job_id=?').get(lease.jobId);const next=nextActivity(old?JSON.parse(String(old.data)):null,lease.jobId,lease.generation,activity);db.sql.prepare('insert into job_activity values(?,?) on conflict(job_id) do update set data=excluded.data').run(lease.jobId,JSON.stringify(next));}
                save(r, { ...job(r), state: 'paused' }, null);
                return true;
            });
        },
        finish(lease, status,activity) {
            return run(() => {
                if (!['paused', 'waiting_provider', 'needs_attention', 'completed', 'cancelled'].includes(status))
                    throw new AppError('INVALID_INPUT', 'Invalid final state.');
                const r = owned(lease);
                if(activity){const old=db.sql.prepare('select data from job_activity where job_id=?').get(lease.jobId);const next=nextActivity(old?JSON.parse(String(old.data)):null,lease.jobId,lease.generation,activity);db.sql.prepare('insert into job_activity values(?,?) on conflict(job_id) do update set data=excluded.data').run(lease.jobId,JSON.stringify(next));}
                save(r, { ...job(r), state: status }, null);
            });
        },
        get(id) { return run(() => { const r = entry(id); return r ? job(r) : null; }); },
        current(siteId) { return run(() => { const r = db.sql.prepare("select * from jobs where site_id=? order by case when state in ('completed','cancelled') then 1 else 0 end,seq desc limit 1").get(siteId) as unknown as Stored | undefined; return r ? job(r) : null; }); },
        cancel(id) {
            return run(() => {
                const r = entry(id);
                if (!r)
                    throw new AppError('NOT_FOUND', 'Job does not exist.');
                if (job(r).state === 'running')
                    throw new AppError('CONFLICT', 'Дождитесь завершения текущей правки.');
                r.generation++;
                save(r, { ...job(r), state: 'cancelled' }, null);
            });
        },
        retry(id, recovery) {
            return run(() => {
                const r = entry(id);
                if (!r)
                    throw new AppError('NOT_FOUND', 'Job does not exist.');
                const j = job(r);
                if (!['paused', 'waiting_provider', 'needs_attention'].includes(j.state) || !batchActive(r))
                    throw new AppError('CONFLICT', 'Job cannot be retried in its current state.');
                if (recovery && (!validJob({ ...j, providerRecovery: recovery }) || j.kind !== 'generate' || j.state !== 'needs_attention' || j.checkpointId !== recovery.checkpointId))
                    throw new AppError('CONFLICT', 'Recovery does not match checkpoint.');
                r.pause = 0;
                save(r, { ...j, state: 'queued', ...(recovery ? { providerRecovery: recovery } : {}) }, null);
            });
        },
        async close() {
            if (closed)
                return;
            closed = true;
            if (!database)
                await db.close();
        }
    };
}
