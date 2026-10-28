import type { Principal } from '../../../../packages/contracts/src/model.js';
import { AppError } from '../../../../packages/contracts/src/model.js';
import type { ElementPatch, SaveView } from '../../../../packages/contracts/src/visual.js';
import { object, integer, string, uuid } from '../../../../packages/contracts/src/http.js';
import type { SupabaseRepository, Admission } from '../../../../packages/adapters/src/supabase-repository.js';
import type { R2Store } from '../../../../packages/adapters/src/r2-store.js';
import { createEditableMap } from '../../../../packages/core/src/visual/editable-map.js';
import { projectSelection } from '../../../../packages/core/src/visual/projection.js';
import { createProjectionCache } from '../../../../packages/core/src/visual/resources.js';
import { editingFor } from './editing.js';
import { visualSaveHash } from '../../../../packages/core/src/editing.js';
import { elementPatch } from '../../../../packages/contracts/src/visual.js';
const caches = new WeakMap<SupabaseRepository, ReturnType<typeof createProjectionCache>>();
export async function visualRoute(repo: SupabaseRepository, store: R2Store | undefined, actor: Principal, request: Request, url: URL, body: unknown) {
    const m = /^\/sites\/([^/]+)\/visual\/(projection|saves)(?:\/([^/]+))?$/.exec(url.pathname);
    if (!m)
        return undefined;
    const siteId = uuid(m[1]);
    if (request.method === 'GET' && m[2] === 'saves' && m[3] && await repo.denyRevokedVisualSave(actor, siteId, uuid(m[3])))
        throw new AppError('FORBIDDEN', 'Доступ к сохранению отозван.');
    const site = await repo.scoped(actor, siteId, request.method === 'GET' && m[2] === 'saves' ? 'site:read' : 'site:edit');
    if (!store)
        throw new AppError('UNAVAILABLE', 'Хранилище недоступно.');
    if (m[2] === 'projection' && request.method === 'GET') {
        if (!url.searchParams.has('expectedRevision') || site.revision !== integer(Number(url.searchParams.get('expectedRevision'))))
            throw new AppError('CONFLICT', 'Черновик изменился.');
        const revision = await repo.revision(site.draftId ?? site.publishedId ?? '');
        if (!revision || revision.siteId !== siteId)
            throw new AppError('NOT_FOUND', 'Версия недоступна.');
        const previous = (await repo.editingState(siteId)).candidates.find(c => c.id === revision.id && c.status === 'accepted')?.job.edit?.producer;
        let cache = caches.get(repo);
        if (!cache) {
            cache = createProjectionCache();
            caches.set(repo, cache);
        }
        const resource = await cache(JSON.stringify([actor.userId, siteId, site.revision, revision.id, revision.manifestId]), async () => { const files = await store.read(revision.manifestId); return projectSelection(files, createEditableMap(files, { siteId, revisionId: revision.id, manifestId: revision.manifestId, ...(previous ? { lineage: previous.binding.lineage } : {}) })); });
        if (url.searchParams.has('index')) {
            if (url.searchParams.get('mapId') !== resource.descriptor.mapId)
                throw new AppError('CONFLICT', 'Проекция устарела.');
            return resource.chunk(integer(Number(url.searchParams.get('index')), 0, 500));
        }
        return resource.descriptor;
    }
    let admission: Admission | undefined;
    if (request.method === 'POST' && m[2] === 'saves' && !m[3]) {
        const p = object(body, ['expectedRevision', 'mapId', 'patch', 'requestKey']);
        const hash = visualSaveHash(integer(p.expectedRevision), string(p.mapId, 160), elementPatch(p.patch)), key = string(p.requestKey, 100);
        const old = (await repo.editingState(siteId)).candidates.find(c => c.visualSave?.actorId === actor.userId && c.visualSave.requestKey === key);
        if (old) {
            if (old.visualSave!.payloadHash !== hash)
                throw new AppError('CONFLICT', 'Ключ сохранения уже использован.');
            return { saveId: old.id, status: old.visualSave!.state === 'pending' ? old.status : old.visualSave!.state };
        }
    }
    try {
        try {
            admission = await repo.acquire(actor, siteId);
        }
        catch (error) {
            if (!(error instanceof AppError && error.code === 'CONFLICT') || request.method !== 'GET' || !m[3])
                throw error;
            const c = (await repo.editingState(siteId)).candidates.find(c => c.id === uuid(m[3]) && c.visualSave);
            if (!c)
                throw new AppError('NOT_FOUND', 'Сохранение не найдено.');
            return { saveId: c.id, status: c.visualSave!.state === 'pending' ? c.status : c.visualSave!.state, ...(c.visualSave!.error ? { error: c.visualSave!.error } : {}) } satisfies SaveView;
        }
        const editing = editingFor(repo, store, admission);
        if (request.method === 'POST' && !m[3]) {
            const p = object(body, ['expectedRevision', 'mapId', 'patch', 'requestKey']);
            const job = await editing.requestVisual(actor, siteId, integer(p.expectedRevision), p.patch as ElementPatch, string(p.mapId, 160), string(p.requestKey, 100));
            return { saveId: job.edit!.candidateId, status: 'queued' };
        }
        if (request.method === 'GET' && m[3])
            return await editing.visualStatus(actor, siteId, uuid(m[3]));
    }
    finally {
        if (admission)
            await repo.release(admission);
    }
    return undefined;
}
