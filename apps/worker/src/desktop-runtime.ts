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
import type { WorkerDeps } from './pipeline.js';
import { parseDesktopRequest, parseModelConfiguration } from './desktop-protocol.js';
import { validateSite } from './validation/browser.js';
import { serveFiles } from './preview/server.js';
import type { Preview } from './preview/server.js';
const principal = { userId: 'local-demo-admin', role: 'admin' } as const;
export async function createDesktopRuntime(root: string, sourceRoot: string, options: {native?:boolean;transport?:typeof fetch}={}) {
    const clock = { now: Date.now };
    const sites = await createLocalState(join(root, 'sites'), clock);
    const queue = await createLocalQueue(root, clock), artifacts = await createLocalArtifacts(join(root, 'artifacts'));
    const revisions = await createLocalRevisions(root), checkpoints = await createCheckpointStore(join(root, 'checkpoints'), clock);
    const catalog = await createLocalCatalog(sourceRoot, root), validationRoot = await privateDirectory(join(root, 'validation'));
    const abort = new AbortController(), active = new Set<Promise<void>>();
    const previews = new Set<{
        browser: Browser;
        server: Preview;
    }>();
    const workerId = randomUUID();
    let pumping: Promise<void> | null = null, closed = false;
    let mode:'demo'|'live'|'blocked'=options.native?'blocked':'demo', modelName:string|null=null,imageModel:string|null=null;
    let credentialsAbort=new AbortController(),configuring=false;
    let usage:{inputTokens:number;outputTokens:number}|undefined;
    const deps:WorkerDeps & {queue:typeof queue} = { sites, queue, artifacts, revisions, checkpoints, clock, templates: catalog, model: new FakeModel(), publication: new FakePublication(),
        workspace: join(root, 'attempts'), validate: (files: Parameters<typeof validateSite>[0]) => validateSite(files, { screenshotRoot: validationRoot }) };
    const editing = createEditing({ ...deps, store: await createLocalEditingStore(root), ids: { next: randomUUID } });
    function ready(){return !closed&&!configuring&&mode!=='blocked';}
    async function updateUsage(jobId:string){
        const job=await queue.get(jobId);if(!job?.checkpointId)return;
        const {state}=await checkpoints.load(job.checkpointId);
        const records=[...(Array.isArray(state.transcript)?state.transcript:[]),state.continuation].filter(record);
        if(records.length)usage=records.reduce<{inputTokens:number;outputTokens:number}>((total,item)=>({inputTokens:total.inputTokens+(Number.isSafeInteger(item.inputTokens)?Number(item.inputTokens):0),outputTokens:total.outputTokens+(Number.isSafeInteger(item.outputTokens)?Number(item.outputTokens):0)}),{inputTokens:0,outputTokens:0});
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
        if (!ready())
            return Promise.resolve();
        if (pumping)
            return pumping;
        pumping = (async () => {
            while (ready() && active.size < 2) {
                const claimed = await queue.claim(workerId);
                if (!claimed)
                    break;
                // Closing can race an in-flight claim. Release it before closing persistence.
                if (!ready()) {
                    await queue.finish(claimed.lease, 'paused');
                    break;
                }
                const work = runJob(claimed.job, claimed.lease, deps, AbortSignal.any([abort.signal,credentialsAbort.signal]))
                    .then(async() => {await editing.recover(claimed.job.siteId);await updateUsage(claimed.job.id);})
                    .catch(error => console.error('Worker job failed:', String(error)))
                    .finally(() => active.delete(work));
                active.add(work);
            }
        })().finally(() => { pumping = null; });
        return pumping;
    }
    for (const site of await allSites()) {
        await ensureJob(site);
        await editing.recover(site.id);
        const job = await queue.current(site.id);
        if(job)await updateUsage(job.id);
        if (job?.state === 'paused')
            await queue.retry(job.id);
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
        if (checked) return { site, revision: checked.revision, validation: checked.validation };
        const comparisonBase = selected && ['ready', 'accepted', 'conflict'].includes(selected.status) &&
            (selected.parentRevisionId === revisionId || selected.baseDraftId === revisionId);
        if (revisionId !== site.publishedId && revisionId !== site.draftId && !comparisonBase)
            throw new AppError('FORBIDDEN', 'Версия недоступна для этого сайта.');
        const revision = await revisions.get(revisionId);
        if (!revision || revision.siteId !== site.id)
            throw new AppError('NOT_FOUND', 'Версия не найдена.');
        const job = await queue.get(site.id);
        if (!job?.checkpointId) throw new AppError('NOT_FOUND', 'Проверка версии не найдена.');
        const saved = await checkpoints.load(job.checkpointId);
        if (saved.checkpoint.jobId !== job.id || saved.state.siteId !== site.id || saved.state.revisionId !== revision.id || saved.state.manifestId !== revision.manifestId ||
            !record(saved.state.validation) || saved.state.validation.ok !== true || !Array.isArray(saved.state.validation.screenshotIds))
            throw new AppError('NOT_FOUND', 'Снимок этой версии недоступен.');
        return { site, revision, validation: saved.state.validation };
    }
    return {
        async configure(value:unknown) {
            const config=parseModelConfiguration(value);
            configuring=true;credentialsAbort.abort();
            await pumping;await Promise.allSettled([...active]);
            mode='blocked';modelName=null;imageModel=null;delete deps.images;
            try {
                if(config.mode==='live') {
                    deps.model=createResponsesModel(config,options.transport);modelName=config.model;imageModel=config.imageModel??null;
                    deps.images=(description,seed,signal,hooks)=>createImageGenerator(config,options.transport,hooks,signal).generateImage(description,seed);
                }else if(config.mode==='demo')deps.model=new FakeModel();
                mode=config.mode;credentialsAbort=new AbortController();
                if(mode!=='blocked')for(const site of await allSites()){const job=await queue.current(site.id);if(job?.state==='paused')await queue.retry(job.id);}
            }finally{configuring=false;}
            void pump();return {mode,model:modelName,images:imageModel?'enabled':'disabled'};
        },
        async request(value: unknown): Promise<unknown> {
            if (closed)
                throw new AppError('CONFLICT', 'Исполнитель остановлен.');
            const request = parseDesktopRequest(value), p = request.params;
            if((mode==='blocked'||configuring)&&['site.create','edit.request','job.retry'].includes(request.method))throw new AppError('NEEDS_ATTENTION','Настройте модель или включите демонстрационный режим.');
            switch (request.method) {
                case 'device.status': return { mode, available:mode!=='blocked'&&!configuring, activeJobs: active.size, maxJobs: 2,model:modelName,imageModel,images:imageModel?'enabled':'disabled',storage:'local',publication:'demo',...(usage?{usage}:{}) };
                case 'site.list': {
                    const items = await allSites();
                    return { items: await Promise.all(items.map(async (site) => ({ ...site, job: await queue.current(site.id) }))), nextCursor: null };
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
                case 'job.retry': {
                    const job = await queue.current(p.siteId as string);
                    if (!job) throw new AppError('NOT_FOUND', 'Задание не найдено.');
                    if (job.kind === 'edit' && job.state === 'needs_attention') throw new AppError('CONFLICT', 'Отклоните неудачный вариант и отправьте новую правку.');
                    await queue.retry(job.id);
                    void pump();
                    return { ok: true };
                }
                case 'edit.request': {
                    const job = await editing.requestEdit(principal, p.siteId as string, p.instruction as string, p.expectedRevision as number, p.candidateId as string | undefined);
                    void pump(); return job;
                }
                case 'edit.accept': return editing.acceptCandidate(principal, p.siteId as string, p.candidateId as string, p.expectedRevision as number);
                case 'edit.reject': await editing.rejectCandidate(principal, p.siteId as string, p.candidateId as string); return { ok: true };
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
                        browser = await chromium.launch({ headless: false, chromiumSandbox: true, env: browserEnvironment() });
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
                        if (!first) void page.close();
                        first = false;
                        page.on('download', download => void download.cancel());
                    });
                    const page = await context.newPage();
                    await page.goto(server.url);
                    return { opened: true };
                }
                default: throw new AppError('INVALID_INPUT', 'Неизвестная команда.');
            }
        },
        async close() {
            if (closed) return;
            closed = true;
            clearInterval(timer);
            abort.abort();
            await pumping;
            await Promise.allSettled([...active]);
            await Promise.allSettled([...previews].map(async preview => {
                await preview.browser.close();
                await preview.server.close();
            }));
            await queue.close();
            await sites.close();
        }
    };
}
function browserEnvironment() {
    const env: Record<string, string> = {};
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA']) {
        if (process.env[key]) env[key] = process.env[key];
    }
    return env;
}
