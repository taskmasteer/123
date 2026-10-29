import { LocalBatches } from '../../../packages/adapters/src/local-batches.js';
import { openLocalDatabase, type LocalDatabase } from '../../../packages/adapters/src/local-database.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { ArtifactFile, Checkpoint, CheckpointStore, Job, Lease, ModelPort, Queue } from '../../../packages/contracts/src/model.js';
import type { LocalState } from '../../../packages/adapters/src/local-state.js';
import type { LocalQueue } from '../../../packages/adapters/src/local-queue.js';
import { createLocalState } from '../../../packages/adapters/src/local-state.js';
import { createLocalArtifacts } from '../../../packages/adapters/src/local-artifacts.js';
import { createLocalCatalog } from '../../../packages/adapters/src/local-catalog.js';
import { createLocalRevisions } from '../../../packages/adapters/src/local-revisions.js';
import { createLocalQueue as openLocalQueue } from '../../../packages/adapters/src/local-queue.js';
import { AppError } from '../../../packages/contracts/src/model.js';
import { FakeModel } from '../../../packages/adapters/src/fake-model.js';
import { createResponsesModel } from '../../../packages/adapters/src/openai/responses.js';
import { createImageGenerator } from '../../../packages/adapters/src/openai/images.js';
import { ManualClock } from '../../../packages/testing/src/clock.js';
import { validateStatic } from '../src/validation/static.js';
import { runJob } from '../src/pipeline.js';
import { runWorker } from '../src/runner.js';
import type { WorkerDeps } from '../src/pipeline.js';
import { cleanDirectories, directory, file, site as siteFiles } from './fixtures.js';
const openedSites: LocalState[] = [], openedQueues: LocalQueue[] = [], openedDatabases: LocalDatabase[] = [];
test('seals activity at bounded timer/pause/end boundaries rather than every lease check',async()=>{const f=await fixture();let writes=0;const record=f.deps.queue.recordActivity?.bind(f.deps.queue);f.deps.queue.recordActivity=async(lease,segment)=>{writes++;await record?.(lease,segment);};await runJob(f.job,f.lease,f.deps,new AbortController().signal);expect(writes).toBe(0);expect(f.job.state).toBe('completed');});
async function createLocalQueue(...args: Parameters<typeof openLocalQueue>) { const queue = await openLocalQueue(...args); openedQueues.push(queue); return queue; }
afterEach(async () => { await Promise.all(openedQueues.splice(0).map(q => q.close())); await Promise.all(openedSites.splice(0).map(s => s.close())); await Promise.all(openedDatabases.splice(0).map(db => db.close())); await cleanDirectories(); });
test('server settlement receipt completes an offline publication before stale lease reads or duplicate writes', async () => {
    const f = await fixture();
    f.job.checkpointId = randomUUID();
    f.job.stage = 'publication';
    const receipt = { jobId: f.job.id, siteId: f.site.id, checkpointId: f.job.checkpointId, expectedRevision: 0, manifestId: randomUUID(), revisionId: randomUUID(), requestKey: '' };
    receipt.requestKey = f.job.id + ':' + receipt.manifestId;
    f.deps.publication.settlement = async () => receipt;
    f.deps.queue.heartbeat = async () => { throw new AppError('STALE_LEASE', 'Already settled'); };
    let writes = 0;
    f.deps.revisions.put = async () => { writes++; };
    f.deps.queue.finish = async () => { writes++; };
    await expect(runJob(f.job, f.lease, f.deps, new AbortController().signal)).resolves.toBeUndefined();
    expect(writes).toBe(0);
});
test('settlement receipt rejects an unrelated checkpoint binding', async () => {
    const f = await fixture();
    f.job.checkpointId = randomUUID();
    f.deps.publication.settlement = async () => ({ jobId: f.job.id, siteId: f.site.id, checkpointId: randomUUID(), expectedRevision: 0, manifestId: randomUUID(), revisionId: randomUUID(), requestKey: 'wrong' });
    await expect(runJob(f.job, f.lease, f.deps, new AbortController().signal)).rejects.toMatchObject({ code: 'CONFLICT' });
});
test('one publication driver continues while both model slots are occupied and throttles idle ticks', async () => {
    const a = await fixture(), b = await fixture(), abort = new AbortController();
    let claims = 0, entered = 0, ticks = 0;
    let started!: () => void;
    const ready = new Promise<void>(r => started = r);
    const jobs = [a, b];
    a.deps.queue.claim = async () => { const f = jobs[claims++]; return f ? { job: f.job, lease: f.lease } : null; };
    a.deps.bind = async (job) => jobs.find(f => f.job.id === job.id)!.deps;
    for (const f of jobs)
        f.deps.model = { async run(_r, _t, signal) {
                entered++;
                if (entered === 2)
                    started();
                await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
                signal.throwIfAborted();
                throw new Error('unreachable');
            } };
    a.deps.queue.continuePublications = async () => { ticks++; };
    a.deps.delay = (ms, signal) => new Promise(resolve => { const timer = setTimeout(resolve, ms); signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
    vi.useFakeTimers();
    try {
        const running = runWorker(a.deps, 'worker', abort.signal);
        await ready;
        await vi.advanceTimersByTimeAsync(5000);
        expect(ticks).toBeGreaterThanOrEqual(2);
        expect(ticks).toBeLessThanOrEqual(3);
        abort.abort();
        await running;
    }
    finally {
        vi.useRealTimers();
    }
});
test('pending model work renews at thirty seconds and pause waits for the completed model stage', async () => {
    const f = await fixture();
    let renewals = 0, paused = false;
    const base = f.deps.queue.heartbeat;
    f.deps.queue.heartbeat = async (lease) => { renewals++; return base(lease); };
    f.deps.queue.shouldPause = async () => paused;
    let entered!: () => void, release!: () => void;
    const start = new Promise<void>(resolve => entered = resolve), gate = new Promise<void>(resolve => release = resolve);
    f.deps.model = { async run() { entered(); await gate; return { summary: 'Finished stage', inputTokens: 5, outputTokens: 3 }; } };
    vi.useFakeTimers();
    try {
        const running = runJob(f.job, f.lease, f.deps, new AbortController().signal);
        await start;
        const before = renewals;
        await vi.advanceTimersByTimeAsync(29999);
        expect(renewals).toBe(before);
        await vi.advanceTimersByTimeAsync(1);
        expect(renewals).toBe(before + 1);
        paused = true;
        release();
        await running;
        expect(f.job.state).toBe('paused');
        expect(f.job.stage).toBe('validate');
        expect((await f.deps.checkpoints.load(f.job.checkpointId!)).state.transcript).toMatchObject([{ inputTokens: 5, outputTokens: 3 }]);
    }
    finally {
        vi.useRealTimers();
    }
});
test('managed runner executes queued work and graceful pause commits the current stage before stopping', async () => {
    const f = await fixture(), root = await directory(), db = await openLocalDatabase(root);
    openedDatabases.push(db);
    const queue = await createLocalQueue(root, f.deps.clock, db), batches = new LocalBatches(db), owner = { userId: 'owner', role: 'user' } as const;
    const batch = await batches.submitBatch(owner, [{ rowNumber: 2, domain: 'runner-pause.test' }], 'pause-request'), jobId = batch.siteIds[0]!;
    const sites = await createLocalState(root, f.deps.clock, db);
    openedSites.push(sites);
    f.deps.sites = sites;
    f.deps.queue = queue;
    let modelCalls = 0;
    f.deps.model = { async run() { modelCalls++; return { summary: 'done', inputTokens: 3, outputTokens: 4 }; } };
    const abort = new AbortController(), claim = queue.claim.bind(queue), boundary = queue.pauseAtBoundary!.bind(queue);
    let requested = false;
    queue.claim = async (workerId) => {
        const result = await claim(workerId);
        if (result && !requested) {
            requested = true;
            await batches.pauseBatch(owner, batch.batchId);
        }
        return result;
    };
    queue.pauseAtBoundary = async (lease) => {
        const paused = await boundary(lease);
        if (paused)
            abort.abort();
        return paused;
    };
    await runWorker(f.deps, 'runner-device', abort.signal);
    const saved = (await queue.get(jobId))!;
    expect(saved.state).toBe('paused');
    expect(saved.stage).toBe('brief');
    expect(saved.checkpointId).not.toBeNull();
    expect(modelCalls).toBe(0);
    await queue.close();
    await sites.close();
    await db.close();
});
async function fixture(about = 'user supplied description: event streaming for research teams') {
    const root = await directory();
    const clock = new ManualClock(1000);
    const sites = await createLocalState(join(root, 'registry'), clock);
    // This fixture intentionally supplies a fake queue, without the local DB lease authority.
    delete sites.settlePublication;
    openedSites.push(sites);
    const site = await sites.create({ domain: 'signals.example', about }, { userId: 'owner', role: 'admin' });
    const job: Job = { id: randomUUID(), siteId: site.id, kind: 'generate', stage: 'brief', state: 'running', checkpointId: null, baseRevision: 0,
        generation: { seed: 17, styleId: 'editorial', templateVersion: '1.0.0' } };
    const lease: Lease = { jobId: job.id, workerId: 'worker', generation: 1, expiresAt: 121000 };
    const snapshots = new Map<string, {
        checkpoint: Checkpoint;
        state: Record<string, unknown>;
        files: ArtifactFile[];
    }>();
    const checkpoints: CheckpointStore = {
        async save(j, _lease, state, files) {
            const checkpoint: Checkpoint = { id: randomUUID(), jobId: j.id, stage: j.stage, manifestId: typeof state.manifestId === 'string' ? state.manifestId : null, stateKey: 'private', createdAt: clock.now() };
            snapshots.set(checkpoint.id, structuredClone({ checkpoint, state, files }));
            return checkpoint;
        },
        async load(id) { return structuredClone(snapshots.get(id)!); },
    };
    const queue: Queue = {
        async enqueue() { }, async claim() { return { job, lease }; }, async heartbeat(l) { return l; },
        async checkpoint(_lease, checkpoint) { job.checkpointId = checkpoint.id; job.stage = checkpoint.stage; },
        async finish(_lease, state) { job.state = state; },
    };
    const deps: WorkerDeps = { queue, sites, checkpoints, clock, artifacts: await createLocalArtifacts(join(root, 'public'), clock), revisions: await createLocalRevisions(join(root, 'revisions')),
        model: new FakeModel(), publication: { async advance() { return 'published'; } }, workspace: join(root, 'work'),
        templates: { async load() { return siteFiles('<h1 data-topic>Event systems</h1><p data-description>Reliable data tools for thoughtful teams.</p>'); } },
        validate: async (files) => validateStatic(files),
    };
    return { job, lease, deps, snapshots, site };
}
test.each(['same', 'replacement'])('explicit recovery checkpoints once across interruption with %s model', async (identity) => {
    const f = await fixture();
    let calls = 0;
    const bodies: any[] = [];
    const transport = (async (_url, init) => {
        calls++;
        bodies.push(JSON.parse(String(init?.body)));
        if (calls === 1)
            return Response.json({ status: 'completed', output: [{ type: 'reasoning', id: 'reason', summary: [], encrypted_content: 'private-opaque-history' }, { type: 'function_call', call_id: 'replace-once', name: 'replace', arguments: JSON.stringify({ path: 'style.css', oldText: '#111', newText: '#222' }) }], usage: { input_tokens: 10, output_tokens: 5 } });
        if (calls === 2)
            return Response.json({ error: { code: 'invalid_api_key' } }, { status: 401 });
        return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Preserved completed changes.' }] }], usage: { input_tokens: 2, output_tokens: 1 } });
    }) as typeof fetch;
    f.deps.model = createResponsesModel({ apiKey: 'fixture-key', model: 'original' }, transport);
    await runJob(f.job, f.lease, f.deps, new AbortController().signal);
    expect(f.job.state).toBe('needs_attention');
    const failedCheckpoint = f.job.checkpointId!;
    const failed = await f.deps.checkpoints.load(failedCheckpoint);
    const originalHtml = new TextDecoder().decode(failed.files.find(file => file.path === 'index.html')!.bytes);
    const next = createResponsesModel({ apiKey: 'new-fixture-key', model: identity === 'same' ? 'original' : 'replacement' }, transport);
    let recoveries = 0;
    f.deps.model = { ...next, recover(...args) { recoveries++; return next.recover!(...args); } };
    f.job.providerRecovery = { id: randomUUID(), checkpointId: failedCheckpoint, modelIdentity: next.identity! };
    const interrupted = new AbortController(), checkpoint = f.deps.queue.checkpoint;
    f.deps.queue.checkpoint = async (lease, saved) => {
        await checkpoint(lease, saved);
        if ((await f.deps.checkpoints.load(saved.id)).state.providerRecoveryId === f.job.providerRecovery!.id)
            interrupted.abort();
    };
    await runJob(f.job, f.lease, f.deps, interrupted.signal);
    expect(f.job.state).toBe('paused');
    expect(calls).toBe(2);
    expect(recoveries).toBe(1);
    f.deps.queue.checkpoint = checkpoint;
    await runJob(f.job, f.lease, f.deps, new AbortController().signal);
    expect(f.job.state).toBe('completed');
    expect(calls).toBe(3);
    expect(recoveries).toBe(1);
    const saved = await f.deps.checkpoints.load(f.job.checkpointId!);
    expect(saved.state.providerRecoveries).toHaveLength(1);
    expect(saved.state.transcript).toMatchObject([{ inputTokens: 12, outputTokens: 6 }]);
    expect(new TextDecoder().decode(saved.files.find(file => file.path === 'style.css')!.bytes)).toContain('#222');
    expect(new TextDecoder().decode(saved.files.find(file => file.path === 'index.html')!.bytes)).toBe(originalHtml);
    expect(JSON.stringify(bodies[2].input).includes('private-opaque-history')).toBe(identity === 'same');
    expect(JSON.stringify(failed.state)).toContain('replace-once');
});
test('explicit recovery ticket survives controller restart and stale tickets fail atomically', async () => {
    const root = await directory(), clock = new ManualClock(1000);
    let queue = await createLocalQueue(root, clock);
    const job: Job = { id: randomUUID(), siteId: randomUUID(), kind: 'generate', stage: 'generate', state: 'queued', checkpointId: null, baseRevision: 0 };
    await queue.enqueue(job);
    const claimed = (await queue.claim('worker'))!;
    const checkpoint: Checkpoint = { id: randomUUID(), jobId: job.id, stage: 'generate', manifestId: null, stateKey: 'private', createdAt: 1000 };
    await queue.checkpoint(claimed.lease, checkpoint);
    await queue.finish(claimed.lease, 'needs_attention');
    const ticket = { id: randomUUID(), checkpointId: checkpoint.id, modelIdentity: 'openai:configured' };
    await expect(queue.retry(job.id, { ...ticket, checkpointId: 'foreign' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await queue.get(job.id))!.state).toBe('needs_attention');
    await queue.retry(job.id, ticket);
    await queue.close();
    queue = await createLocalQueue(root, clock);
    expect((await queue.claim('restarted'))!.job.providerRecovery).toEqual(ticket);
    await queue.close();
});
test('a pending ambiguous image cannot be bypassed by an account-recovery ticket', async () => {
    const f = await fixture();
    let calls = 0;
    f.deps.model = createResponsesModel({ apiKey: 'fixture-key', model: 'configured' }, (async () => { calls++; return Response.json({}, { status: 401 }); }) as typeof fetch);
    await runJob(f.job, f.lease, f.deps, new AbortController().signal);
    expect(f.job.state).toBe('needs_attention');
    f.snapshots.get(f.job.checkpointId!)!.state.imageRun = { key: 'saved-image-selection', status: 'pending' };
    f.job.providerRecovery = { id: randomUUID(), checkpointId: f.job.checkpointId!, modelIdentity: f.deps.model.identity! };
    await runJob(f.job, f.lease, f.deps, new AbortController().signal);
    expect(f.job.state).toBe('needs_attention');
    expect(calls).toBe(1);
    expect((await f.deps.checkpoints.load(f.job.checkpointId!)).state.imageRun).toMatchObject({ status: 'pending' });
});
test('checkpoints provider outputs and matching files before resuming without replaying replace', async () => {
    const f = await fixture();
    let calls = 0;
    const transport = (async (_url, init) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        expect(body.instructions).toContain('English');
        if (calls === 1)
            return Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: 'color', name: 'replace', arguments: JSON.stringify({ path: 'style.css', oldText: '#111', newText: '#222' }) }] });
        expect(body.input.some((item: {
            type: string;
        }) => item.type === 'function_call_output')).toBe(true);
        return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Updated color.' }] }] });
    }) as typeof fetch;
    const live = createResponsesModel({ apiKey: 'synthetic', model: 'configured' }, transport);
    f.deps.model = { retryOwner: 'adapter', identity: live.identity!, run: (request, tools, signal, hooks) => live.run(request, tools, signal, { async checkpoint(state) {
                await hooks!.checkpoint(state);
                if (state.items.some(item => item.type === 'function_call_output'))
                    throw new AppError('PROVIDER_WAIT', 'simulated wait');
            } }) };
    await runJob(f.job, f.lease, f.deps, new AbortController().signal);
    expect(f.job.state).toBe('waiting_provider');
    expect(calls).toBe(1);
    const saved = await f.deps.checkpoints.load(f.job.checkpointId!);
    expect(saved.state.continuation).toMatchObject({ provider: 'openai-responses' });
    expect(new TextDecoder().decode(saved.files.find(file => file.path === 'style.css')!.bytes)).toContain('#222');
    f.deps.model = live;
    await runJob(f.job, f.lease, f.deps, new AbortController().signal);
    expect(f.job.state).toBe('completed');
    expect(calls).toBe(2);
});
test('live image selection persists in the existing pipeline and disables fallback SVG', async () => {
    const f = await fixture();
    f.job.generation!.seed = 3;
    let imageCalls = 0;
    f.deps.images = async (description, seed, signal, hooks) => createImageGenerator({ apiKey: 'synthetic', model: 'configured' }, (async () => { imageCalls++; throw new Error('forbidden'); }) as typeof fetch, hooks, signal).generateImage(description, seed);
    await runJob(f.job, f.lease, f.deps, new AbortController().signal);
    expect(f.job.state).toBe('completed');
    const saved = await f.deps.checkpoints.load(f.job.checkpointId!);
    expect(saved.state.imageRun).toMatchObject({ status: 'skipped' });
    expect(imageCalls).toBe(0);
    expect(saved.files.some(file => file.path.endsWith('.svg'))).toBe(false);
});
// Catches skipped stages, discarded user briefs, private files accidentally published, and missing automatic publication.
test('generates, validates and automatically publishes a fresh site using its manual brief', async () => {
    const f = await fixture();
    await runJob(f.job, f.lease, f.deps, new AbortController().signal);
    expect(f.job.state).toBe('completed');
    const site = (await f.deps.sites.get(f.site.id))!;
    expect(site.publishedId).not.toBeNull();
    const revision = await f.deps.revisions.get(site.publishedId!);
    expect(revision).not.toBeNull();
    expect(revision!.kind).toBe('published');
    expect(revision!.siteId).toBe(site.id);
    expect(revision!.id).not.toBe(revision!.manifestId);
    const files = await f.deps.artifacts.read(revision!.manifestId);
    expect(files.map((f) => f.path).sort()).toEqual(['index.html', 'style.css']);
    expect(new TextDecoder().decode(files[0]!.bytes)).toContain('user supplied description');
    expect([...f.snapshots.values()].map((s) => s.checkpoint.stage)).toEqual(['assets', 'generate', 'validate', 'archive', 'publication', 'completed']);
    const checkpoint = await f.deps.checkpoints.load(f.job.checkpointId!);
    expect(checkpoint.state.toolTranscript).toEqual([{ operation: 'read', path: 'index.html' }, { operation: 'write', path: 'index.html' }]);
    expect(new FakeModel().runtimeStatus).toEqual({ mode: 'demo', realModel: false });
});
// Catches unlimited repair, publishing failed validation, and a poisoned worker blocking its next job.
test('stops after two repairs and lets another independent job complete', async () => {
    const f = await fixture();
    let repairs = 0;
    f.deps.model = { async run(request, tools) {
            if (request.instruction.includes('Validation issues:'))
                repairs++;
            await tools.write('index.html', '<html lang="en"><head><title>Broken</title></head><body><form>Forbidden</form></body></html>');
            return { summary: 'Fault injection', inputTokens: 10, outputTokens: 10 };
        } };
    await runJob(f.job, f.lease, f.deps, new AbortController().signal);
    expect(f.job.state).toBe('needs_attention');
    expect(repairs).toBe(2);
    expect((await f.deps.sites.get(f.site.id))!.publishedId).toBeNull();
    const other = await fixture();
    await runJob(other.job, other.lease, other.deps, new AbortController().signal);
    expect(other.job.state).toBe('completed');
});
// Catches reselecting a style or rerunning generation after a process restarts at validation.
test('resumes from private files and frozen decisions after validation is interrupted', async () => {
    const f = await fixture('');
    const stop = new AbortController();
    f.deps.validate = async () => { stop.abort(); throw stop.signal.reason; };
    await runJob(f.job, f.lease, f.deps, stop.signal);
    expect(f.job.state).toBe('paused');
    expect(f.job.stage).toBe('validate');
    const saved = await f.deps.checkpoints.load(f.job.checkpointId!);
    const model: ModelPort = { async run() { throw new Error('Generation must not repeat'); } };
    f.deps.model = model;
    f.deps.validate = async (files) => validateStatic(files);
    await runJob(f.job, f.lease, f.deps, new AbortController().signal);
    expect(f.job.state).toBe('completed');
    const final = await f.deps.checkpoints.load(f.job.checkpointId!);
    expect(final.state.brief).toEqual(saved.state.brief);
    expect(final.state.selection).toEqual(saved.state.selection);
    expect(final.state.image).toEqual(saved.state.image);
});
// Catches installing a candidate on a site changed after job creation.
test('does not publish over a newer site revision', async () => {
    const f = await fixture();
    await f.deps.sites.compareAndSet(f.site.id, 0, { generationStatus: 'changed' });
    await runJob(f.job, f.lease, f.deps, new AbortController().signal);
    expect(f.job.state).toBe('needs_attention');
    expect((await f.deps.sites.get(f.site.id))!.publishedId).toBeNull();
});
// Catches completing jobs before publication is actually published and rerunning paid generation on retry.
test('waits for publication and resumes the same archived manifest', async () => {
    const f = await fixture();
    f.deps.publication = { async advance() { return 'waiting_quota'; } };
    await runJob(f.job, f.lease, f.deps, new AbortController().signal);
    expect(f.job.state).toBe('waiting_provider');
    expect(f.job.stage).toBe('publication');
    const saved = await f.deps.checkpoints.load(f.job.checkpointId!);
    f.deps.model = { async run() { throw new Error('Must reuse validated archive'); } };
    f.deps.publication = { async advance() { return 'published'; } };
    await runJob(f.job, f.lease, f.deps, new AbortController().signal);
    expect(f.job.state).toBe('completed');
    const published = await f.deps.revisions.get((await f.deps.sites.get(f.site.id))!.publishedId!);
    expect(published).not.toBeNull();
    expect(published!.manifestId).toBe(saved.state.manifestId);
});
// Catches silently ignoring a user's reference and choosing disabled styles on an unprepared job.
test('fallback selection respects the reference catalog and freezes it before the model runs', async () => {
    const f = await fixture();
    delete f.job.generation;
    f.job.id = '00000000-0000-4000-8000-000000000001';
    f.lease.jobId = f.job.id;
    const site = await f.deps.sites.compareAndSet(f.site.id, 0, { input: { domain: f.site.domain, about: 'Protocol tools', referenceId: 'evolv-ai' } });
    f.job.baseRevision = site.revision;
    const catalog = await createLocalCatalog(process.cwd(), await directory());
    f.deps.templates = catalog;
    await runJob(f.job, f.lease, f.deps, new AbortController().signal);
    expect(f.job.state).toBe('completed');
    const saved = await f.deps.checkpoints.load(f.job.checkpointId!);
    expect(saved.state.selection).toMatchObject({ styleId: 'dark-tech', templateVersion: '1.0.0' });
});
// Task5 owns candidate acceptance: generation must not replace a user's draft implicitly.
test('an edit archives a candidate without changing the site before explicit acceptance', async () => {
    const f = await fixture();
    const base = await f.deps.artifacts.put(f.site.id, siteFiles('<h1 data-topic>Initial topic</h1>'), '1.0.0');
    const baseRevision = { id: randomUUID(), siteId: f.site.id, parentId: null, manifestId: base.id, kind: 'published' as const, createdAt: f.deps.clock.now() };
    await f.deps.revisions.put(baseRevision);
    const site = await f.deps.sites.compareAndSet(f.site.id, 0, { publishedId: baseRevision.id });
    f.job.kind = 'edit';
    f.job.baseRevision = site.revision;
    f.deps.publication = { async advance() { throw new Error('Editing must not auto-publish'); } };
    await runJob(f.job, f.lease, f.deps, new AbortController().signal);
    expect(f.job.state).toBe('completed');
    const candidate = await f.deps.checkpoints.load(f.job.checkpointId!);
    expect(candidate.state.manifestId).not.toBe(base.id);
    expect(candidate.state.manifestId).not.toBeNull();
    expect(await f.deps.sites.get(f.site.id)).toEqual(site);
    await runJob(f.job, f.lease, f.deps, new AbortController().signal);
    expect(f.job.state).toBe('completed');
    expect(await f.deps.sites.get(f.site.id)).toEqual(site);
});
// Catches indefinite retries or loss of backoff around transient model transport failures.
test('retries transient model transport failures at most three times with backoff', async () => {
    const f = await fixture();
    let attempts = 0;
    const delays: number[] = [];
    f.deps.delay = async (milliseconds) => { delays.push(milliseconds); };
    f.deps.model = { async run() { attempts++; throw Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' }); } };
    await runJob(f.job, f.lease, f.deps, new AbortController().signal);
    expect(attempts).toBe(4);
    expect(delays).toEqual([1000, 2000, 4000]);
    expect(f.job.state).toBe('waiting_provider');
    f.deps.model = new FakeModel();
    await runJob(f.job, f.lease, f.deps, new AbortController().signal);
    expect(f.job.state).toBe('completed');
});
test('rejects a private checkpoint from another site before invoking the model', async () => {
    const f = await fixture();
    const stop = new AbortController();
    f.deps.validate = async () => { stop.abort(); throw stop.signal.reason; };
    await runJob(f.job, f.lease, f.deps, stop.signal);
    f.snapshots.get(f.job.checkpointId!)!.state.siteId = 'foreign-site';
    f.deps.model = { async run() { throw new Error('Checkpoint must be rejected before generation'); } };
    await runJob(f.job, f.lease, f.deps, new AbortController().signal);
    expect(f.job.state).toBe('needs_attention');
    expect((await f.deps.sites.get(f.site.id))!.publishedId).toBeNull();
});
test('persists the selected illustration across a model quota wait', async () => {
    const f = await fixture('');
    f.job.generation!.seed = 3;
    f.deps.model = { async run(request) { if(request.mode==='plan')return {summary:JSON.stringify({topic:'An invented concept for reliable event tracing'}),inputTokens:0,outputTokens:0};throw new AppError('PROVIDER_WAIT', 'Quota wait'); } };
    await runJob(f.job, f.lease, f.deps, new AbortController().signal);
    expect(f.job.state).toBe('waiting_provider');
    const saved = await f.deps.checkpoints.load(f.job.checkpointId!);
    expect(saved.state.image).toBe('assets/network.svg');
    expect(saved.files.filter((file) => file.mediaType.startsWith('image/'))).toHaveLength(1);
    f.deps.model = new FakeModel();
    await runJob(f.job, f.lease, f.deps, new AbortController().signal);
    expect(f.job.state).toBe('completed');
    const revision = await f.deps.revisions.get((await f.deps.sites.get(f.site.id))!.publishedId!);
    expect(revision).not.toBeNull();
    const published = await f.deps.artifacts.read(revision!.manifestId);
    expect(published.find((file) => file.path === 'assets/network.svg')!.bytes).toEqual(saved.files.find((file) => file.path === 'assets/network.svg')!.bytes);
});
test('a concurrent site update prevents the publication side effect', async () => {
    const f = await fixture();
    let publications = 0;
    f.deps.publication = { async advance() { publications++; return 'published'; } };
    f.deps.model = { async run(request, tools, signal) {
            await f.deps.sites.compareAndSet(f.site.id, 0, { generationStatus: 'newer_operation' });
            return new FakeModel().run(request, tools, signal);
        } };
    await runJob(f.job, f.lease, f.deps, new AbortController().signal);
    expect(f.job.state).toBe('needs_attention');
    expect(publications).toBe(0);
});
test('resume rejects a mismatched publication intent before touching the publication provider', async () => {
    const f = await fixture();
    f.deps.publication = { async advance() { return 'waiting_quota'; } };
    await runJob(f.job, f.lease, f.deps, new AbortController().signal);
    f.snapshots.get(f.job.checkpointId!)!.state.intentId = 'another-job:another-manifest';
    let publications = 0;
    f.deps.publication = { async advance() { publications++; return 'published'; } };
    await runJob(f.job, f.lease, f.deps, new AbortController().signal);
    expect(f.job.state).toBe('needs_attention');
    expect(publications).toBe(0);
});
test('resume refuses publication without persisted successful validation evidence', async () => {
    const f = await fixture();
    f.deps.publication = { async advance() { return 'waiting_quota'; } };
    await runJob(f.job, f.lease, f.deps, new AbortController().signal);
    delete f.snapshots.get(f.job.checkpointId!)!.state.validation;
    let publications = 0;
    f.deps.publication = { async advance() { publications++; return 'published'; } };
    await runJob(f.job, f.lease, f.deps, new AbortController().signal);
    expect(f.job.state).toBe('needs_attention');
    expect(publications).toBe(0);
});
// A provider wait or abort must retry the same repair, not spend another validation repair attempt.
test.each(['quota', 'abort'] as const)('resumes the same pending repair after repeated %s interruptions', async (interruption) => {
    const f = await fixture();
    let controller = new AbortController();
    let repairCalls = 0;
    let validations = 0;
    const instructions: string[] = [];
    f.deps.validate = async (files) => { validations++; return validateStatic(files); };
    f.deps.model = { async run(request, tools, signal) {
            if (!request.instruction.includes('Validation issues:')) {
                await tools.write('index.html', '<html lang="en"><head><title>Broken</title></head><body><form>Forbidden</form></body></html>');
            }
            else {
                repairCalls++;
                instructions.push(request.instruction);
                if (repairCalls < 3) {
                    if (interruption === 'quota')
                        throw new AppError('PROVIDER_WAIT', 'Quota wait during repair');
                    controller.abort();
                    signal.throwIfAborted();
                }
                await tools.write('index.html', new TextDecoder().decode(siteFiles('<h1>Recovered event processing</h1>')[0]!.bytes));
            }
            return { summary: 'Generated local test content', inputTokens: 0, outputTokens: 0 };
        } };
    for (let attempt = 0; attempt < 2; attempt++) {
        controller = new AbortController();
        await runJob(f.job, f.lease, f.deps, controller.signal);
        expect(f.job.state).toBe(interruption === 'quota' ? 'waiting_provider' : 'paused');
        const saved = await f.deps.checkpoints.load(f.job.checkpointId!);
        expect(saved.state.repairAttempts).toBe(1);
    }
    controller = new AbortController();
    await runJob(f.job, f.lease, f.deps, controller.signal);
    expect(f.job.state).toBe('completed');
    expect(repairCalls).toBe(3);
    expect(validations).toBe(2);
    expect(new Set(instructions).size).toBe(1);
    const completed = await f.deps.checkpoints.load(f.job.checkpointId!);
    expect(completed.state.repairAttempts).toBe(1);
    expect(completed.state.pendingRepairInstruction).toBeUndefined();
    expect((await f.deps.sites.get(f.site.id))!.publishedId).not.toBeNull();
});

test.each(['generate', 'edit'] as const)('sends factuality and concept rules in the actual %s provider request', async (mode) => {
    const facts = 'A research concept for observing event streams.';
    const f = await fixture(facts);
    if (mode === 'edit') {
        const base = await f.deps.artifacts.put(f.site.id, siteFiles('<h1>Research concept</h1>'), '1.0.0');
        const revision = { id: randomUUID(), siteId: f.site.id, parentId: null, manifestId: base.id, kind: 'published' as const, createdAt: f.deps.clock.now() };
        await f.deps.revisions.put(revision);
        const updated = await f.deps.sites.compareAndSet(f.site.id, 0, { publishedId: revision.id });
        f.job.kind = 'edit'; f.job.baseRevision = updated.revision;
    }
    const bodies: any[] = [];
    f.deps.model = createResponsesModel({ apiKey: 'synthetic', model: 'configured' }, (async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Updated content.' }] }] });
    }) as typeof fetch);
    await runJob(f.job, f.lease, f.deps, new AbortController().signal);
    expect(f.job.state).toBe('completed');
    expect(bodies).toHaveLength(1);
    expect(bodies[0].instructions).toMatch(/reviews.*clients.*teams.*awards.*contacts.*metrics/i);
    expect(bodies[0].instructions).toMatch(/factual claims.*provided/i);
    expect(bodies[0].instructions).toMatch(/concept.*concept/i);
    expect(JSON.parse(bodies[0].input[0].content).about).toBe(facts);
});

test('automatic model brief is checkpointed before assets and survives a restart at the provider boundary',async()=>{
 const f=await fixture(''),topic='A concept for tracing cryptographic proofs across distributed event logs',bodies:any[]=[];
 f.deps.model=createResponsesModel({apiKey:'synthetic',model:'configured'},async(_url,init)=>{const body=JSON.parse(String(init?.body));bodies.push(body);return Response.json({status:'completed',output:[{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:bodies.length===1?JSON.stringify({topic}):'Created the concept site.'}]}],usage:{input_tokens:4,output_tokens:8}});});
 const abort=new AbortController(),checkpoint=f.deps.queue.checkpoint;
 f.deps.queue.checkpoint=async(...args)=>{await checkpoint(...args);const s=await f.deps.checkpoints.load(args[1].id);if(s.state.brief===topic&&args[1].stage==='assets')abort.abort();};
 await runJob(f.job,f.lease,f.deps,abort.signal);
 expect((await f.deps.checkpoints.load(f.job.checkpointId!)).state.brief).toBe(topic);
 expect(bodies).toHaveLength(1);expect(bodies[0].instructions).toMatch(/invent.*English.*IT.*crypto/i);expect(bodies[0].tools).toEqual([]);
 const seed=(await f.deps.checkpoints.load(f.job.checkpointId!)).state.selection;
 f.deps.queue.checkpoint=checkpoint;await runJob(f.job,f.lease,f.deps,new AbortController().signal);
 expect(f.job.state).toBe('completed');expect(bodies).toHaveLength(2);expect(JSON.parse(bodies[1].input[0].content).about).toBe(topic);
 expect((await f.deps.checkpoints.load(f.job.checkpointId!)).state.selection).toEqual(seed);
});

