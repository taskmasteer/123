import { AppError, type Principal } from '../../../../packages/contracts/src/model.js';
import { object, uuid, integer, string } from '../../../../packages/contracts/src/http.js';
import { authorize } from '../../../../packages/core/src/permissions.js';
import { createSourceFiles } from '../../../../packages/core/src/history.js';
import type { SupabaseRepository } from '../../../../packages/adapters/src/supabase-repository.js';
import type { R2Store } from '../../../../packages/adapters/src/r2-store.js';
import type { PostgresPublication } from '../../../../packages/adapters/src/postgres-publication.js';
import type { PostgresBackup } from '../../../../packages/adapters/src/postgres-backup.js';
export async function historyRoute(repo: SupabaseRepository, store: R2Store | undefined, publication: PostgresPublication | undefined, actor: Principal, request: Request, url: URL, body: unknown, backup?: PostgresBackup) {
    const validation = /^\/sites\/([^/]+)\/validation$/.exec(url.pathname);
    if (validation && request.method === 'GET') {
        const siteId = uuid(validation[1]), fresh = await repo.transaction(tx => repo.fresh(tx, actor));
        await repo.scoped(fresh, siteId);
        if (!store)
            throw new AppError('UNAVAILABLE', 'Хранилище не подключено.');
        const checkpointId = uuid(url.searchParams.get('checkpointId')), imageId = string(url.searchParams.get('imageId'), 100), file = await store.readValidation(siteId, checkpointId, imageId), offset = integer(Number(url.searchParams.get('offset') ?? 0), 0, file.bytes.length), bytes = file.bytes.slice(offset, offset + 24000);
        await repo.scoped(await repo.transaction(tx => repo.fresh(tx, actor)), siteId);
        return { mediaType: 'image/png', size: file.bytes.length, offset, base64: Buffer.from(bytes).toString('base64'), nextOffset: offset + bytes.length < file.bytes.length ? offset + bytes.length : null };
    }
    const match = /^\/sites\/([^/]+)\/(history|rollback|source|export)(?:\/(file))?$/.exec(url.pathname);
    if (!match)
        return undefined;
    const siteId = uuid(match[1]);
    const fresh = await repo.transaction(tx => repo.fresh(tx, actor));
    await repo.scoped(fresh, siteId, ['source', 'export'].includes(match[2]!) ? 'site:export' : match[2] === 'rollback' ? 'site:publish' : 'site:read');
    if (match[2] === 'export' && request.method === 'POST') {
        if (!backup)
            throw new AppError('UNAVAILABLE', 'Архивы не настроены.');
        const p = object(body, ['revisionId']);
        return backup.exportSite(fresh, siteId, uuid(p.revisionId));
    }
    if (match[2] === 'history' && request.method === 'GET') {
        const offset = integer(Number(url.searchParams.get('offset') ?? 0), 0, 100000), site = (await repo.get(siteId))!;
        const rows = (await repo.pool.query(`with settled as (select p.*,row_number() over(order by settled_seq desc nulls last,verified_at desc,id desc) n from private.provider_publications p where site_id=$1 and settlement='settled' and verified_at is not null),current_outcome as (select id from settled where revision_id=$3 order by n limit 1),kept as (select *,row_number() over(order by (id=(select id from current_outcome)) desc nulls last,n) keep_n from settled),boundary as (select verified_at from kept where keep_n=6 and settled_seq is null) select p.id,p.revision_id,p.manifest_id,p.verified_at,p.settled_at,p.settled_seq,p.settlement,p.editing_intent_id,d.data journal,coalesce(a.state,'available') availability,(p.id=(select id from current_outcome)) current,(k.keep_n<=6 or (p.settled_seq is null and p.verified_at=(select verified_at from boundary)) or p.settlement not in ('settled','cancelled')) retained,(p.settled_seq is null and (select count(*) from settled x where x.verified_at=p.verified_at)>1) uncertain from private.provider_publications p left join kept k on k.id=p.id left join private.deployments d on d.id=p.editing_intent_id left join private.payload_inventory a on a.kind='artifact' and a.id=p.manifest_id::text where p.site_id=$1 and p.verified_at is not null order by (p.settlement<>'settled') desc,p.settled_seq desc nulls last,p.verified_at desc,p.id desc limit 21 offset $2`, [siteId, offset, site.publishedId])).rows;
        return { items: rows.slice(0, 20).map(r => ({ id: r.id, siteId, revisionId: r.revision_id, manifestId: r.manifest_id, settledAt: Number(r.settled_at ?? r.verified_at), ...(r.settled_seq === null ? {} : { sequence: Number(r.settled_seq) }), orderingUncertain: r.uncertain, verifiedAt: Number(r.verified_at), settlement: r.settlement, origin: r.editing_intent_id ? r.journal?.selection === 'rollback' ? 'rollback' : 'draft' : 'generation', mode: 'managed', current: r.current === true, retained: r.retained === true, available: r.availability === 'available' })), nextOffset: rows.length > 20 ? offset + 20 : null };
    }
    if (match[2] === 'rollback' && request.method === 'POST') {
        if (!publication)
            throw new AppError('UNAVAILABLE', 'Публикация не настроена.');
        const p = object(body, ['revisionId', 'expectedRevision', 'requestKey']);
        return publication.requestPublication(fresh, siteId, uuid(p.revisionId), integer(p.expectedRevision), uuid(p.requestKey), 'rollback');
    }
    if (match[2] === 'source' && request.method === 'GET') {
        if (!store)
            throw new AppError('UNAVAILABLE', 'Хранилище не подключено.');
        const revisionId = uuid(url.searchParams.get('revisionId'));
        const source = createSourceFiles({ admin: async (a) => { const current = await repo.transaction(tx => repo.fresh(tx, a)); authorize(current, 'site:export'); }, revision: async (s, r) => { const revision = await repo.revision(r); return revision?.siteId === s ? revision : null; }, read: id => store.read(id) });
        if (!match[3])
            return { files: await source.listSourceFiles(fresh, siteId, revisionId) };
        const file = await source.readSourceFile(fresh, siteId, revisionId, string(url.searchParams.get('path'), 240)), offset = integer(Number(url.searchParams.get('offset') ?? 0), 0, file.bytes.length), bytes = file.bytes.slice(offset, offset + 24000);
        return { path: file.path, mediaType: file.mediaType, size: file.bytes.length, offset, base64: Buffer.from(bytes).toString('base64'), nextOffset: offset + bytes.length < file.bytes.length ? offset + bytes.length : null };
    }
    throw new AppError('NOT_FOUND', 'Маршрут истории не найден.');
}
