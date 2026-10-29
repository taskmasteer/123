import {jobView} from '../../../packages/contracts/src/http.js';
import {sitePagePrefix,encodeCursor,filterBinding} from '../../../packages/core/src/site-pagination.js';
import {compareCompositions} from '../../../packages/core/src/composition.js';
import {registryProjection} from '../../../packages/contracts/src/registry.js';
import {localUsage,localHealth} from '../../../packages/adapters/src/local-monitoring.js';
import { browserLaunchOptions } from './browser-launch.js';
import type {NativePersistencePermit} from '../../../packages/adapters/src/native-persistence.js';
import { rm } from 'node:fs/promises';
import { LocalBatches } from '../../../packages/adapters/src/local-batches.js';
import { LocalImportResources } from '../../../packages/adapters/src/import-resources.js';
import { importMethods } from '../../../packages/contracts/src/import.js';
import { openLocalDatabase,openNativeLocalDatabase } from '../../../packages/adapters/src/local-database.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { AppError } from '../../../packages/contracts/src/model.js';
import type { Site } from '../../../packages/contracts/src/model.js';
import { record } from '../../../packages/contracts/src/inputs.js';
import { createLocalState, createLocalEditingStore } from '../../../packages/adapters/src/local-state.js';
import { createEditing } from '../../../packages/core/src/editing.js';
import { createLocalQueue } from '../../../packages/adapters/src/local-queue.js';
import { createLocalRevisions } from '../../../packages/adapters/src/local-revisions.js';
import { createLocalArtifacts } from '../../../packages/adapters/src/local-artifacts.js';
import { createLocalCatalog } from '../../../packages/adapters/src/local-catalog.js';
import { privateDirectory, readRegular, safeFile } from '../../../packages/adapters/src/safe-files.js';
import { FakeModel } from '../../../packages/adapters/src/fake-model.js';
import { createResponsesModel } from '../../../packages/adapters/src/openai/responses.js';
import { createImageGenerator } from '../../../packages/adapters/src/openai/images.js';
import { FakePublication } from '../../../packages/adapters/src/fake-publication.js';
import { createCheckpointStore } from './checkpoints.js';
import { runJob } from './pipeline.js';
import { createManagedRuntime } from './managed-runtime.js';
import type { WorkerDeps } from './pipeline.js';
import { parseDesktopRequest, parseModelConfiguration } from './desktop-protocol.js';
import { validateSite } from './validation/browser.js';
import { createHash } from 'node:crypto';
import { registerLocalPayload } from '../../../packages/adapters/src/retention-schema.js';
import { LocalRetention } from '../../../packages/adapters/src/local-retention.js';
import { retainedOutcomes } from '../../../packages/core/src/retention.js';
import { historyEntries, createSourceFiles } from '../../../packages/core/src/history.js';
import { NativeArchives } from './native-archives.js';
import { serveFiles } from './preview/server.js';
import type { Preview } from './preview/server.js';
import type { ElementPatch } from '../../../packages/contracts/src/visual.js';
import { projectSelection } from '../../../packages/core/src/visual/projection.js';
import { projectionResource } from '../../../packages/core/src/visual/resources.js';
import { createSelectionRuntime } from './preview/selection-runtime.js';
const principal = { userId: 'local-demo-admin', role: 'admin' } as const;
export async function createDesktopRuntime(root: string, sourceRoot: string, options: {
    baseRoot?: string;
    native?: boolean;
    nativePersistencePermit?:NativePersistencePermit;
    transport?: typeof fetch;
} = {}) {
    const clock = { now: Date.now };
    const database = options.native&&options.nativePersistencePermit?await openNativeLocalDatabase(root,options.nativePersistencePermit):await openLocalDatabase(root);
    const sites = await createLocalState(join(root, 'sites'), clock, database);
    const queue = await createLocalQueue(root, clock, database), artifacts = await createLocalArtifacts(join(root, 'artifacts'));
    const revisions = await createLocalRevisions(root, database), checkpoints = await createCheckpointStore(join(root, 'checkpoints'), clock);
    const catalog = await createLocalCatalog(sourceRoot, root), validationRoot = await privateDirectory(join(root, 'validation'));
    const batches = new LocalBatches(database,catalog), imports = new LocalImportResources(batches);
    const jobAborts=new Map<string,AbortController>();
    const abort = new AbortController(), active = new Set<Promise<void>>();
    const previews = new Set<{
        browser: Browser;
        server: Preview;
    }>();
    const workerId = randomUUID();
    let maintaining: Promise<void> | null = null;
    let pumping: Promise<void> | null = null, closed = false, snapshotting = false;
    let closing:Promise<void>|null=null;
    const activeRequests = new Set<Promise<void>>();
    let mode: 'demo' | 'live' | 'blocked' = options.native ? 'blocked' : 'demo', modelName: string | null = null, imageModel: string | null = null;
    let credentialsAbort = new AbortController(), configuring = false;
    let usage: {
        inputTokens: number;
        outputTokens: number;
        uncertainRequests?: number;
    } | undefined;
    let managedMode = false;
    const deps: WorkerDeps & {
        queue: typeof queue;
    } = { compareComposition:async(signature,job)=>{
            const rows=database.sql.prepare("select e.data from jobs self join batch_rows me on me.site_id=self.site_id join batch_rows r on r.batch_id=me.batch_id and r.row_number between me.row_number-16 and me.row_number+16 join jobs j on j.site_id=r.site_id and json_extract(j.data,'$.kind')='generate' join checkpoint_evidence e on e.id=json_extract(j.data,'$.checkpointId') where self.id=? and j.id<>self.id and j.batch_id=self.batch_id order by abs(r.row_number-me.row_number),r.row_number limit 16").all(job.id);
            return compareCompositions(signature,rows.map(r=>JSON.parse(String(r.data)).state.composition));
        },readValidationScreenshot: async (id) => {
            if (!/^validation\/[a-f0-9-]{36}\.png$/.test(id))
                throw new AppError('INVALID_INPUT', 'Неверный снимок проверки.');
            return readRegular(await safeFile(root, id), 8000000);
        }, readLogo: (assetId, siteId) => imports.readLogo(assetId, siteId), sites, queue, artifacts, revisions, checkpoints, clock, templates: catalog, model: new FakeModel(), publication: new FakePublication(),
        workspace: join(root, 'attempts'), validate: async (files, context) => {
            if (!context)
                throw new AppError('INVALID_INPUT', 'Нет привязки проверки к заданию.');
            const report = await validateSite(files, { screenshotRoot: validationRoot });
            for (const id of report.screenshotIds) {
                const bytes = await readRegular(await safeFile(root, id), 8000000), payload = { kind: 'screenshot' as const, id, siteId: context.job.siteId, producer: { jobId: context.job.id, workerId: context.lease.workerId, generation: context.lease.generation }, objects: [{ key: id.slice('validation/'.length), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'image/png' }], createdAt: clock.now(), protectUntil: clock.now() + 600000, state: 'available' as const, firstOrphanAt: null, claimToken: null };
                database.transaction(() => registerLocalPayload(database.sql, payload));
            }
            return report;
        } };
    const retention = new LocalRetention(database);
    if (!database.sql.prepare("select 1 from recovery_state where key='quarantine'").get())
        await retention.backfill(checkpoints, false);
    const editing = createEditing({ ...deps, canRollback: async (siteId, revisionId) => { const site = await sites.get(siteId); return !!site && retainedOutcomes(database.sql.prepare('select data from publication_outcomes where site_id=?').all(siteId).map(r => JSON.parse(String(r.data))), site.publishedId).some(o => o.settlement === 'settled' && o.revisionId === revisionId); }, visualCompareAndSet: async (actorId, siteId, expectedRevision, draftId) => {
            if (actorId !== principal.userId)
                throw new AppError('FORBIDDEN', 'Доступ отозван.');
            return sites.compareAndSet(siteId, expectedRevision, { draftId });
        }, store: await createLocalEditingStore(root, database), ids: { next: randomUUID } });
    const selectionRuntime = createSelectionRuntime();
    const managedValidationRoot = await privateDirectory(join(root, '.managed-validation'));
    const managedRuntime = createManagedRuntime(() => ({ ...deps, validate: files => validateSite(files, { screenshotRoot: managedValidationRoot }), readValidationScreenshot: async (id) => {
            if (!/^validation\/[a-f0-9-]{36}\.png$/.test(id))
                throw new AppError('INVALID_INPUT', 'Неверный снимок проверки.');
            const file = await safeFile(managedValidationRoot, id.slice(11)), bytes = await readRegular(file, 8000000);
            await rm(file, { force: true });
            return bytes;
        } }), () => mode === 'live' && !configuring && !closed, options.transport);
    function admitted() { return !closed && !snapshotting && !configuring && !managedMode && !database.sql.prepare("select 1 from recovery_state where key='quarantine'").get(); }
    function ready() { return admitted() && mode !== 'blocked'; }
    async function updateUsage(jobId: string) {
        const job = await queue.get(jobId);
        if (!job?.checkpointId)
            return;
        const projected = database.sql.prepare('select data from job_usage where job_id=?').get(job.id);
        if (projected) {
            const value = JSON.parse(String(projected.data));
            usage = { inputTokens: value.inputTokens, outputTokens: value.outputTokens, ...(value.uncertainRequests ? { uncertainRequests: value.uncertainRequests } : {}) };
            return;
        }
        const { state } = await checkpoints.load(job.checkpointId);
        const records = [...(Array.isArray(state.transcript) ? state.transcript : []), state.continuation].filter(record);
        if (records.length)
            usage = records.reduce<{
                inputTokens: number;
                outputTokens: number;
                uncertainRequests: number;
            }>((total, item) => ({ inputTokens: total.inputTokens + (Number.isSafeInteger(item.inputTokens) ? Number(item.inputTokens) : 0), outputTokens: total.outputTokens + (Number.isSafeInteger(item.outputTokens) ? Number(item.outputTokens) : 0), uncertainRequests: total.uncertainRequests + (Number.isSafeInteger(item.uncertainRequests) ? Number(item.uncertainRequests) : 0) }), { inputTokens: 0, outputTokens: 0, uncertainRequests: 0 });
        if (usage?.uncertainRequests === 0)
            delete usage.uncertainRequests;
    }
    async function allSites() {
        const items: Site[] = [];
        let cursor: string | undefined;
        do {
            const page = await sites.list(principal, cursor, 100);
            items.push(...page.items);
            cursor = page.nextCursor ?? undefined;
        } while (cursor);
        return items;
    }
    async function ensureJob(site: Site) {
        let job = await queue.get(site.id);
        if (!job && !site.publishedId) {
            job = { id: site.id, siteId: site.id, kind: 'generate', stage: 'brief', state: 'queued', checkpointId: null, baseRevision: site.revision };
            await queue.enqueue(job);
        }
        return job;
    }
    function pump(): Promise<void> {
        if (!admitted() || (!ready() && !database.sql.prepare("select 1 from jobs where json_extract(data,'$.edit.producer.kind')='visual' and json_extract(data,'$.state')='queued' limit 1").get()))
            return Promise.resolve();
        if (pumping)
            return pumping;
        pumping = (async () => {
            const pending = database.sql.prepare("select b.id from batches b where state='active' and exists(select 1 from batch_rows r where r.batch_id=b.id and site_id is null and json_array_length(json_extract(r.data,'$.issues'))=0) order by rowid limit 1").get();
            if (pending && admitted() && mode !== 'blocked')
                await batches.admit(principal, String(pending.id), 25).catch(error => console.error('Batch admission failed:', String(error)));
            while (admitted() && active.size < 2) {
                const claimed = await queue.claim(workerId, mode === 'blocked' ? 'visual' : 'all');
                if (!claimed)
                    break;
                // Closing can race an in-flight claim. Release it before closing persistence.
                if (!admitted() || (!ready() && !claimed.job.edit?.producer)) {
                    await queue.finish(claimed.lease, 'paused');
                    break;
                }
                const jobAbort=new AbortController();jobAborts.set(claimed.job.id,jobAbort);
                const work = runJob(claimed.job, claimed.lease, { ...deps, sites: { ...sites, compareAndSet: (id, expected, patch) => sites.workerCompareAndSet(id, expected, patch, claimed.lease) } }, AbortSignal.any([abort.signal, credentialsAbort.signal,jobAbort.signal]))
                    .then(async () => { await editing.recover(claimed.job.siteId); await updateUsage(claimed.job.id); })
                    .catch(async error => {if(error instanceof AppError&&error.code==='STALE_LEASE'&&(await queue.get(claimed.job.id))?.state==='cancelled')return;console.error('Worker job failed:',String(error));})
                    .finally(() => {jobAborts.delete(claimed.job.id);active.delete(work);});
                active.add(work);
            }
        })().finally(() => { pumping = null; });
        return pumping;
    }
    for (const site of database.sql.prepare("select 1 from recovery_state where key='quarantine'").get() ? [] : await allSites()) {
        await ensureJob(site);
        await editing.recover(site.id);
        const job = await queue.current(site.id);
        if (job)
            await updateUsage(job.id);
        if (job?.state === 'paused')
            await queue.retry(job.id).catch(error => {
                if (!(error instanceof AppError && error.code === 'CONFLICT'))
                    throw error;
            });
    }
    const timer = setInterval(() => { void pump().catch(error => console.error('Worker scheduler:', String(error))); }, 250);
    await pump();
    async function scoped(siteId: string, revisionId: string, candidateId?: string) {
        const site = await sites.get(siteId);
        if (!site)
            throw new AppError('NOT_FOUND', 'Сайт не найден.');
        const selected = candidateId ? (await editing.list(principal, siteId)).candidates.find(c => c.id === candidateId) : null;
        if (candidateId && (!selected || !['ready', 'accepted', 'conflict'].includes(selected.status) ||
            ![selected.id, selected.parentRevisionId, selected.baseDraftId].includes(revisionId)))
            throw new AppError('FORBIDDEN', 'Снимок не относится к выбранному варианту.');
        const checked = await editing.screenshotEvidence(principal, siteId, revisionId, candidateId);
        if (checked)
            return { site, revision: checked.revision, validation: checked.validation };
        const comparisonBase = selected && ['ready', 'accepted', 'conflict'].includes(selected.status) &&
            (selected.parentRevisionId === revisionId || selected.baseDraftId === revisionId);
        if (revisionId !== site.publishedId && revisionId !== site.draftId && !comparisonBase)
            throw new AppError('FORBIDDEN', 'Версия недоступна для этого сайта.');
        const revision = await revisions.get(revisionId);
        if (!revision || revision.siteId !== site.id)
            throw new AppError('NOT_FOUND', 'Версия не найдена.');
        const job = await queue.get(site.id);
        if (!job?.checkpointId)
            throw new AppError('NOT_FOUND', 'Проверка версии не найдена.');
        const saved = await (checkpoints.evidence?.(job.checkpointId) ?? checkpoints.load(job.checkpointId));
        if (saved.checkpoint.jobId !== job.id || saved.state.siteId !== site.id || saved.state.revisionId !== revision.id || saved.state.manifestId !== revision.manifestId ||
            !record(saved.state.validation) || saved.state.validation.ok !== true || !Array.isArray(saved.state.validation.screenshotIds))
            throw new AppError('NOT_FOUND', 'Снимок этой версии недоступен.');
        return { site, revision, validation: saved.state.validation };
    }
    async function quiesce<T>(capture: () => Promise<T>): Promise<T> {
        if (snapshotting || closed)
            throw new AppError('CONFLICT', 'Снимок уже создаётся.');
        snapshotting = true;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([(async () => { await pumping; await maintaining; while (activeRequests.size || active.size)
                    await Promise.allSettled([...activeRequests, ...active]); })(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new AppError('CONFLICT', 'Текущая операция ещё не достигла безопасной границы.')), 60000); })]);
            return await capture();
        }
        finally {
            if (timeout)
                clearTimeout(timeout);
            snapshotting = false;
            if (!closed)
                void pump();
        }
    }
    let closeForRestore: () => Promise<void> = async () => { throw new AppError('CONFLICT', 'Исполнитель ещё запускается.'); };
    const archives = new NativeArchives({ native: !!options.native, root, baseRoot: options.baseRoot ?? root, sourceRoot, database, sites, revisions, artifacts, quiesce, close: () => closeForRestore(), ...(options.transport ? { fetch: options.transport } : {}) });
    const source = createSourceFiles({ admin: async (actor) => {
            if (actor.role !== 'admin')
                throw new AppError('FORBIDDEN', 'Исходники доступны администратору.');
        }, revision: async (s, r) => { const revision = await revisions.get(r); return revision?.siteId === s ? revision : null; }, read: id => artifacts.read(id) });
    const maintenance = setInterval(() => {
        if (!closed && !snapshotting && !maintaining && !database.sql.prepare("select 1 from recovery_state where key='quarantine'").get())
            maintaining = retention.backfill(checkpoints, false).then(() => retention.collect(clock.now())).catch(() => { }).finally(() => { maintaining = null; });
    }, 3600000);
    const runtime = {
        archive: (value: unknown) => archives.request(value),
        async managed(method: string, params: unknown) {
            if (snapshotting)
                throw new AppError('CONFLICT', 'Создаётся согласованный снимок.');
            if (!options.native)
                throw new AppError('FORBIDDEN', 'Требуется нативный канал.');
            if (method === 'managed.start') {
                if (active.size || pumping)
                    throw new AppError('CONFLICT', 'Дождитесь завершения локальных заданий.');
                const result = await managedRuntime.request(method, params);
                managedMode = true;
                return result;
            }
            const result = await managedRuntime.request(method, params);
            if (method === 'managed.stop' || method === 'managed.revoke')
                managedMode = false;
            return result;
        },
        async configure(value: unknown) {
            if (snapshotting)
                throw new AppError('CONFLICT', 'Создаётся согласованный снимок.');
            await managedRuntime.stop();
            const config = parseModelConfiguration(value);
            configuring = true;
            credentialsAbort.abort();
            await pumping;
            await maintaining;
            await Promise.allSettled([...active]);
            await Promise.allSettled([...activeRequests]);
            await selectionRuntime.close();
            mode = 'blocked';
            modelName = null;
            imageModel = null;
            delete deps.images;
            try {
                if (config.mode === 'live') {
                    deps.model = createResponsesModel(config, options.transport);
                    modelName = config.model;
                    imageModel = config.imageModel ?? null;
                    deps.images = (description, seed, signal, hooks) => createImageGenerator(config, options.transport, hooks, signal).generateImage(description, seed);
                }
                else if (config.mode === 'demo')
                    deps.model = new FakeModel();
                mode = config.mode;
                credentialsAbort = new AbortController();
                if (mode !== 'blocked' && !database.sql.prepare("select 1 from recovery_state where key='quarantine'").get())
                    for (const site of await allSites()) {
                        const job = await queue.current(site.id);
                        if (job?.state === 'paused')
                            await queue.retry(job.id).catch(error => {
                                if (!(error instanceof AppError && error.code === 'CONFLICT'))
                                    throw error;
                            });
                    }
            }
            finally {
                configuring = false;
            }
            void pump();
            return { mode, model: modelName, images: imageModel ? 'enabled' : 'disabled' };
        },
        async request(value: unknown): Promise<unknown> {
            if (snapshotting)
                throw new AppError('CONFLICT', 'Создаётся согласованный снимок.');
            let done!: () => void;
            const ended = new Promise<void>(resolve => done = resolve);
            activeRequests.add(ended);
            try {
                return await (async () => {
                    if (closed)
                        throw new AppError('CONFLICT', 'Исполнитель остановлен.');
                    const request = parseDesktopRequest(value), p = request.params;
                    if (database.sql.prepare("select 1 from recovery_state where key='quarantine'").get() && !['device.status', 'site.list', 'job.status', 'catalog.list', 'site.history', 'source.list', 'source.read', 'recovery.status', 'recovery.release'].includes(request.method))
                        throw new AppError('CONFLICT', 'Восстановленная установка ожидает проверки и явного разрешения работы.');
                    if ((mode === 'blocked' || configuring) && ['site.create', 'edit.request', 'job.retry', 'import.commit'].includes(request.method))
                        throw new AppError('NEEDS_ATTENTION', 'Настройте модель или включите демонстрационный режим.');
                    if (Object.hasOwn(importMethods, request.method)) {
                        if (request.method === 'batch.retry') {
                            batches.read(principal, String(p.id), true);
                            const row = database.sql.prepare('select site_id from batch_rows where batch_id=? and row_number=?').get(String(p.id), Number(p.rowNumber));
                            const job = row?.site_id ? await queue.get(String(row.site_id)) : null;
                            if (!job || job.kind !== 'generate')
                                throw new AppError('NOT_FOUND', 'Задание строки не найдено.');
                            let recovery: typeof job.providerRecovery;
                            if (job.state === 'needs_attention' && job.checkpointId && deps.model.identity && deps.model.recover) {
                                const saved = await checkpoints.load(job.checkpointId);
                                if (saved.checkpoint.jobId === job.id && saved.state.siteId === job.siteId && ['brief','generate', 'validate'].includes(saved.checkpoint.stage) && (!record(saved.state.imageRun) || saved.state.imageRun.status !== 'pending') && deps.model.canRecover?.(saved.checkpoint.stage==='brief'?saved.state.planningContinuation:saved.state.continuation, typeof saved.state.error === 'string' ? saved.state.error : undefined))
                                    recovery = { id: randomUUID(), checkpointId: job.checkpointId, modelIdentity: deps.model.identity };
                            }
                            if (job.state === 'needs_attention' && deps.model.identity && !recovery)
                                throw new AppError('CONFLICT', 'Ошибка не допускает восстановления учётных данных.');
                            await queue.retry(job.id, recovery);
                            void pump();
                            return { ok: true };
                        }
                        if (request.method === 'batch.assign') {
                            await batches.assign(principal, String(p.id), p.userIds);
                            return { ok: true };
                        }
                        if (request.method === 'batch.get')
                            return batches.get(principal, String(p.id));
                        if (request.method === 'batch.rows')
                            return batches.page(principal, String(p.id), p.cursor as string | undefined, p.status as string | undefined);
                        if (request.method === 'batch.list') {
                            const rows = database.sql.prepare("select id from batches where state<>'uploading' and (? is null or id>?) order by id limit 51").all(p.cursor as string ?? null, p.cursor as string ?? null);
                            return { items: await Promise.all(rows.slice(0, 50).map(r => batches.get(principal, String(r.id)))), nextCursor: rows.length > 50 ? String(rows[49]!.id) : null };
                        }
                        if (['batch.pause', 'batch.resume', 'batch.cancel'].includes(request.method)) {
                            await (request.method === 'batch.pause' ? batches.pauseBatch(principal, String(p.id)) : request.method === 'batch.resume' ? batches.resumeBatch(principal, String(p.id)) : batches.cancelBatch(principal, String(p.id)));
                            void pump();
                            return { ok: true };
                        }
                        const result = await imports.request(principal, request.method, p);
                        if (request.method === 'import.commit')
                            void pump();
                        return result;
                    }
                    switch (request.method) {
                        case 'recovery.status': return { quarantined: !!database.sql.prepare("select 1 from recovery_state where key='quarantine'").get() };
                        case 'recovery.release':
                            database.transaction(() => database.sql.prepare("delete from recovery_state where key='quarantine'").run());
                            return { ok: true };
                        case 'site.history': {
                            const site = await sites.get(String(p.siteId));
                            if (!site)
                                throw new AppError('NOT_FOUND', 'Сайт не найден.');
                            const entries = historyEntries(database.sql.prepare('select data from publication_outcomes where site_id=?').all(site.id).map(r => JSON.parse(String(r.data))), site.publishedId, id => !['claimed', 'deleted'].includes(String(database.sql.prepare("select state from payload_inventory where kind='artifact' and id=?").get(id)?.state))), offset = Number(p.offset ?? 0);
                            return { items: entries.slice(offset, offset + 20), nextOffset: entries.length > offset + 20 ? offset + 20 : null };
                        }
                        case 'site.rollback': {
                            const result = await editing.rollback(principal, String(p.siteId), String(p.revisionId), Number(p.expectedRevision));
                            await retention.planCleanup(clock.now());
                            return result;
                        }
                        case 'source.list': return { files: await source.listSourceFiles(principal, String(p.siteId), String(p.revisionId)) };
                        case 'source.read': {
                            const file = await source.readSourceFile(principal, String(p.siteId), String(p.revisionId), String(p.path)), offset = Number(p.offset ?? 0);
                            if (offset > file.bytes.length)
                                throw new AppError('INVALID_INPUT', 'Неверное смещение.');
                            const bytes = file.bytes.slice(offset, offset + 24000);
                            return { path: file.path, mediaType: file.mediaType, size: file.bytes.length, offset, base64: Buffer.from(bytes).toString('base64'), nextOffset: offset + bytes.length < file.bytes.length ? offset + bytes.length : null };
                        }
                        case 'visual.projection':
                        case 'visual.projection.chunk': {
                            const { map, files } = await editing.visualMap(principal, String(p.siteId), Number(p.expectedRevision));
                            const resource = projectionResource(projectSelection(files, map));
                            if (request.method === 'visual.projection')
                                return resource.descriptor;
                            if (p.mapId !== map.binding.mapId)
                                throw new AppError('CONFLICT', 'Проекция устарела.');
                            return resource.chunk(Number(p.index));
                        }
                        case 'visual.submit': {
                            const job = await editing.requestVisual(principal, String(p.siteId), Number(p.expectedRevision), p.patch as ElementPatch, String(p.mapId), String(p.requestKey));
                            void pump();
                            return { saveId: job.edit!.candidateId, status: 'queued' };
                        }
                        case 'visual.status': return editing.visualStatus(principal, String(p.siteId), String(p.saveId));
                        case 'visual.selection.begin':
                        case 'visual.selection.chunk':
                        case 'visual.selection.open':
                        case 'visual.selection.status':
                        case 'visual.selection.close': return selectionRuntime.request(request.method, p);
                        case 'usage.summary':return localUsage(database);
                        case 'site.usage':if(!await sites.get(String(p.siteId)))throw new AppError('NOT_FOUND','Сайт не найден.');return localUsage(database,String(p.siteId));
                        case 'site.health':if(!await sites.get(String(p.siteId)))throw new AppError('NOT_FOUND','Сайт не найден.');return localHealth(database,String(p.siteId));
                        case 'device.status': return { mode, available: mode !== 'blocked' && !configuring, activeJobs: active.size, maxJobs: 2, model: modelName, imageModel, images: imageModel ? 'enabled' : 'disabled', storage: 'local', publication: 'demo', ...(usage ? { usage } : {}) };
                        case 'site.list': {
                            const page = await sites.list(principal, p.cursor as string | undefined, Number(p.limit ?? 50), { ...(p.domain ? { domain: String(p.domain) } : {}), ...(p.status ? { status: String(p.status) } : {}), ...(p.batchId ? { batchId: String(p.batchId) } : {}) }), items = page.items;
                            const all=await Promise.all(items.map(async(site)=>{const job=await queue.current(site.id),e=job?.checkpointId?database.sql.prepare('select data from checkpoint_evidence where id=?').get(job.checkpointId):null,operation=database.sql.prepare('select kind from operations where site_id=?').get(site.id);return {...site,job:job?jobView(job):null,operation:operation?.kind??null,registry:registryProjection(site,job,e?JSON.parse(String(e.data)).state:undefined)};})),prefix=sitePagePrefix(all,s=>s,100);
                            const filters={...(p.domain?{domain:String(p.domain)}:{}),...(p.status?{status:String(p.status)}:{}),...(p.batchId?{batchId:String(p.batchId)}:{})},last=prefix.at(-1),seq=last?database.sql.prepare('select seq from sites where id=?').get(last.id)?.seq:undefined;
                            return {items:prefix,nextCursor:prefix.length<all.length&&seq?encodeCursor(String(seq),filterBinding(principal,filters)):page.nextCursor};
                        }
                        case 'site.create': {
                            if (p.referenceId)
                                await catalog.prepare({ id: randomUUID(), siteId: randomUUID(), kind: 'generate', stage: 'brief', state: 'queued', checkpointId: null, baseRevision: 0 }, 0, 0, p.referenceId as string);
                            const site = await sites.create(p as unknown as Site['input'], principal);
                            const job = await ensureJob(site);
                            void pump();
                            return { site, job };
                        }
                        case 'job.status': {
                            const site = await sites.get(p.siteId as string);
                            if (!site)
                                throw new AppError('NOT_FOUND', 'Сайт не найден.');
                            const job = await queue.current(site.id);
                            if (!job)
                                throw new AppError('NOT_FOUND', 'Задание не найдено.');
                            return job;
                        }
                        case 'job.cancel': {
                            const job=await queue.current(String(p.siteId));if(!job)throw new AppError('NOT_FOUND','Задание не найдено.');
                            if(job.state==='completed')throw new AppError('CONFLICT','Задание уже завершено.');
                            await queue.cancel(job.id);jobAborts.get(job.id)?.abort();await editing.recover(job.siteId);return {ok:true};
                        }
                        case 'job.retry': {
                            const job = await queue.current(p.siteId as string);
                            if (!job)
                                throw new AppError('NOT_FOUND', 'Задание не найдено.');
                            if (job.kind === 'edit' && job.state === 'needs_attention')
                                throw new AppError('CONFLICT', 'Отклоните неудачный вариант и отправьте новую правку.');
                            let recovery: typeof job.providerRecovery;
                            if (job.kind === 'generate' && job.state === 'needs_attention' && job.checkpointId && deps.model.identity && deps.model.recover) {
                                const saved = await checkpoints.load(job.checkpointId);
                                if (saved.checkpoint.jobId === job.id && saved.state.jobId === job.id && saved.state.siteId === job.siteId && saved.state.baseRevision === job.baseRevision &&
                                    ['brief','generate', 'validate'].includes(saved.checkpoint.stage) && (!record(saved.state.imageRun) || saved.state.imageRun.status !== 'pending') &&
                                    deps.model.canRecover?.(saved.checkpoint.stage==='brief'?saved.state.planningContinuation:saved.state.continuation, typeof saved.state.error === 'string' ? saved.state.error : undefined))
                                    recovery = { id: randomUUID(), checkpointId: job.checkpointId, modelIdentity: deps.model.identity };
                            }
                            await queue.retry(job.id, recovery);
                            void pump();
                            return { ok: true };
                        }
                        case 'edit.request': {
                            const job = await editing.requestEdit(principal, p.siteId as string, p.instruction as string, p.expectedRevision as number, p.candidateId as string | undefined);
                            void pump();
                            return job;
                        }
                        case 'edit.accept': return editing.acceptCandidate(principal, p.siteId as string, p.candidateId as string, p.expectedRevision as number);
                        case 'edit.reject':
                            await editing.rejectCandidate(principal, p.siteId as string, p.candidateId as string);
                            return { ok: true };
                        case 'edit.list': return editing.list(principal, p.siteId as string);
                        case 'chat.list': return editing.getConversation(principal, p.siteId as string);
                        case 'site.publish': return editing.publish(principal, p.siteId as string, p.expectedRevision as number);
                        case 'catalog.list': return catalog.list();
                        case 'catalog.style.update':
                            await catalog.updateStyle(principal, p.id as string, p.enabled as boolean);
                            return { ok: true };
                        case 'catalog.reference.update':
                            await catalog.updateReference(principal, p.id as string, p.description as string);
                            return { ok: true };
                        case 'preview.screenshot': {
                            const { validation } = await scoped(p.siteId as string, p.revisionId as string, p.candidateId as string | undefined);
                            const ids = validation.screenshotIds as string[], id = ids[p.width === 375 ? 0 : ids.length / 2];
                            if (typeof id !== 'string' || !/^validation\/[0-9a-f-]{36}\.png$/.test(id))
                                throw new AppError('NOT_FOUND', 'Снимок недоступен.');
                            const bytes = await readRegular(await safeFile(validationRoot, id.slice('validation/'.length)), 6000000);
                            return { dataUrl: 'data:image/png;base64,' + Buffer.from(bytes).toString('base64'), width: p.width };
                        }
                        case 'preview.open': {
                            const { revision } = await scoped(p.siteId as string, p.revisionId as string), server = await serveFiles(await artifacts.read(revision.manifestId));
                            let browser: Browser;
                            try {
                                browser = await chromium.launch(browserLaunchOptions(false));
                            }
                            catch (error) {
                                await server.close();
                                throw error;
                            }
                            const entry = { browser, server };
                            previews.add(entry);
                            browser.on('disconnected', () => { previews.delete(entry); void server.close(); });
                            const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, permissions: [] }), origin = new URL(server.url).origin;
                            await context.route('**/*', route => new URL(route.request().url()).origin === origin && ['GET', 'HEAD'].includes(route.request().method()) ? route.continue() : route.abort());
                            await context.routeWebSocket('**/*', socket => socket.close());
                            await context.addInitScript(() => {
                                for (const key of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
                                    Object.defineProperty(window, key, { value: undefined, writable: false, configurable: false });
                                }
                            });
                            let first = true;
                            context.on('page', page => {
                                if (!first)
                                    void page.close();
                                first = false;
                                page.on('download', download => void download.cancel());
                            });
                            const page = await context.newPage();
                            await page.goto(server.url);
                            return { opened: true };
                        }
                        default: throw new AppError('INVALID_INPUT', 'Неизвестная команда.');
                    }
                })();
            }
            finally {
                activeRequests.delete(ended);
                done();
            }
        },
        close():Promise<void> {
            if (closing)return closing;
            closed = true;
            closing=(async()=>{
            await managedRuntime.stop();
            clearInterval(timer);
            clearInterval(maintenance);
            abort.abort();
            await pumping;
            await maintaining;
            await archives.shutdown();
            await Promise.allSettled([...active]);
            await Promise.allSettled([...activeRequests]);
            await Promise.allSettled([...previews].map(async (preview) => {
                await preview.browser.close();
                await preview.server.close();
            }));
            await queue.close();
            await sites.close();
            await selectionRuntime.close();
            await database.close();
            })();return closing;
        }
    };
    closeForRestore = () => runtime.close();
    return runtime;
}
