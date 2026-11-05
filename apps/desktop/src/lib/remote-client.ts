import {publicationDiagnosticCaptions} from '../../../../packages/contracts/src/publication.js';
import {healthObservation,usageSummary} from '../../../../packages/contracts/src/monitoring.js';
import { cursorShape } from '../../../../packages/core/src/site-pagination.js';
import { importMethods } from '../../../../packages/contracts/src/import.js';
import { importParams, importResponse } from '../../../../packages/contracts/src/import-wire.js';
import { visualMethods, visualParams, visualResponse } from '../../../../packages/contracts/src/visual-wire.js';
import { recoveryMethods, recoveryParams, recoveryResponse } from '../../../../packages/contracts/src/recovery-wire.js';
import { screenshotIdentity } from '../../../../packages/contracts/src/visual.js';
import { AppError } from '../../../../packages/contracts/src/model.js';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { object, uuid, integer, string, siteView } from '../../../../packages/contracts/src/http.js';
import type { SessionView } from '../../../../packages/contracts/src/http.js';
const bad = (): never => { throw new AppError('INVALID_INPUT', 'Некорректный ответ сервера.'); };
function list(value: unknown) {
    if (!Array.isArray(value) || value.length > 10000)
        return bad();
    return value;
}
export function sessionView(value: unknown): SessionView {
    const s = object(value, ['principal', 'mode', 'capabilities']), p = object(s.principal, ['userId', 'role']), c = object(s.capabilities, ['admin', 'edit', 'generation', 'publish', 'export', 'preview', 'nativeModelSettings']);
    uuid(p.userId);
    if (!['user', 'spec-user', 'admin'].includes(String(p.role)) || s.mode !== 'managed' || Object.keys(c).length !== 7 || Object.values(c).some(v => typeof v !== 'boolean') || c.nativeModelSettings !== false || c.export !== false)
        return bad();
    return s as unknown as SessionView;
}
function publicationView(raw: unknown) {
    const p = object(raw, ['id', 'siteId', 'revisionId', 'manifestId', 'manifestHash', 'deploymentId', 'phase', 'retryAt', 'cancelRequested', 'settlement', 'verifiedAt', 'origin','diagnostic']);
    if(p.diagnostic!=null){const d=object(p.diagnostic,['code','action','at','retryable']);if(!Object.hasOwn(publicationDiagnosticCaptions,String(d.code))||typeof d.retryable!=='boolean')return bad();string(d.action,100);integer(d.at);}
    for (const key of ['id', 'siteId', 'revisionId', 'manifestId'])
        uuid(p[key]);
    if (!/^[a-f0-9]{64}$/.test(String(p.manifestHash)))
        return bad();
    if (p.deploymentId !== null)
        string(p.deploymentId, 200);
    if (!['pending', 'uploading', 'creating', 'checking', 'promoting', 'reconciling', 'waiting_quota', 'awaiting_dns', 'published', 'needs_attention'].includes(String(p.phase)) || !['pending', 'settled', 'cancelled', 'conflict'].includes(String(p.settlement)) || !['generation', 'draft', 'rollback'].includes(String(p.origin)) || typeof p.cancelRequested !== 'boolean')
        return bad();
    if (p.retryAt !== null)
        integer(p.retryAt);
    if (p.verifiedAt !== null)
        integer(p.verifiedAt);
    return p;
}
function domainView(raw: unknown) {
    const p = object(raw, ['records', 'verified']);
    if (typeof p.verified !== 'boolean')
        return bad();
    list(p.records).forEach(raw => {
        const r = object(raw, ['type', 'name', 'value']);
        if (!['A', 'CNAME', 'TXT'].includes(String(r.type)))
            return bad();
        string(r.name, 253);
        string(r.value, 2048);
    });
    return p;
}
function validate(method: string, value: unknown): unknown {
    if (method === 'site.rollback')
        return publicationView(value);
    if(method==='site.health')return healthObservation(value);if(method==='site.usage'||method==='usage.summary')return usageSummary(value);
    if (Object.hasOwn(recoveryMethods, method) && method !== 'recovery.release')
        return recoveryResponse(method, value);
    if (Object.hasOwn(visualMethods, method))
        return visualResponse(method, value);
    if (Object.hasOwn(importMethods, method))
        return importResponse(method, value);
    if (method === 'publication.request' || method === 'publication.resume')
        return publicationView(value);
    if (method === 'publication.history')
        return list(value).map(publicationView);
    if (method === 'publication.status') {
        const p = object(value, ['publication', 'domain']);
        if (p.publication !== null)
            publicationView(p.publication);
        domainView(p.domain);
        return p;
    }
    if (method === 'worker.list')
        return list(value).map(raw => {
            const w = object(raw, ['id', 'name', 'paused', 'revoked', 'lastHeartbeat', 'jobs']);
            uuid(w.id);
            string(w.name, 100);
            if (typeof w.paused !== 'boolean' || typeof w.revoked !== 'boolean')
                return bad();
            if (w.lastHeartbeat !== null)
                integer(w.lastHeartbeat);
            list(w.jobs).forEach(raw => { const j = object(raw, ['id', 'siteId', 'stage', 'state']); uuid(j.id); uuid(j.siteId); string(j.stage, 100); string(j.state, 30); });
            return w;
        });
    if (method === 'session')
        return sessionView(value);
    if (method === 'site.list') {
        const p = object(value, ['items', 'nextCursor']);
        if (p.nextCursor !== null)
            cursorShape(p.nextCursor);
        return { items: list(p.items).map(siteView), nextCursor: p.nextCursor };
    }
    if (method === 'site.create' || method === 'edit.accept')
        return siteView(value);
    if (method === 'chat.list')
        return list(value).map(m => {
            const p = object(m, ['id', 'role', 'text', 'createdAt']);
            uuid(p.id);
            if (!['user', 'assistant'].includes(String(p.role)) || typeof p.text !== 'string')
                return bad();
            integer(p.createdAt);
            return p;
        });
    if (method === 'edit.list') {
        const p = object(value, ['candidates', 'publication']);
        for (const c of list(p.candidates)) {
            const r = object(c, ['id', 'siteId', 'jobId', 'baseRevision', 'baseDraftId', 'baseManifestId', 'parentRevisionId', 'manifestId', 'status', 'validation', 'summary', 'createdAt', 'acceptance', 'instruction', 'job', 'visualSave']);
            if (r.visualSave !== undefined) {
                const v = object(r.visualSave, ['state']);
                if (!['pending', 'completed', 'failed'].includes(String(v.state)))
                    return bad();
            }
            for (const k of ['id', 'siteId', 'jobId', 'baseDraftId', 'baseManifestId', 'parentRevisionId'])
                uuid(r[k]);
            integer(r.baseRevision);
            integer(r.createdAt);
            if (r.manifestId !== null)
                uuid(r.manifestId);
            if (!['queued', 'running', 'checking', 'ready', 'rejected', 'accepted', 'conflict', 'failed'].includes(String(r.status)) || typeof r.summary !== 'string' || typeof r.instruction !== 'string')
                return bad();
            validate('edit.request', r.job);
            if (r.validation !== null) {
                const v = object(r.validation, ['ok', 'issues', 'screenshotIds']);
                if (typeof v.ok !== 'boolean')
                    return bad();
                list(v.screenshotIds).forEach(screenshotIdentity);
                list(v.issues).forEach(i => {
                    const issue = object(i, ['code', 'message', 'path']);
                    string(issue.code, 100);
                    string(issue.message, 4000);
                    if (issue.path !== undefined)
                        string(issue.path, 240);
                });
            }
            if (r.acceptance !== null) {
                const a = object(r.acceptance, ['expectedRevision', 'state']);
                integer(a.expectedRevision);
                if (!['pending', 'completed', 'conflict'].includes(String(a.state)))
                    return bad();
            }
        }
        if (p.publication !== null) {
            const q = object(p.publication, ['id', 'siteId', 'revisionId', 'manifestId', 'expectedRevision', 'state']);
            for (const key of ['id', 'siteId', 'revisionId', 'manifestId'])
                uuid(q[key]);
            integer(q.expectedRevision);
            if (!['pending', 'completed', 'conflict'].includes(String(q.state)))
                return bad();
        }
        return p;
    }
    if (method === 'edit.request') {
        const p = object(value, ['id', 'siteId', 'kind', 'stage', 'state', 'checkpointId', 'baseRevision']);
        uuid(p.id);
        uuid(p.siteId);
        if (!['generate', 'edit'].includes(String(p.kind)) || !['queued', 'running', 'paused', 'waiting_provider', 'needs_attention', 'completed', 'cancelled'].includes(String(p.state)))
            return bad();
        string(p.stage, 100);
        integer(p.baseRevision);
        if (p.checkpointId !== null)
            uuid(p.checkpointId);
        return p;
    }
    if (method === 'preview.open') {
        const p = object(value, ['url']);
        return { url: string(p.url, 4000) };
    }
    if (method === 'admin.users')
        return list(value).map(u => {
            const p = object(u, ['id', 'email', 'role', 'active']);
            uuid(p.id);
            string(p.email, 254);
            if (!['user', 'spec-user', 'admin'].includes(String(p.role)) || typeof p.active !== 'boolean')
                return bad();
            return p;
        });
    if (method === 'admin.integrations') {
        const p = object(value, ['database', 'auth', 'storage', 'queue', 'publication', 'invitations']);
        if (Object.values(p).some(v => !['configured', 'unavailable'].includes(String(v))))
            return bad();
        return p;
    }
    if (method === 'catalog.list') {
        const p = object(value, ['styles', 'references']);
        for (const s of list(p.styles)) {
            const v = object(s, ['id', 'name', 'version', 'enabled', 'referenceIds']);
            string(v.id, 100);
            string(v.name, 200);
            string(v.version, 100);
            if (typeof v.enabled !== 'boolean')
                return bad();
            list(v.referenceIds).forEach(x => string(x, 100));
        }
        for (const r of list(p.references)) {
            const v = object(r, ['id', 'name', 'url', 'viewedAt', 'palette', 'typography', 'density', 'adaptations', 'description']);
            for (const k of ['id', 'name', 'url', 'viewedAt', 'typography', 'density', 'description'])
                string(v[k], 4000);
            const url = new URL(String(v.url));
            if (!['https:', 'http:'].includes(url.protocol))
                return bad();
            list(v.palette).forEach(x => string(x, 200));
            list(v.adaptations).forEach(x => string(x, 4000));
        }
        return p;
    }
    if (method === 'admin.invite') {
        const p = object(value, ['id', 'state']);
        uuid(p.id);
        if (p.state !== 'completed')
            return bad();
        return p;
    }
    const p = object(value, ['ok']);
    if (p.ok !== true)
        return bad();
    return p;
}
export class RemoteClient {
    readonly mode = 'managed';
    private disposed=false;
    private archiveIds=new Set<string>();
    private archiveRequests=new Set<Promise<unknown>>();
    private archiveToken:string|null=null;
    constructor(readonly base: string, private token: () => Promise<string | null>, private transport: typeof fetch = fetch, private onDispose?: () => void) {
        const u = new URL(base);
        if ((u.protocol !== 'https:' && !(u.protocol === 'http:' && u.hostname === '127.0.0.1')) || u.pathname !== '/' || u.search || u.hash || u.username || u.password)
            throw new AppError('INVALID_INPUT', 'Требуется HTTPS-адрес API без пути.');
        this.base = u.origin;
    }
    dispose() {
        if(this.disposed)return;this.disposed=true;
        void (async()=>{await Promise.allSettled([...this.archiveRequests]);const token=this.archiveToken;if(token)await Promise.allSettled([...this.archiveIds].map(id=>invoke('archive_operation',{request:{action:'close',id,remote:{origin:this.base,accessToken:token}}})));this.archiveIds.clear();this.archiveToken=null;})().finally(()=>this.onDispose?.());
    }
    async archive<T>(request: unknown): Promise<T> { if (!isTauri())
        throw new AppError('UNAVAILABLE', 'Копии доступны в настольном приложении.'); if(this.disposed)throw new AppError('UNAUTHENTICATED','Подключение закрыто.');const token = await this.token(); if(this.disposed)throw new AppError('UNAUTHENTICATED','Подключение закрыто.'); if (!token)
        throw new AppError('UNAUTHENTICATED', 'Войдите в систему.'); if (!request || typeof request !== 'object' || Array.isArray(request) || 'remote' in request)
        throw new AppError('INVALID_INPUT', 'Неверная операция копии.'); this.archiveToken=token;
        const work=invoke<T>('archive_operation',{request:{...request,remote:{origin:this.base,accessToken:token}}}).then(value=>{const p=request as {action?:string;id?:string};if(p.action==='close'&&p.id)this.archiveIds.delete(p.id);if(value&&typeof value==='object'&&'id' in value&&typeof value.id==='string'){if(!this.archiveIds.has(value.id)&&this.archiveIds.size>=4)this.archiveIds.delete(this.archiveIds.values().next().value!);this.archiveIds.add(value.id);}return value;});
        this.archiveRequests.add(work);try{return await work;}finally{this.archiveRequests.delete(work);}
    }
    async modelSettings<T>(request: unknown): Promise<T> {
        if (!isTauri())
            throw new AppError('UNAVAILABLE', 'Настройки модели доступны в нативном приложении.');
        return invoke<T>('model_settings', { request });
    }
    async request<T>(method: string, params: unknown = {}): Promise<T> {
        if (Object.hasOwn(recoveryMethods, method))
            recoveryParams(method, params);
        if (method.startsWith('visual.selection.')) {
            if (!isTauri())
                throw new AppError('UNAVAILABLE', 'Выделение доступно в настольном приложении.');
            return invoke<T>('dispatch', { request: { id: crypto.randomUUID(), version: 1, method, params: visualParams(method, params) } });
        }
        if (['worker.enroll', 'worker.start', 'worker.stop', 'worker.status', 'worker.remove'].includes(method)) {
            if (!isTauri())
                throw new AppError('UNAVAILABLE', 'Запуск устройства доступен в нативном приложении.');
            const p = object(params, method === 'worker.enroll' ? ['name'] : method === 'worker.start' ? ['mode'] : []), action = method.slice(7);
            if (p.mode !== undefined && !['all', 'visual'].includes(String(p.mode)))
                return bad();
            const accessToken = ['enroll', 'remove'].includes(action) ? await this.token() : undefined;
            if (['enroll', 'remove'].includes(action) && !accessToken)
                throw new AppError('UNAUTHENTICATED', 'Войдите в систему.');
            const value = object(await invoke('managed_worker', { request: { action: action === 'remove' ? 'revoke' : action, ...(action === 'enroll' ? { name: string(p.name, 100), origin: this.base } : {}), ...(action === 'start' && p.mode ? { mode: p.mode } : {}), ...(['start', 'stop', 'remove'].includes(action) ? { expectedOrigin: this.base } : {}), ...(accessToken ? { accessToken } : {}) } }), ['workerId', 'name', 'origin', 'enrolled', 'running', 'error']);
            if (value.workerId !== null)
                uuid(value.workerId);
            if (value.name !== null)
                string(value.name, 100);
            if (value.origin !== null && value.origin !== this.base)
                throw new AppError('CONFLICT', 'Устройство зарегистрировано для другого API.');
            if (typeof value.enrolled !== 'boolean' || typeof value.running !== 'boolean' || value.error !== null && typeof value.error !== 'string')
                return bad();
            return value as T;
        }
        const p = Object.hasOwn(recoveryMethods, method) ? recoveryParams(method, params) : Object.hasOwn(visualMethods, method) ? visualParams(method, params) : Object.hasOwn(importMethods, method) ? importParams(method, params) : object(params, ['siteId', 'revisionId', 'instruction', 'expectedRevision', 'candidateId', 'domain', 'about', 'referenceId', 'layoutReferenceId', 'logoAssetId', 'mentionedUrl', 'mentionedDescription', 'path', 'offset', 'id', 'enabled', 'description', 'email', 'role', 'active', 'userIds', 'cursor', 'requestKey', 'domainFilter', 'status', 'batchId', 'limit']);
        if (method === 'device.status')
            return { mode: 'blocked', available: false, activeJobs: 0, maxJobs: 2, model: null, images: 'disabled', storage: 'managed', publication: 'unavailable' } as T;
        if (method === 'batch.retry' && isTauri()) {
            const status = await this.modelSettings<{
                mode: string;
                model: string | null;
            }>({ action: 'status' });
            if (status.mode === 'live' && status.model)
                p.modelIdentity = 'openai:' + status.model;
        }
        let path: string, verb = 'GET', body: unknown;
        switch (method) {
            case 'site.health':path=`/sites/${uuid(p.siteId)}/health`;break;
            case 'site.usage':path=`/sites/${uuid(p.siteId)}/usage`;break;
            case 'usage.summary':object(params,[]);path='/usage';break;
            case 'batch.delete':
            case 'batch.retry':
            case 'resource.begin':
            case 'resource.chunk':
            case 'import.prepare':
            case 'import.update':
            case 'import.commit':
            case 'logo.complete':
            case 'batch.list':
            case 'batch.get':
            case 'batch.rows':
            case 'batch.pause':
            case 'batch.resume':
            case 'batch.cancel':
            case 'batch.assign':
                path = '/batches/commands';
                verb = 'POST';
                body = { method, params: p };
                break;
            case 'publication.status':
                path = `/sites/${uuid(p.siteId)}/publication`;
                break;
            case 'publication.history':
                path = `/sites/${uuid(p.siteId)}/publication-history`;
                break;
            case 'publication.request':
                path = `/sites/${uuid(p.siteId)}/publication`;
                verb = 'POST';
                body = { revisionId: uuid(p.revisionId), expectedRevision: integer(p.expectedRevision), requestKey: uuid(p.requestKey) };
                break;
            case 'publication.resume':
                path = `/sites/${uuid(p.siteId)}/publication/resume`;
                verb = 'POST';
                body = { id: uuid(p.id) };
                break;
            case 'worker.list':
                path = '/workers';
                break;
            case 'worker.pause':
            case 'worker.resume':
            case 'worker.revoke':
                path = `/workers/${uuid(p.id)}/${method.slice(7)}`;
                verb = 'POST';
                body = {};
                break;
            case 'job.cancel':
                path = `/sites/${uuid(p.siteId)}/jobs/cancel`;
                verb = 'POST';
                body = {};
                break;
            case 'job.retry': {
                path = `/sites/${uuid(p.siteId)}/jobs/retry`;
                verb = 'POST';
                body = {};
                if (isTauri()) {
                    const status = await this.modelSettings<{
                        mode: string;
                        model: string | null;
                    }>({ action: 'status' });
                    if (status.mode === 'live' && status.model)
                        body = { modelIdentity: 'openai:' + status.model };
                }
                break;
            }
            case 'session':
                path = '/session';
                break;
            case 'site.list': {
                const query = new URLSearchParams();
                if (p.cursor !== undefined)
                    query.set('cursor', cursorShape(p.cursor));
                if (p.limit !== undefined)
                    query.set('limit', String(integer(p.limit, 1, 100)));
                if (p.domain !== undefined)
                    query.set('domain', String(p.domain));
                if (p.status !== undefined)
                    query.set('status', String(p.status));
                if (p.batchId !== undefined)
                    query.set('batchId', uuid(p.batchId));
                path = '/sites' + (query.size ? '?' + query.toString() : '');
                break;
            }
            case 'site.create':
                path = '/sites';
                verb = 'POST';
                body = p;
                break;
            case 'site.history':
                path = `/sites/${uuid(p.siteId)}/history?offset=${p.offset ?? 0}`;
                break;
            case 'site.rollback':
                path = `/sites/${uuid(p.siteId)}/rollback`;
                verb = 'POST';
                body = { revisionId: p.revisionId, expectedRevision: p.expectedRevision, requestKey: p.requestKey };
                break;
            case 'source.list':
                path = `/sites/${uuid(p.siteId)}/source?revisionId=${uuid(p.revisionId)}`;
                break;
            case 'source.read':
                path = `/sites/${uuid(p.siteId)}/source/file?revisionId=${uuid(p.revisionId)}&path=${encodeURIComponent(String(p.path))}&offset=${p.offset ?? 0}`;
                break;
            case 'recovery.publications':
                path = '/admin/recovery/publications?offset=' + (p.offset ?? 0);
                break;
            case 'recovery.reconcile':
                path = '/admin/recovery/reconcile';
                verb = 'POST';
                body = p;
                break;
            case 'recovery.status':
                path = '/admin/recovery/status';
                break;
            case 'recovery.release':
                path = '/admin/recovery/release';
                verb = 'POST';
                body = p;
                break;
            case 'edit.list':
                path = `/sites/${uuid(p.siteId)}/candidates`;
                break;
            case 'visual.projection':
            case 'visual.projection.chunk': {
                const query = new URLSearchParams({ expectedRevision: String(p.expectedRevision) });
                if (method === 'visual.projection.chunk') {
                    query.set('mapId', String(p.mapId));
                    query.set('index', String(p.index));
                }
                path = `/sites/${uuid(p.siteId)}/visual/projection?${query}`;
                break;
            }
            case 'visual.submit':
                path = `/sites/${uuid(p.siteId)}/visual/saves`;
                verb = 'POST';
                body = { expectedRevision: p.expectedRevision, mapId: p.mapId, patch: p.patch, requestKey: p.requestKey };
                break;
            case 'visual.status':
                path = `/sites/${uuid(p.siteId)}/visual/saves/${uuid(p.saveId)}`;
                break;
            case 'chat.list':
                path = `/sites/${uuid(p.siteId)}/chat`;
                break;
            case 'edit.request':
                path = `/sites/${uuid(p.siteId)}/edits`;
                verb = 'POST';
                body = { instruction: p.instruction, expectedRevision: p.expectedRevision, ...(p.candidateId ? { candidateId: p.candidateId } : {}) };
                break;
            case 'edit.accept':
            case 'edit.reject':
                path = `/sites/${uuid(p.siteId)}/candidates/${uuid(p.candidateId)}/${method === 'edit.accept' ? 'accept' : 'reject'}`;
                verb = 'POST';
                body = method === 'edit.accept' ? { expectedRevision: p.expectedRevision } : {};
                break;
            case 'preview.open':
                path = `/sites/${uuid(p.siteId)}/revisions/${uuid(p.revisionId)}/preview`;
                break;
            case 'catalog.list':
                path = '/catalog';
                break;
            case 'catalog.style.update':
                path = `/catalog/styles/${encodeURIComponent(string(p.id, 100))}`;
                verb = 'PATCH';
                body = { enabled: p.enabled };
                break;
            case 'catalog.reference.update':
                path = `/catalog/references/${encodeURIComponent(string(p.id, 100))}`;
                verb = 'PATCH';
                body = { description: p.description };
                break;
            case 'admin.users':
                path = '/admin/users';
                break;
            case 'admin.integrations':
                path = '/admin/integrations';
                break;
            case 'admin.invite':
                path = '/admin/invitations';
                verb = 'POST';
                body = { email: p.email, role: p.role };
                break;
            case 'admin.user.update':
                path = `/admin/users/${uuid(p.id)}`;
                verb = 'PATCH';
                body = { role: p.role, active: p.active };
                break;
            case 'admin.assignments':
                path = `/admin/sites/${uuid(p.siteId)}/assignments`;
                verb = 'PUT';
                body = { userIds: p.userIds };
                break;
            default: throw new AppError('UNAVAILABLE', 'Эта функция управляемого режима ещё не подключена.');
        }
        const token = await this.token();
        if (!token)
            throw new AppError('UNAUTHENTICATED', 'Войдите в систему.');
        let response: Response;
        try {
            const transport = this.transport;
            response = await transport(this.base + path, { method: verb, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', cache: 'no-store' });
        }
        catch {
            throw new AppError('UNAVAILABLE', 'Нет связи с общим API.');
        }
        let data: unknown;
        try {
            data = await response.json();
        }
        catch {
            return bad();
        }
        if (!response.ok) {
            const p = object(data, ['error', 'requestId']), e = object(p.error, ['code', 'message']);
            string(p.requestId, 100);
            const codes = ['UNAUTHENTICATED', 'UNAVAILABLE', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'INVALID_INPUT', 'DUPLICATE_DOMAIN', 'STALE_LEASE', 'PROVIDER_WAIT', 'NEEDS_ATTENTION'];
            if (!codes.includes(String(e.code)))
                return bad();
            throw new AppError(e.code as AppError['code'], string(e.message, 500));
        }
        const value = validate(method, data);
        if (method === 'preview.open') {
            const url = new URL((value as {
                url: string;
            }).url);
            if (url.origin !== this.base || url.pathname !== `/preview/${p.siteId}/${p.revisionId}/index.html` || url.username || url.password || url.hash || [...url.searchParams.keys()].join(',') !== 'cap' || !/^[-\w]+\.[-\w]+\.[-\w]+$/.test(url.searchParams.get('cap') ?? ''))
                return bad();
            if (isTauri())
                await invoke('open_remote_preview', { url: url.href });
            else if(window.factoryDesktop)await window.factoryDesktop.preview(url.href);
            else
                window.open(url.href, '_blank', 'noopener,noreferrer');
        }
        return value as T;
    }
}