test('records a bounded batch composition similarity signal without rejecting a repeated design',async()=>{
 const f=await fixture();let observed:string[]=[];f.deps.compareComposition=async(signature)=>{observed=signature;return {score:1,compared:1,repeated:true};};
 await runJob(f.job,f.lease,f.deps,new AbortController().signal);expect(observed.length).toBeGreaterThan(0);expect(observed.length).toBeLessThanOrEqual(128);expect((await f.deps.checkpoints.load(f.job.checkpointId!)).state.similarity).toEqual({score:1,compared:1,repeated:true});expect(f.job.state).toBe('completed');
});

test('explicit provider recovery resumes automatic brief planning before generation',async()=>{
 const f=await fixture('');let calls=0;f.deps.model=createResponsesModel({apiKey:'synthetic',model:'configured'},async()=>{calls++;return calls===1?Response.json({error:{code:'invalid_api_key'}},{status:401}):Response.json({status:'completed',output:[{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:calls===2?JSON.stringify({topic:'A concept for privacy preserving distributed event analysis'}):'Created the concept.'}]}],usage:{input_tokens:2,output_tokens:3}});});
 await runJob(f.job,f.lease,f.deps,new AbortController().signal);expect(f.job.state).toBe('needs_attention');expect(f.job.stage).toBe('brief');f.job.providerRecovery={id:randomUUID(),checkpointId:f.job.checkpointId!,modelIdentity:f.deps.model.identity!};await runJob(f.job,f.lease,f.deps,new AbortController().signal);expect(f.job.state).toBe('completed');expect(calls).toBe(3);
});

