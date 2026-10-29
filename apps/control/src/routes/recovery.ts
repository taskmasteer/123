import { PostgresRecoveryTransfer } from '../../../../packages/adapters/src/postgres-recovery-transfer.js';
import { AppError, type Principal } from '../../../../packages/contracts/src/model.js';
import { object, uuid, integer, string } from '../../../../packages/contracts/src/http.js';
import type { PostgresBackup } from '../../../../packages/adapters/src/postgres-backup.js';
import type { PostgresPublication } from '../../../../packages/adapters/src/postgres-publication.js';
import type { RecoveryRecord } from '../../../../packages/adapters/src/recovery-records.js';
export async function recoveryRoute(backup: PostgresBackup | undefined, actor: Principal, request: Request, url: URL, body: unknown, publication?: PostgresPublication,scope?:string) {
    if (!url.pathname.startsWith('/admin/recovery/'))
        return undefined;
    if (!backup)
        throw new AppError('UNAVAILABLE', 'Управляемое восстановление не настроено.');
    await backup.admin(actor);
    if (url.pathname === '/admin/recovery/publications' && request.method === 'GET') {
        if (!publication)
            throw new AppError('UNAVAILABLE', 'Настройте аккаунт публикации для безопасной сверки.');
        return publication.recoveryPublications(actor, integer(Number(url.searchParams.get('offset') ?? 0), 0, 100000));
    }
    if (url.pathname === '/admin/recovery/reconcile' && request.method === 'POST') {
        if (!publication)
            throw new AppError('UNAVAILABLE', 'Настройте аккаунт публикации для безопасной сверки.');
        const p = object(body, ['restoreId', 'id', 'digest', 'retiredSourceAuthority']);
        if (p.retiredSourceAuthority !== true || typeof p.digest !== 'string' || !/^[a-f0-9]{64}$/.test(p.digest))
            throw new AppError('INVALID_INPUT', 'Подтвердите отключение прежнего API и обновите список сверки.');
        return publication.reconcileRecovery(actor, uuid(p.restoreId), uuid(p.id), p.digest);
    }
    if (url.pathname === '/admin/recovery/status' && request.method === 'GET')
        return backup.status(actor);
    if (url.pathname === '/admin/recovery/release' && request.method === 'POST') {
        const p = object(body, ['retiredSourceAuthority']);
        if (p.retiredSourceAuthority !== true)
            throw new AppError('CONFLICT', 'Подтвердите отключение прежнего управляющего API и сверку его ключей провайдеров.');
        return backup.release(actor);
    }
    if (url.pathname === '/admin/recovery/snapshots' && request.method === 'POST') {
        object(body, []);
        return backup.beginSnapshot(actor,scope);
    }
    if (url.pathname === '/admin/recovery/restores' && request.method === 'POST') {
        const p = object(body, ['header', 'mappings', 'records', 'inventoryDigest']);
        if (!Array.isArray(p.mappings) || p.mappings.length > 50)
            throw new AppError('INVALID_INPUT', 'Не более 50 привязок в запросе.');
        const mappings = p.mappings.map(v => { const m = object(v, ['sourceId', 'destinationId']); return { sourceId: uuid(m.sourceId), destinationId: uuid(m.destinationId) }; });
        return backup.beginRestore(actor, p.header as RecoveryRecord, mappings, integer(p.records, 1, 1000000),p.inventoryDigest,scope);
    }
    const match = /^\/admin\/recovery\/(snapshots|restores)\/([^/]+)\/(record|resource|record-part|record-complete|chunk|object-complete|install|close|mappings)$/.exec(url.pathname);
    if (!match)
        throw new AppError('NOT_FOUND', 'Маршрут копии не найден.');
    const id = uuid(match[2]), action = match[3];
    await new PostgresRecoveryTransfer(backup,scope).authorize(actor,id,match[1],action==='close');
    if (request.method === 'POST' && action === 'mappings') {
        const p = object(body, ['mappings']);
        if (!Array.isArray(p.mappings) || p.mappings.length > 50)
            throw new AppError('INVALID_INPUT', 'Не более 50 привязок в запросе.');
        return backup.addMappings(actor, id, p.mappings.map(v => { const m = object(v, ['sourceId', 'destinationId']); return { sourceId: uuid(m.sourceId), destinationId: uuid(m.destinationId) }; }));
    }
    if (request.method === 'GET' && ['record', 'resource'].includes(action!)) {
        const seq = integer(Number(url.searchParams.get('seq')), 0, 999999), offset = integer(Number(url.searchParams.get('offset') ?? 0), 0, (32 * 1024 ** 2));
        return action === 'record' ? backup.record(actor, id, seq, offset) : backup.resource(actor, id, seq, offset);
    }
    if (request.method === 'POST') {
        if (action === 'close') {
            object(body, []);
            await backup.close(actor, id);
            return { ok: true };
        }
        if (action === 'install') {
            object(body, []);
            return backup.install(actor, id);
        }
        if (action === 'record-part') {
            const p = object(body, ['seq', 'index', 'base64']);
            await backup.stageMetadataChunk(actor, id, integer(p.seq, 0, 999999), integer(p.index, 0, 42), string(p.base64, 32000));
            return { ok: true };
        }
        if (action === 'record-complete') {
            const p = object(body, ['seq']);
            await backup.finishMetadata(actor, id, integer(p.seq, 0, 999999));
            return { ok: true };
        }
        if (action === 'chunk') {
            const p = object(body, ['seq', 'index', 'base64']);
            await backup.stageChunk(actor, id, integer(p.seq, 0, 999999), integer(p.index, 0, 1400), string(p.base64, 32000));
            return { ok: true };
        }
        if (action === 'object-complete') {
            const p = object(body, ['seq']);
            return backup.finishObject(actor, id, integer(p.seq, 0, 999999));
        }
    }
    throw new AppError('NOT_FOUND', 'Операция копии не найдена.');
}
