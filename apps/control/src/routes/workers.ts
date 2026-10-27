import { authorize } from '../../../../packages/core/src/permissions.js';
import { AppError, type Principal } from '../../../../packages/contracts/src/model.js';
import { object, string, uuid } from '../../../../packages/contracts/src/http.js';
import type { SupabaseRepository } from '../../../../packages/adapters/src/supabase-repository.js';
import { tokenHash } from '../auth.js';
import { PostgresQueue } from '../../../../packages/adapters/src/postgres-queue.js';
export async function workersRoute(repo: SupabaseRepository, actor: Principal, request: Request, path: string, body: unknown) {
    if (!path.startsWith('/workers'))
        return undefined;
    authorize(actor, 'admin:manage');
    if (path === '/workers' && request.method === 'GET')
        return (await repo.pool.query(`
  select w.id,w.name,w.paused,w.revoked_at is not null revoked,
   floor(extract(epoch from w.last_heartbeat)*1000)::text heartbeat,
   coalesce((select jsonb_agg(jsonb_build_object('id',j.id,'siteId',j.site_id,'stage',j.data->>'stage','state',j.data->>'state'))
    from (select * from private.jobs where coalesce(worker_id,last_worker_id)=w.id order by claimed_at desc nulls last,id limit 2) j),'[]') jobs
  from private.workers w order by w.id`)).rows.map(r => ({ id: r.id, name: r.name, paused: r.paused, revoked: r.revoked, lastHeartbeat: r.heartbeat === null ? null : Number(r.heartbeat), jobs: r.jobs }));
    if (path === '/workers/enroll' && request.method === 'POST') {
        const p = object(body, ['workerId', 'name', 'token', 'controlOrigin']), id = uuid(p.workerId), name = string(p.name, 100), token = string(p.token, 43);
        if (!/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, 'base64url').length !== 32 || Buffer.from(token, 'base64url').toString('base64url') !== token)
            throw new AppError('INVALID_INPUT', 'Некорректный ключ устройства.');
        const origin = new URL(string(p.controlOrigin, 1000));
        if (origin.protocol !== 'https:' || origin.origin !== p.controlOrigin || origin.origin !== new URL(request.url).origin)
            throw new AppError('INVALID_INPUT', 'Адрес установки не совпадает.');
        await repo.transaction(async (tx) => {
            authorize(await repo.fresh(tx, actor), 'admin:manage');
            await tx.query('insert into private.workers(id,name,token_hash,enrollment_actor,control_origin) values($1,$2,$3,$4,$5) on conflict(id) do nothing', [id, name, tokenHash(token), actor.userId, origin.origin]);
            const row = (await tx.query('select * from private.workers where id=$1 for update', [id])).rows[0];
            if (row.revoked_at || row.name !== name || row.token_hash !== tokenHash(token) || row.enrollment_actor !== actor.userId || row.control_origin !== origin.origin)
                throw new AppError('CONFLICT', 'Регистрация устройства изменилась или отозвана.');
        });
        return { workerId: id, name };
    }
    const action = /^\/workers\/([^/]+)\/(revoke|pause|resume)$/.exec(path);
    if (action && request.method === 'POST') {
        object(body, []);
        const id = uuid(action[1]);
        if (action[2] !== 'revoke') {
            await new PostgresQueue(repo).pauseWorker(id, action[2] === 'pause', actor);
            return { ok: true };
        }
        await repo.transaction(async (tx) => {
            authorize(await repo.fresh(tx, actor), 'admin:manage');
            const result = await tx.query('update private.workers set revoked_at=clock_timestamp(),paused=true where id=$1', [id]);
            if (!result.rowCount)
                throw new AppError('NOT_FOUND', 'Устройство не найдено.');
        });
        return { ok: true };
    }
    return undefined;
}