test('legacy checkpoint before its first provider call pins the new prompt version before saving continuation',async()=>{
 const f=await fixture();f.deps.queue.shouldPause=async()=>true;await runJob(f.job,f.lease,f.deps,new AbortController().signal);delete f.snapshots.get(f.job.checkpointId!)!.state.promptVersion;f.deps.queue.shouldPause=async()=>false;
 const abort=new AbortController(),checkpoint=f.deps.queue.checkpoint;let calls=0;f.deps.model=createResponsesModel({apiKey:'synthetic',model:'configured'},async()=>{calls++;return Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Preserved input facts.'}]}]});});
 // Keep the same configured identity; only this legacy prompt marker predates the new version.
 f.snapshots.get(f.job.checkpointId!)!.state.modelIdentity=f.deps.model.identity;
 f.deps.queue.checkpoint=async(...args)=>{await checkpoint(...args);if((await f.deps.checkpoints.load(args[1].id)).state.continuation)abort.abort();};
 await runJob(f.job,f.lease,f.deps,abort.signal);expect((await f.deps.checkpoints.load(f.job.checkpointId!)).state.promptVersion).toBe(2);f.deps.queue.checkpoint=checkpoint;await runJob(f.job,f.lease,f.deps,new AbortController().signal);expect(f.job.state).toBe('completed');expect(calls).toBe(1);
});
