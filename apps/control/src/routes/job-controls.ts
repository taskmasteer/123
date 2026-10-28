import { randomUUID } from 'node:crypto';
import { AppError, type Principal, type Job } from '../../../../packages/contracts/src/model.js';
import { object, string, uuid } from '../../../../packages/contracts/src/http.js';
import { record } from '../../../../packages/contracts/src/inputs.js';
import type { PostgresQueue } from '../../../../packages/adapters/src/postgres-queue.js';
import type { R2Store } from '../../../../packages/adapters/src/r2-store.js';
import { canRecover } from '../../../../packages/adapters/src/openai/responses.js';
export async function jobControlsRoute(queue: PostgresQueue | undefined, store: R2Store | undefined, actor: Principal, request: Request, path: string, body: unknown) {
    const match = /^\/sites\/([^/]+)\/jobs\/(retry|cancel)$/.exec(path);
    if (!match)
        return undefined;
    if (request.method !== 'POST' || !queue)
        throw new AppError('UNAVAILABLE', 'Управление заданиями недоступно.');
    const siteId = uuid(match[1]);
    await queue.repository.scoped(actor, siteId);
    const job = await queue.repository.current(siteId);
    if (!job)
        throw new AppError('NOT_FOUND', 'Задание не найдено.');
    if (match[2] === 'cancel') {
        object(body, []);
        await queue.cancel(job.id, actor);
        return { ok: true };
    }
    return retryControlledJob(queue, store, actor, job, body);
}
export async function retryControlledJob(queue: PostgresQueue, store: R2Store | undefined, actor: Principal, job: Job, body: unknown) {
    const siteId = job.siteId;
    const p = object(body, ['modelIdentity']);
    let recovery;
    if (job.state === 'needs_attention') {
        if (!store || !job.checkpointId || job.kind !== 'generate')
            throw new AppError('CONFLICT', 'Это задание нельзя возобновить.');
        const modelIdentity = string(p.modelIdentity, 160);
        if (!/^openai:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(modelIdentity))
            throw new AppError('INVALID_INPUT', 'Требуется настроенная модель.');
        const saved = await store.load(job.checkpointId), s = saved.state;
        if (saved.checkpoint.jobId !== job.id || s.jobId !== job.id || s.siteId !== siteId || s.baseRevision !== job.baseRevision || !['generate', 'validate'].includes(saved.checkpoint.stage) || (record(s.imageRun) && s.imageRun.status === 'pending') || !canRecover(s.continuation, typeof s.error === 'string' ? s.error : undefined))
            throw new AppError('CONFLICT', 'Ошибка не допускает восстановления учётных данных.');
        recovery = { id: randomUUID(), checkpointId: job.checkpointId, modelIdentity };
    }
    await queue.retry(job.id, recovery, actor);
    return { ok: true };
}
