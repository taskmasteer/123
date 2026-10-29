import { batchesRoute } from './routes/batches.js';
import { historyRoute } from './routes/history.js';
import { recoveryRoute } from './routes/recovery.js';
import { recoveryTransferSelection, recoveryTransferRoute, verifiedRecoverySession } from './routes/recovery-transfer.js';
import { PostgresRecoveryTransfer } from '../../../packages/adapters/src/postgres-recovery-transfer.js';
import type { PostgresBackup } from '../../../packages/adapters/src/postgres-backup.js';
import { SignJWT, jwtVerify } from 'jose';
import { AppError } from '../../../packages/contracts/src/model.js';
import type { SessionView } from '../../../packages/contracts/src/http.js';
import { uuid } from '../../../packages/contracts/src/http.js';
import type { Auth } from './auth.js';
import type { SupabaseRepository } from '../../../packages/adapters/src/supabase-repository.js';
import type { R2Store } from '../../../packages/adapters/src/r2-store.js';
import { artifactPath } from '../../../packages/core/src/artifacts.js';
import { json, errorResponse, unavailable } from './errors.js';
import { sitesRoute } from './routes/sites.js';
import { editingRoute } from './routes/editing.js';
import { adminRoute } from './routes/admin.js';
import type { InvitationProvider } from './routes/admin.js';
import { workersRoute } from './routes/workers.js';
import { uploadsRoute } from './routes/uploads.js';
import { projectPreview } from './preview.js';
import { visualRoute } from './routes/visual.js';
import type { PostgresQueue } from '../../../packages/adapters/src/postgres-queue.js';
import { jobsRoute } from './routes/jobs.js';
import {workerHealthRoute,healthRoute} from './routes/health.js';
import { jobControlsRoute } from './routes/job-controls.js';
import type { PostgresPublication } from '../../../packages/adapters/src/postgres-publication.js';
import { publicationRoute } from './routes/publication.js';
export interface AppDependencies {
    backup?: PostgresBackup;
    auth: Auth;
    repository: SupabaseRepository;
    queue?: PostgresQueue;
    publication?: PostgresPublication;
    store?: R2Store;
    invitations?: InvitationProvider;
    previewKey?: Uint8Array;
    publicOrigin?: string;
    allowedOrigins?: string[];
}
async function body(request: Request, maximum=64000) {
    if (request.method === 'GET' || request.method === 'HEAD')
        return {};
    if (!request.headers.get('content-type')?.startsWith('application/json'))
        throw new AppError('INVALID_INPUT', 'Требуется JSON.');
    if (Number(request.headers.get('content-length') ?? 0) > maximum)
        throw new AppError('INVALID_INPUT', 'Запрос слишком большой.');
    const reader = request.body?.getReader();
    let size = 0;
    const parts: Uint8Array[] = [];
    if (reader)
        while (true) {
            const r = await reader.read();
            if (r.done)
                break;
            size += r.value.length;
            if (size > maximum) {
                await reader.cancel();
                throw new AppError('INVALID_INPUT', 'Используйте прямую загрузку ресурса.');
            }
            parts.push(r.value);
        }
    try {
        return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
    }
    catch {
        throw new AppError('INVALID_INPUT', 'Некорректный JSON.');
    }
}
export function createApp(deps: Partial<AppDependencies>) {
    return async (request: Request): Promise<Response> => {
        const url = new URL(request.url), origin = request.headers.get('origin');
        const cors = origin && deps.allowedOrigins?.includes(origin) ? origin : null;
        const finish = (r: Response) => {
            if (cors) {
                r.headers.set('access-control-allow-origin', cors);
                r.headers.set('vary', 'Origin');
            }
            return r;
        };
        try {
            if (origin && !cors && !url.pathname.startsWith('/preview/'))
                throw new AppError('FORBIDDEN', 'Источник не разрешён.');
            if (request.method === 'OPTIONS')
                return finish(new Response(null, { status: 204, headers: { 'access-control-allow-methods': 'GET,POST,PATCH,PUT,OPTIONS', 'access-control-allow-headers': 'authorization,content-type' } }));
            const preview = /^\/preview\/([^/]+)\/([^/]+)\/(.+)$/.exec(url.pathname);
            if (preview) {
                if (request.method !== 'GET' || !deps.previewKey || !deps.repository || !deps.store)
                    return unavailable();
                if (/%(?:2e|2f|5c|25|00)/i.test(preview[3]!))
                    throw new AppError('INVALID_INPUT', 'Недопустимый путь ресурса.');
                const siteId = uuid(preview[1]), revisionId = uuid(preview[2]), path = artifactPath(decodeURIComponent(preview[3]!));
                const asset = url.searchParams.get('asset');
                const cap = asset ?? url.searchParams.get('cap') ?? request.headers.get('cookie')?.split(';').map(v => v.trim()).find(v => v.startsWith('sf_preview='))?.slice(11);
                let claims;
                try {
                    claims = (await jwtVerify(cap ?? '', deps.previewKey, { audience: asset ? 'site-preview-asset' : 'site-preview', algorithms: ['HS256'], requiredClaims: ['exp', 'sub'] })).payload;
                }
                catch {
                    throw new AppError('UNAUTHENTICATED', 'Предпросмотр истёк.');
                }
                if (asset && claims.path !== path)
                    throw new AppError('FORBIDDEN', 'Предпросмотр другого ресурса.');
                if (claims.siteId !== siteId || claims.revisionId !== revisionId)
                    throw new AppError('FORBIDDEN', 'Предпросмотр другой версии.');
                const role = await deps.repository.membership(claims.sub!);
                if (!role)
                    throw new AppError('FORBIDDEN', 'Нет доступа.');
                await deps.repository.scoped({ userId: claims.sub!, role }, siteId);
                const revision = await deps.repository.revision(revisionId);
                if (!revision || revision.siteId !== siteId)
                    throw new AppError('NOT_FOUND', 'Версия не найдена.');
                if (url.searchParams.has('cap')) {
                    url.searchParams.delete('cap');
                    return new Response(null, { status: 303, headers: { location: url.pathname, 'set-cookie': `sf_preview=${cap}; Path=/preview/${siteId}/${revisionId}/; HttpOnly; Secure; SameSite=None; Max-Age=600`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
                }
                const files = await deps.store.read(revision.manifestId), file = files.find(f => f.path === path);
                if (!file)
                    throw new AppError('NOT_FOUND', 'Файл не найден.');
                const projected = await projectPreview(file, files, { userId: claims.sub!, siteId, revisionId, expiresAt: claims.exp! }, deps.previewKey);
                if (projected.byteLength > 4000000)
                    throw new AppError('UNAVAILABLE', 'Предпросмотр превышает лимит ответа.');
                return new Response(Buffer.from(projected), { headers: { 'content-type': file.mediaType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...(asset ? { 'access-control-allow-origin': '*' } : {}), 'content-security-policy': "sandbox allow-scripts; default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'" } });
            }
            const token = /^Bearer ([^\s]+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
            if (!token)
                throw new AppError('UNAUTHENTICATED', 'Войдите в систему.');
            if (!deps.auth || !deps.repository)
                return unavailable();
            if (url.pathname.startsWith('/uploads/') || url.pathname.startsWith('/worker/')) {
                const worker = await deps.auth.verifyWorker(token);
                if (request.method !== 'POST')
                    throw new AppError('NOT_FOUND', 'Маршрут не найден.');
                const data = await body(request), result = url.pathname.startsWith('/worker/health/') ? await workerHealthRoute(deps.repository,worker.workerId,url.pathname,data) : url.pathname.startsWith('/worker/') ? await jobsRoute(deps.queue, deps.store, worker.workerId, url.pathname, data, deps.publication) : await uploadsRoute(deps.store, worker.workerId, url.pathname, data);
                return finish(result instanceof Response ? result : json(result));
            }
            const actor = await deps.auth.verifyUser(token), repo = deps.repository;
            if (url.pathname === '/session' && request.method === 'GET') {
                // Membership projection has no payload capabilities and must remain available during an atomic install.
                const role=await repo.membership(actor.userId);
                if(!role)throw new AppError('FORBIDDEN','Нет доступа.');
                const current={userId:actor.userId,role};
                const result: SessionView = { principal: current, mode: 'managed', capabilities: { admin: current.role === 'admin', edit: current.role !== 'user', generation: !!deps.queue && !!deps.store, publish: !!deps.publication, export: false, preview: !!deps.store && !!deps.previewKey, nativeModelSettings: false } };
                const response=json(result);response.headers.set('x-site-factory-session',verifiedRecoverySession(token,actor));return finish(response);
            }
            if (url.pathname === '/admin/integrations' && request.method === 'GET') {
                if (actor.role !== 'admin')
                    throw new AppError('FORBIDDEN', 'Только администратор.');
                return finish(json({ database: 'configured', auth: 'configured', storage: deps.store ? 'configured' : 'unavailable', queue: deps.queue ? 'configured' : 'unavailable', publication: deps.publication ? 'configured' : 'unavailable', invitations: deps.invitations ? 'configured' : 'unavailable' }));
            }
            const grant = /^\/sites\/([^/]+)\/revisions\/([^/]+)\/preview$/.exec(url.pathname);
            if (grant && request.method === 'GET') {
                if (!deps.store || !deps.previewKey || !deps.publicOrigin)
                    return unavailable();
                const siteId = uuid(grant[1]), revisionId = uuid(grant[2]);
                await repo.scoped(actor, siteId);
                const revision = await repo.revision(revisionId);
                if (!revision || revision.siteId !== siteId)
                    throw new AppError('NOT_FOUND', 'Версия не найдена.');
                const candidate = (await repo.editingState(siteId)).candidates.find(c => c.id === revisionId);
                if (candidate && !['ready', 'accepted', 'conflict'].includes(candidate.status))
                    throw new AppError('FORBIDDEN', 'Вариант не готов.');
                const cap = await new SignJWT({ siteId, revisionId }).setSubject(actor.userId).setAudience('site-preview').setIssuedAt().setExpirationTime('10m').setProtectedHeader({ alg: 'HS256' }).sign(deps.previewKey);
                return finish(json({ url: `${deps.publicOrigin}/preview/${siteId}/${revisionId}/index.html?cap=${cap}` }));
            }
            const selectedTransfer=recoveryTransferSelection(request,url),scope=verifiedRecoverySession(token,actor);
            if(selectedTransfer){
                if(!deps.backup)return unavailable();
                await deps.backup.admin(actor);
                await new PostgresRecoveryTransfer(deps.backup,scope).authorize(actor,selectedTransfer.id,selectedTransfer.kind,selectedTransfer.action==='cancel');
                const payload=await body(request,selectedTransfer.large?2*1024**2:64000);
                return finish(json(await recoveryTransferRoute(deps.backup,actor,scope,request,url,payload)));
            }
            const data = await body(request);
            const monitoring=await healthRoute(repo,actor,request,url.pathname,data);if(monitoring!==undefined)return finish(json(monitoring));
            const recovery = await recoveryRoute(deps.backup, actor, request, url, data, deps.publication,scope);
            if (recovery !== undefined)
                return finish(json(recovery));
            if (/\/(visual|candidates|chat|publication|publish|edits)(?:\/|$)/.test(url.pathname) && (await repo.pool.query("select 1 from private.recovery_state where key='quarantine'")).rowCount)
                throw new AppError('CONFLICT', 'Восстановленная установка ожидает проверки; автоматическая обработка приостановлена.');
            const publication = await publicationRoute(deps.publication, actor, request, url.pathname, data);
            if (publication !== undefined)
                return finish(json(publication));
            const control = await jobControlsRoute(deps.queue, deps.store, actor, request, url.pathname, data);
            if (control !== undefined)
                return finish(json(control));
            for (const route of [() => historyRoute(repo, deps.store, deps.publication, actor, request, url, data, deps.backup,scope), () => visualRoute(repo, deps.store, actor, request, url, data), () => batchesRoute(repo, actor, request, url.pathname, data, deps.queue, deps.store), () => sitesRoute(repo, actor, request, url, data), () => editingRoute(repo, deps.store, actor, request, url.pathname, data), () => adminRoute(repo, deps.invitations, actor, request, url.pathname, data), () => workersRoute(repo, actor, request, url.pathname, data)]) {
                const result = await route();
                if (result !== undefined)
                    return finish(json(result));
            }
            throw new AppError('NOT_FOUND', 'Маршрут не найден.');
        }
        catch (error) {
            return finish(errorResponse(error));
        }
    };
}
