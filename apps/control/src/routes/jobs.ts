import { PostgresBatches } from '../../../../packages/adapters/src/postgres-batches.js';
import { PostgresImportResources } from '../../../../packages/adapters/src/postgres-import-resources.js';
import { AppError } from '../../../../packages/contracts/src/model.js';
import { integer, leaseDto, object, string, uuid } from '../../../../packages/contracts/src/http.js';
import type { PostgresQueue } from '../../../../packages/adapters/src/postgres-queue.js';
import type { R2Store } from '../../../../packages/adapters/src/r2-store.js';
import type { PostgresPublication } from '../../../../packages/adapters/src/postgres-publication.js';
export async function jobsRoute(queue: PostgresQueue | undefined, store: R2Store | undefined, workerId: string, path: string, body: unknown, publication?: PostgresPublication): Promise<unknown> {
    if (!queue)
        throw new AppError('UNAVAILABLE', 'Очередь не подключена.');
    if (path === '/worker/publications/tick') {
        object(body, []);
        const worker = (await queue.repository.pool.query('select id from private.workers where id=$1 and revoked_at is null', [workerId])).rows[0];
        if (!worker)
            throw new AppError('STALE_LEASE', 'Устройство отозвано.');
        const outcomes = await Promise.allSettled([new PostgresBatches(queue.repository).advance(), publication?.tick()]);
        const failed = outcomes.find(outcome => outcome.status === 'rejected');
        if (failed?.status === 'rejected')
            throw failed.reason;
        return { ok: true };
    }
    const receipt = /^\/worker\/jobs\/([^/]+)\/publication-receipt$/.exec(path);
    if (receipt) {
        const p = object(body, ['lease']), lease = leaseDto(p.lease);
        if (lease.jobId !== uuid(receipt[1]) || lease.workerId !== workerId)
            throw new AppError('STALE_LEASE', 'Чужое задание.');
        return publication ? publication.receipt(workerId, lease) : null;
    }
    if (path === '/worker/jobs/claim') {
        object(body, []);
        return queue.claim(workerId);
    }
    const route = /^\/worker\/jobs\/([^/]+)\/(heartbeat|checkpoint|finish|pause-status|pause-boundary|site|publication|snapshot|resource|artifact|revision|catalog|logo)$/.exec(path);
    if (!route)
        throw new AppError('NOT_FOUND', 'Маршрут исполнителя не найден.');
    const fields: Record<string, string[]> = { logo: ['id'], checkpoint: ['checkpointId', 'expectedCheckpointId'], finish: ['state'], publication: ['binding'], snapshot: ['id'], resource: ['id', 'kind', 'path'], artifact: ['id'], revision: ['id'] };
    const p = object(body, ['lease', ...(fields[route[2]!] ?? [])]), lease = leaseDto(p.lease);
    if (lease.jobId !== uuid(route[1]) || lease.workerId !== workerId)
        throw new AppError('STALE_LEASE', 'Чужая аренда.');
    switch (route[2]) {
        case 'logo': {
            const bound = await queue.repository.transaction(tx => queue.assertCurrent(tx, workerId, lease));
            const site = await queue.repository.get(bound.siteId);
            if (site?.input.logoAssetId !== uuid(p.id))
                throw new AppError('FORBIDDEN', 'Чужой логотип.');
            const file = await new PostgresImportResources(new PostgresBatches(queue.repository)).readLogo(String(p.id), bound.siteId);
            return new Response(Buffer.from(file.bytes), { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } });
        }
        case 'catalog': return queue.repository.transaction(async (tx) => {
            await queue.assertCurrent(tx, workerId, lease);
            return (await tx.query("select data from private.catalog where kind='style' order by id")).rows.map(r => r.data);
        });
        case 'revision': return queue.repository.transaction(async (tx) => {
            const bound = await queue.assertCurrent(tx, workerId, lease);
            const revision = await queue.repository.revision(uuid(p.id), tx);
            if (!revision || revision.siteId !== bound.siteId)
                throw new AppError('NOT_FOUND', 'Версия не найдена.');
            return revision;
        });
        case 'snapshot':
        case 'resource':
        case 'artifact': {
            if (!store)
                throw new AppError('UNAVAILABLE', 'Хранилище не подключено.');
            const id = uuid(p.id), kind = route[2] === 'snapshot' ? 'checkpoint' : route[2] === 'artifact' ? 'artifact' : string(p.kind, 20);
            if (!['artifact', 'checkpoint'].includes(kind))
                throw new AppError('INVALID_INPUT', 'Некорректный ресурс.');
            const metadata = await queue.repository.transaction(async (tx) => {
                const bound = await queue.assertCurrent(tx, workerId, lease);
                if (kind === 'artifact') {
                    const artifact = (await tx.query('select manifest from private.artifacts where id=$1 and site_id=$2 and verified', [id, bound.siteId])).rows[0];
                    if (!artifact)
                        throw new AppError('NOT_FOUND', 'Снимок не найден.');
                    return artifact.manifest;
                }
                const cp = (await tx.query('select c.*,j.checkpoint_id committed from private.checkpoints c join private.jobs j on j.id=c.job_id where c.id=$1 and c.job_id=$2', [id, lease.jobId])).rows[0];
                if (!cp || !(cp.committed === id || (cp.worker_id === workerId && Number(cp.generation) === lease.generation)))
                    throw new AppError('FORBIDDEN', 'Контрольная точка недоступна.');
                return cp.metadata;
            });
            if (route[2] === 'artifact')
                return metadata;
            if (route[2] === 'snapshot')
                return { checkpoint: metadata.checkpoint, files: metadata.manifest.files.map(({ path, mediaType, size, sha256 }: Record<string, unknown>) => ({ path, mediaType, size, sha256 })) };
            const resource = string(p.path, 240);
            if (kind === 'checkpoint') {
                const loaded = await store.load(id);
                if (resource === '@state')
                    return new Response(JSON.stringify(loaded.state), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
                const file = loaded.files.find(f => f.path === resource);
                if (!file)
                    throw new AppError('NOT_FOUND', 'Файл не найден.');
                return new Response(Buffer.from(file.bytes), { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
            }
            const file = (await store.read(id)).find(f => f.path === resource);
            if (!file)
                throw new AppError('NOT_FOUND', 'Файл не найден.');
            return new Response(Buffer.from(file.bytes), { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
        }
        case 'heartbeat': return queue.heartbeat(lease);
        case 'pause-status': return { paused: await queue.shouldPause(lease) };
        case 'pause-boundary': return { paused: await queue.pauseAtBoundary(lease) };
        case 'checkpoint': {
            if (!store)
                throw new AppError('UNAVAILABLE', 'Хранилище не подключено.');
            const checkpoint = await store.load(uuid(p.checkpointId));
            await queue.checkpoint(lease, checkpoint.checkpoint, p.expectedCheckpointId === null ? null : uuid(p.expectedCheckpointId));
            return { ok: true };
        }
        case 'finish':
            await queue.finish(lease, string(p.state, 30) as Parameters<PostgresQueue['finish']>[1]);
            return { ok: true };
        case 'site': return queue.repository.transaction(async (tx) => {
            const bound = await queue.assertCurrent(tx, workerId, lease);
            return queue.repository.get(bound.siteId, tx);
        });
        case 'publication': {
            const b = object(p.binding, ['requestKey', 'manifestId', 'revisionId', 'expectedRevision', 'checkpointId']);
            if (!store)
                throw new AppError('UNAVAILABLE', 'Хранилище не подключено.');
            await queue.repository.transaction(tx => queue.assertPublicationCurrent(tx, workerId, lease));
            const saved = await store.load(uuid(b.checkpointId));
            if (saved.checkpoint.jobId !== lease.jobId || saved.state.revisionId !== b.revisionId || saved.state.manifestId !== b.manifestId)
                throw new AppError('CONFLICT', 'Публикация не соответствует приватному снимку.');
            const reservation = await queue.reservePublication(lease, { requestKey: string(b.requestKey, 200), manifestId: uuid(b.manifestId), revisionId: uuid(b.revisionId), expectedRevision: integer(b.expectedRevision), checkpointId: uuid(b.checkpointId) });
            if (publication) {
                const intent = await publication.attach(reservation.id);
                return { id: intent.id, state: intent.phase };
            }
            return { id: reservation.id, state: 'pending' };
        }
    }
}
