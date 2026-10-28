import { createHash } from 'node:crypto';
import { AppError, type ArtifactFile, type Checkpoint, type Job, type Lease, type Manifest, type Queue } from '../../../packages/contracts/src/model.js';
import { object, integer, leaseDto, siteView, string, uuid } from '../../../packages/contracts/src/http.js';
import { validJob } from '../../../packages/adapters/src/local-queue.js';
import { checkArtifacts } from '../../../packages/core/src/artifacts.js';
import { uploadResources } from './remote-uploads.js';
import { validateSite } from './validation/browser.js';
import type { WorkerDeps } from './pipeline.js';
export function controlOrigin(value: string) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password)
        throw new AppError('INVALID_INPUT', 'Требуется HTTPS-адрес API без пути.');
    return url.origin;
}
function checkpointDto(value: unknown): Checkpoint {
    const c = object(value, ['id', 'jobId', 'stage', 'manifestId', 'stateKey', 'createdAt']);
    return { id: uuid(c.id), jobId: uuid(c.jobId), stage: string(c.stage, 100), manifestId: c.manifestId === null ? null : uuid(c.manifestId), stateKey: string(c.stateKey, 1000), createdAt: integer(c.createdAt) };
}
function manifestDto(value: unknown): Manifest {
    const m = object(value, ['id', 'siteId', 'templateVersion', 'createdAt', 'files']);
    if (!Array.isArray(m.files))
        throw new AppError('INVALID_INPUT', 'Некорректный снимок.');
    const files = m.files.map(f => {
        const p = object(f, ['path', 'objectKey', 'mediaType', 'size', 'sha256', 'sha1']);
        if (!/^[a-f0-9]{64}$/.test(String(p.sha256)) || !/^[a-f0-9]{40}$/.test(String(p.sha1)))
            throw new AppError('INVALID_INPUT', 'Некорректный хэш.');
        return { path: string(p.path, 240), objectKey: string(p.objectKey, 1000), mediaType: string(p.mediaType, 100), size: integer(p.size, 0, 2000000), sha256: String(p.sha256), sha1: String(p.sha1) };
    });
    checkArtifacts(files.map(f => ({ ...f, bytes: new Uint8Array() })));
    return { id: uuid(m.id), siteId: uuid(m.siteId), templateVersion: string(m.templateVersion, 100), createdAt: integer(m.createdAt), files };
}
export function createRemoteWorker(options: {
    controlOrigin: string;
    workerId: string;
    workerToken: string;
    claimMode?: 'all' | 'visual';
    fetch?: typeof fetch;
}, local: WorkerDeps): WorkerDeps {
    const origin = controlOrigin(options.controlOrigin), transport = options.fetch ?? fetch;
    async function call(path: string, body: unknown, binary = false): Promise<any> {
        let response: Response;
        try {
            response = await transport(origin + path, { method: 'POST', headers: { authorization: 'Bearer ' + options.workerToken, 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30000) });
        }
        catch {
            throw new AppError('UNAVAILABLE', 'Нет связи с очередью.');
        }
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > 4000000)
            throw new AppError('INVALID_INPUT', 'Ответ слишком большой.');
        if (!response.ok) {
            let code: unknown;
            try {
                code = JSON.parse(Buffer.from(bytes).toString()).error?.code;
            }
            catch {
            }
            throw new AppError(['UNAUTHENTICATED', 'STALE_LEASE', 'CONFLICT', 'FORBIDDEN', 'INVALID_INPUT', 'NOT_FOUND', 'UNAVAILABLE'].includes(String(code)) ? code as AppError['code'] : 'UNAVAILABLE', 'Сервер отклонил запрос исполнителя.');
        }
        return binary ? new Uint8Array(bytes) : JSON.parse(Buffer.from(bytes).toString());
    }
    const endpoint = (lease: Lease, action: string) => `/worker/jobs/${lease.jobId}/${action}`;
    const queue: Queue = {
        async continuePublications() { if (options.claimMode !== 'visual')
            await call('/worker/publications/tick', {}); },
        async enqueue() {
            throw new AppError('FORBIDDEN', 'Исполнитель не создаёт задания.');
        },
        async claim(workerId) {
            if (workerId !== options.workerId)
                throw new AppError('FORBIDDEN', 'Чужое устройство.');
            const value = await call('/worker/jobs/claim', options.claimMode ? { mode: options.claimMode } : {});
            if (value === null)
                return null;
            const c = object(value, ['job', 'lease']), lease = leaseDto(c.lease);
            if (!validJob(c.job) || c.job.state !== 'running' || lease.workerId !== workerId || lease.jobId !== c.job.id)
                throw new AppError('INVALID_INPUT', 'Некорректная выдача задания.');
            if (options.claimMode === 'visual' && !c.job.edit?.producer)
                throw new AppError('INVALID_INPUT', 'Выдано задание другого типа.');
            uuid(c.job.id);
            uuid(c.job.siteId);
            return { job: c.job, lease };
        },
        async heartbeat(lease) {
            const fresh = leaseDto(await call(endpoint(lease, 'heartbeat'), { lease }));
            if (fresh.jobId !== lease.jobId || fresh.workerId !== options.workerId || fresh.generation !== lease.generation)
                throw new AppError('STALE_LEASE', 'Сменился владелец.');
            return fresh;
        },
        async checkpoint(lease, checkpoint, expectedCheckpointId) {
            await call(endpoint(lease, 'checkpoint'), { lease, checkpointId: checkpoint.id, expectedCheckpointId: expectedCheckpointId ?? null });
        },
        async finish(lease, state) {
            await call(endpoint(lease, 'finish'), { lease, state });
        },
        async shouldPause(lease) {
            const value = object(await call(endpoint(lease, 'pause-status'), { lease }), ['paused']);
            if (typeof value.paused !== 'boolean')
                throw new AppError('INVALID_INPUT', 'Некорректная пауза.');
            return value.paused;
        },
        async pauseAtBoundary(lease) {
            const value = object(await call(endpoint(lease, 'pause-boundary'), { lease }), ['paused']);
            if (typeof value.paused !== 'boolean')
                throw new AppError('INVALID_INPUT', 'Некорректная пауза.');
            return value.paused;
        },
    };
    return { ...local, queue, async bind(job, lease) {
            let publicationState: Record<string, unknown> | undefined;
            const scoped = (action: string, params: Record<string, unknown> = {}, binary = false) => call(endpoint(lease, action), { lease, ...params }, binary);
            async function loadCheckpoint(id: string) {
                const s = object(await scoped('snapshot', { id }), ['checkpoint', 'files']), checkpoint = checkpointDto(s.checkpoint);
                if (checkpoint.jobId !== job.id || checkpoint.id !== id || !Array.isArray(s.files))
                    throw new AppError('INVALID_INPUT', 'Чужая контрольная точка.');
                const state = JSON.parse(Buffer.from(await scoped('resource', { id, kind: 'checkpoint', path: '@state' }, true)).toString());
                if (!state || typeof state !== 'object' || Array.isArray(state))
                    throw new AppError('INVALID_INPUT', 'Некорректное состояние.');
                const files: ArtifactFile[] = [];
                for (const raw of s.files) {
                    const f = object(raw, ['path', 'mediaType', 'size', 'sha256']), path = string(f.path, 240), bytes = await scoped('resource', { id, kind: 'checkpoint', path }, true);
                    if (bytes.length !== integer(f.size, 0, 2000000) || createHash('sha256').update(bytes).digest('hex') !== f.sha256)
                        throw new AppError('INVALID_INPUT', 'Снимок повреждён.');
                    files.push({ path, mediaType: string(f.mediaType, 100), bytes });
                }
                checkArtifacts(files);
                publicationState = state;
                return { checkpoint, state, files };
            }
            const bound: WorkerDeps = { ...local, queue,
                async readLogo(assetId, siteId) {
                    if (siteId !== job.siteId)
                        throw new AppError('FORBIDDEN', 'Чужой сайт.');
                    const bytes = await scoped('logo', { id: uuid(assetId) }, true);
                    return { path: 'assets/logo.png', mediaType: 'image/png', bytes };
                },
                sites: { ...local.sites, async get(id) {
                        if (id !== job.siteId)
                            throw new AppError('FORBIDDEN', 'Чужой сайт.');
                        return siteView({ ...await scoped('site'), job: null });
                    }, async compareAndSet() {
                        throw new AppError('FORBIDDEN', 'Публикацию завершает сервер.');
                    } },
                revisions: { async get(id) {
                        const r = object(await scoped('revision', { id }), ['id', 'siteId', 'parentId', 'manifestId', 'kind', 'createdAt']);
                        if (r.siteId !== job.siteId || !['draft', 'candidate', 'published'].includes(String(r.kind)))
                            throw new AppError('INVALID_INPUT', 'Чужая версия.');
                        return { id: uuid(r.id), siteId: uuid(r.siteId), parentId: r.parentId === null ? null : uuid(r.parentId), manifestId: uuid(r.manifestId), kind: r.kind as 'draft' | 'candidate' | 'published', createdAt: integer(r.createdAt) };
                    }, async put() {
                        throw new AppError('FORBIDDEN', 'Публикацию завершает сервер.');
                    } },
                artifacts: { async put(siteId, files, templateVersion) {
                        if (siteId !== job.siteId)
                            throw new AppError('FORBIDDEN', 'Чужой сайт.');
                        const uploaded = await uploadResources({ ...options, lease, purpose: 'artifact', expectedCheckpointId: job.checkpointId, files, templateVersion });
                        return manifestDto(await scoped('artifact', { id: uuid(uploaded.manifestId) }));
                    }, async read(id) {
                        const manifest = manifestDto(await scoped('artifact', { id }));
                        if (manifest.siteId !== job.siteId)
                            throw new AppError('FORBIDDEN', 'Чужой снимок.');
                        const files: ArtifactFile[] = [];
                        for (const f of manifest.files) {
                            const bytes = await scoped('resource', { id, kind: 'artifact', path: f.path }, true);
                            if (bytes.length !== f.size || createHash('sha256').update(bytes).digest('hex') !== f.sha256)
                                throw new AppError('INVALID_INPUT', 'Снимок повреждён.');
                            files.push({ path: f.path, mediaType: f.mediaType, bytes });
                        }
                        checkArtifacts(files);
                        return files;
                    } },
                templates: { ...local.templates, load: async (styleId, version) => { const result = object(await scoped('template', { styleId, version }), ['available', 'files']); if (result.available === false)
                        return local.templates.load(styleId, version); if (result.available !== true || !Array.isArray(result.files) || result.files.length > 100)
                        throw new AppError('INVALID_INPUT', 'Неверная опись версии шаблона.'); const files: ArtifactFile[] = []; for (const value of result.files) {
                        const f = object(value, ['path', 'size', 'sha256', 'sha1', 'mediaType']), path = string(f.path, 240), bytes = await scoped('template', { styleId, version, path }, true);
                        if (bytes.length !== integer(f.size, 0, 2000000) || createHash('sha256').update(bytes).digest('hex') !== f.sha256)
                            throw new AppError('INVALID_INPUT', 'Закреплённый шаблон повреждён.');
                        files.push({ path, bytes, mediaType: string(f.mediaType, 100) });
                    } checkArtifacts(files); return files; } },
                validate: async (files) => { const report = await (local.validate ?? validateSite)(files); for (const id of report.screenshotIds) {
                    if (!/^validation\/[a-f0-9-]{36}\.png$/.test(id) || !local.readValidationScreenshot)
                        throw new AppError('UNAVAILABLE', 'Чтение снимков проверки не подключено.');
                    const bytes = await local.readValidationScreenshot(id);
                    await uploadResources({ ...options, lease, purpose: 'validation', expectedCheckpointId: job.checkpointId, files: [{ path: id, mediaType: 'image/png', bytes }], templateVersion: 'validation-v1' });
                } return report; },
                checkpoints: { load: loadCheckpoint, async save(current, currentLease, state, files) {
                        const uploaded = await uploadResources({ ...options, lease: currentLease, purpose: 'checkpoint', expectedCheckpointId: current.checkpointId, files, templateVersion: String((state.selection as any)?.templateVersion ?? 'unknown'), stage: current.stage, state: { path: 'state.json', mediaType: 'application/json', bytes: Buffer.from(JSON.stringify(state)) } });
                        publicationState = state;
                        const s = object(await scoped('snapshot', { id: uuid(uploaded.checkpointId) }), ['checkpoint', 'files']);
                        return checkpointDto(s.checkpoint);
                    } },
                async prepare(current) {
                    const styles = await scoped('catalog');
                    if (!Array.isArray(styles))
                        throw new AppError('INVALID_INPUT', 'Некорректный каталог.');
                    const site = await bound.sites.get(job.siteId);
                    let seed = 2166136261;
                    for (const char of job.id)
                        seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
                    seed >>>= 0;
                    const available = styles.filter(s => s.enabled === true && (!site?.input.referenceId || s.id === site.input.referenceId || Array.isArray(s.referenceIds) && s.referenceIds.includes(site.input.referenceId)));
                    if (!available.length)
                        throw new AppError('NOT_FOUND', 'Нет доступного шаблона.');
                    const selected = available[seed % available.length];
                    return { ...current, generation: { seed, styleId: string(selected.id, 100), templateVersion: string(selected.version, 100) } };
                },
                publication: { async settlement() {
                        const raw = await scoped('publication-receipt');
                        if (raw === null)
                            return null;
                        const r = object(raw, ['jobId', 'siteId', 'checkpointId', 'requestKey', 'revisionId', 'manifestId', 'expectedRevision']);
                        return { jobId: uuid(r.jobId), siteId: uuid(r.siteId), checkpointId: uuid(r.checkpointId), requestKey: string(r.requestKey, 200), revisionId: uuid(r.revisionId), manifestId: uuid(r.manifestId), expectedRevision: integer(r.expectedRevision) };
                    }, async advance(requestKey) {
                        if (!publicationState || !job.checkpointId)
                            throw new AppError('CONFLICT', 'Нет сохранённого этапа публикации.');
                        const p = object(await scoped('publication', { binding: { requestKey, manifestId: publicationState.manifestId, revisionId: publicationState.revisionId, expectedRevision: job.baseRevision, checkpointId: job.checkpointId } }), ['id', 'state']);
                        uuid(p.id);
                        if (!['pending', 'uploading', 'creating', 'checking', 'promoting', 'reconciling', 'waiting_quota', 'awaiting_dns', 'published', 'needs_attention'].includes(String(p.state)))
                            throw new AppError('INVALID_INPUT', 'Некорректное состояние публикации.');
                        return p.state as import('../../../packages/contracts/src/model.js').PublicationState;
                    } },
            };
            return bound;
        } };
}
