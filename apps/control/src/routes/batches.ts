import { AppError } from '../../../../packages/contracts/src/model.js';
import { uuid, integer } from '../../../../packages/contracts/src/http.js';
import type { PostgresQueue } from '../../../../packages/adapters/src/postgres-queue.js';
import type { R2Store } from '../../../../packages/adapters/src/r2-store.js';
import { retryControlledJob } from './job-controls.js';
import { object, string } from '../../../../packages/contracts/src/http.js';
import { importParams, importResponse } from '../../../../packages/contracts/src/import-wire.js';
import type { Principal } from '../../../../packages/contracts/src/model.js';
import { PostgresBatches } from '../../../../packages/adapters/src/postgres-batches.js';
import { PostgresImportResources } from '../../../../packages/adapters/src/postgres-import-resources.js';
import type { SupabaseRepository } from '../../../../packages/adapters/src/supabase-repository.js';
export async function batchesRoute(repo: SupabaseRepository, actor: Principal, request: Request, path: string, body: unknown, queue?: PostgresQueue, store?: R2Store) {
    if (path !== '/batches/commands' || request.method !== 'POST')
        return;
    const p = object(body, ['method', 'params']), method = string(p.method, 100), params = importParams(method, p.params), batches = new PostgresBatches(repo);
    if (method === 'batch.retry') {
        if (!queue)
            throw new AppError('UNAVAILABLE', 'Очередь недоступна.');
        const id = uuid(params.id), d = await batches.read(repo.pool, actor, id, true);
        if (d.summary.state !== 'active')
            throw new AppError('CONFLICT', 'Сначала продолжите пачку.');
        const row = (await repo.pool.query('select site_id from private.batch_rows where batch_id=$1 and row_number=$2', [id, integer(params.rowNumber, 2, 5001)])).rows[0];
        const job = row?.site_id ? (await repo.pool.query("select data from private.jobs where id=$1 and batch_id=$2 and data->>'kind'='generate'", [row.site_id, id])).rows[0]?.data : null;
        if (!job)
            throw new AppError('NOT_FOUND', 'Задание строки не найдено.');
        return retryControlledJob(queue, store, actor, job, params.modelIdentity ? { modelIdentity: params.modelIdentity } : {});
    }
    const result = await (method.startsWith('batch.') ? batches.request(actor, method, params) : new PostgresImportResources(batches).request(actor, method, params));
    return importResponse(method, result);
}
