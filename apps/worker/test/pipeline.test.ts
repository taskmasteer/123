import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { ArtifactFile, Checkpoint, CheckpointStore, Job, Lease, ModelPort, Queue } from '../../../packages/contracts/src/model.js';
import { createLocalState } from '../../../packages/adapters/src/local-state.js';
import { createLocalArtifacts } from '../../../packages/adapters/src/local-artifacts.js';
import { createLocalCatalog } from '../../../packages/adapters/src/local-catalog.js';
import { createLocalRevisions } from '../../../packages/adapters/src/local-revisions.js';
import { AppError } from '../../../packages/contracts/src/model.js';
import { FakeModel } from '../../../packages/adapters/src/fake-model.js';
import { ManualClock } from '../../../packages/testing/src/clock.js';
import { validateStatic } from '../src/validation/static.js';
import { runJob } from '../src/pipeline.js';
import type { WorkerDeps } from '../src/pipeline.js';
import { cleanDirectories, directory, file, site as siteFiles } from './fixtures.js';

afterEach(cleanDirectories);
async function fixture(about = 'user supplied description: event streaming for research teams') {
  const root = await directory(); const clock = new ManualClock(1000);
  const sites = await createLocalState(join(root, 'registry'), clock);
  const site = await sites.create({ domain: 'signals.example', about }, { userId: 'owner', role: 'admin' });
  const job: Job = { id: randomUUID(), siteId: site.id, kind: 'generate', stage: 'brief', state: 'running', checkpointId: null, baseRevision: 0,
    generation: { seed: 17, styleId: 'editorial', templateVersion: '1.0.0' } };
  const lease: Lease = { jobId: job.id, workerId: 'worker', generation: 1, expiresAt: 121000 };
  const snapshots = new Map<string, { checkpoint: Checkpoint; state: Record<string, unknown>; files: ArtifactFile[] }>();
  const checkpoints: CheckpointStore = {
    async save(j, _lease, state, files) {
      const checkpoint: Checkpoint = { id: randomUUID(), jobId: j.id, stage: j.stage, manifestId: typeof state.manifestId === 'string' ? state.manifestId : null, stateKey: 'private', createdAt: clock.now() };
      snapshots.set(checkpoint.id, structuredClone({ checkpoint, state, files })); return checkpoint;
    },
    async load(id) { return structuredClone(snapshots.get(id)!); },
  };
  const queue: Queue = {
    async enqueue() {}, async claim() { return { job, lease }; }, async heartbeat(l) { return l; },
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

// Catches skipped stages, discarded user briefs, private files accidentally published, and missing automatic publication.
test('generates, validates and automatically publishes a fresh site using its manual brief', async () => {
  const f = await fixture(); await runJob(f.job, f.lease, f.deps, new AbortController().signal);
  expect(f.job.state).toBe('completed');
  const site = (await f.deps.sites.get(f.site.id))!; expect(site.publishedId).not.toBeNull();
  const revision = await f.deps.revisions.get(site.publishedId!); expect(revision).not.toBeNull();
  expect(revision!.kind).toBe('published'); expect(revision!.siteId).toBe(site.id);
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
  const f = await fixture(); let repairs = 0;
  f.deps.model = { async run(request, tools) { if (request.instruction.includes('Validation issues:')) repairs++;
    await tools.write('index.html', '<html lang="en"><head><title>Broken</title></head><body><form>Forbidden</form></body></html>');
    return { summary: 'Fault injection', inputTokens: 10, outputTokens: 10 }; } };
  await runJob(f.job, f.lease, f.deps, new AbortController().signal);
  expect(f.job.state).toBe('needs_attention'); expect(repairs).toBe(2);
  expect((await f.deps.sites.get(f.site.id))!.publishedId).toBeNull();
  const other = await fixture(); await runJob(other.job, other.lease, other.deps, new AbortController().signal);
  expect(other.job.state).toBe('completed');
});

// Catches reselecting a style or rerunning generation after a process restarts at validation.
test('resumes from private files and frozen decisions after validation is interrupted', async () => {
  const f = await fixture(''); const stop = new AbortController();
  f.deps.validate = async () => { stop.abort(); throw stop.signal.reason; };
  await runJob(f.job, f.lease, f.deps, stop.signal);
  expect(f.job.state).toBe('paused'); expect(f.job.stage).toBe('validate');
  const saved = await f.deps.checkpoints.load(f.job.checkpointId!);
  const model: ModelPort = { async run() { throw new Error('Generation must not repeat'); } };
  f.deps.model = model; f.deps.validate = async (files) => validateStatic(files);
  await runJob(f.job, f.lease, f.deps, new AbortController().signal);
  expect(f.job.state).toBe('completed');
  const final = await f.deps.checkpoints.load(f.job.checkpointId!);
  expect(final.state.brief).toEqual(saved.state.brief); expect(final.state.selection).toEqual(saved.state.selection);
  expect(final.state.image).toEqual(saved.state.image);
});

// Catches installing a candidate on a site changed after job creation.
test('does not publish over a newer site revision', async () => {
  const f = await fixture(); await f.deps.sites.compareAndSet(f.site.id, 0, { generationStatus: 'changed' });
  await runJob(f.job, f.lease, f.deps, new AbortController().signal);
  expect(f.job.state).toBe('needs_attention'); expect((await f.deps.sites.get(f.site.id))!.publishedId).toBeNull();
});

// Catches completing jobs before publication is actually published and rerunning paid generation on retry.
test('waits for publication and resumes the same archived manifest', async () => {
  const f = await fixture(); f.deps.publication = { async advance() { return 'waiting_quota'; } };
  await runJob(f.job, f.lease, f.deps, new AbortController().signal);
  expect(f.job.state).toBe('waiting_provider'); expect(f.job.stage).toBe('publication');
  const saved = await f.deps.checkpoints.load(f.job.checkpointId!);
  f.deps.model = { async run() { throw new Error('Must reuse validated archive'); } };
  f.deps.publication = { async advance() { return 'published'; } };
  await runJob(f.job, f.lease, f.deps, new AbortController().signal);
  expect(f.job.state).toBe('completed');
  const published = await f.deps.revisions.get((await f.deps.sites.get(f.site.id))!.publishedId!);
  expect(published).not.toBeNull(); expect(published!.manifestId).toBe(saved.state.manifestId);
});

// Catches silently ignoring a user's reference and choosing disabled styles on an unprepared job.
test('fallback selection respects the reference catalog and freezes it before the model runs', async () => {
  const f = await fixture(); delete f.job.generation;
  f.job.id = '00000000-0000-4000-8000-000000000001'; f.lease.jobId = f.job.id;
  const site = await f.deps.sites.compareAndSet(f.site.id, 0, { input: { domain: f.site.domain, about: 'Protocol tools', referenceId: 'evolv-ai' } });
  f.job.baseRevision = site.revision;
  const catalog = await createLocalCatalog(process.cwd(), await directory()); f.deps.templates = catalog;
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
  f.job.kind = 'edit'; f.job.baseRevision = site.revision;
  f.deps.publication = { async advance() { throw new Error('Editing must not auto-publish'); } };
  await runJob(f.job, f.lease, f.deps, new AbortController().signal);
  expect(f.job.state).toBe('completed');
  const candidate = await f.deps.checkpoints.load(f.job.checkpointId!);
  expect(candidate.state.manifestId).not.toBe(base.id); expect(candidate.state.manifestId).not.toBeNull();
  expect(await f.deps.sites.get(f.site.id)).toEqual(site);
  await runJob(f.job, f.lease, f.deps, new AbortController().signal);
  expect(f.job.state).toBe('completed');
  expect(await f.deps.sites.get(f.site.id)).toEqual(site);
});

// Catches indefinite retries or loss of backoff around transient model transport failures.
test('retries transient model transport failures at most three times with backoff', async () => {
  const f = await fixture(); let attempts = 0; const delays: number[] = [];
  f.deps.delay = async (milliseconds) => { delays.push(milliseconds); };
  f.deps.model = { async run() { attempts++; throw Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' }); } };
  await runJob(f.job, f.lease, f.deps, new AbortController().signal);
  expect(attempts).toBe(4); expect(delays).toEqual([1000, 2000, 4000]); expect(f.job.state).toBe('waiting_provider');
  f.deps.model = new FakeModel(); await runJob(f.job, f.lease, f.deps, new AbortController().signal);
  expect(f.job.state).toBe('completed');
});

test('rejects a private checkpoint from another site before invoking the model', async () => {
  const f = await fixture(); const stop = new AbortController();
  f.deps.validate = async () => { stop.abort(); throw stop.signal.reason; };
  await runJob(f.job, f.lease, f.deps, stop.signal);
  f.snapshots.get(f.job.checkpointId!)!.state.siteId = 'foreign-site';
  f.deps.model = { async run() { throw new Error('Checkpoint must be rejected before generation'); } };
  await runJob(f.job, f.lease, f.deps, new AbortController().signal);
  expect(f.job.state).toBe('needs_attention'); expect((await f.deps.sites.get(f.site.id))!.publishedId).toBeNull();
});

test('persists the selected illustration across a model quota wait', async () => {
  const f = await fixture(''); f.job.generation!.seed = 3;
  f.deps.model = { async run() { throw new AppError('PROVIDER_WAIT', 'Quota wait'); } };
  await runJob(f.job, f.lease, f.deps, new AbortController().signal);
  expect(f.job.state).toBe('waiting_provider');
  const saved = await f.deps.checkpoints.load(f.job.checkpointId!); expect(saved.state.image).toBe('assets/network.svg');
  expect(saved.files.filter((file) => file.mediaType.startsWith('image/'))).toHaveLength(1);
  f.deps.model = new FakeModel(); await runJob(f.job, f.lease, f.deps, new AbortController().signal);
  expect(f.job.state).toBe('completed');
  const revision = await f.deps.revisions.get((await f.deps.sites.get(f.site.id))!.publishedId!); expect(revision).not.toBeNull();
  const published = await f.deps.artifacts.read(revision!.manifestId);
  expect(published.find((file) => file.path === 'assets/network.svg')!.bytes).toEqual(saved.files.find((file) => file.path === 'assets/network.svg')!.bytes);
});

test('a concurrent site update prevents the publication side effect', async () => {
  const f = await fixture(); let publications = 0;
  f.deps.publication = { async advance() { publications++; return 'published'; } };
  f.deps.model = { async run(request, tools, signal) {
    await f.deps.sites.compareAndSet(f.site.id, 0, { generationStatus: 'newer_operation' });
    return new FakeModel().run(request, tools, signal);
  } };
  await runJob(f.job, f.lease, f.deps, new AbortController().signal);
  expect(f.job.state).toBe('needs_attention'); expect(publications).toBe(0);
});

test('resume rejects a mismatched publication intent before touching the publication provider', async () => {
  const f = await fixture(); f.deps.publication = { async advance() { return 'waiting_quota'; } };
  await runJob(f.job, f.lease, f.deps, new AbortController().signal);
  f.snapshots.get(f.job.checkpointId!)!.state.intentId = 'another-job:another-manifest'; let publications = 0;
  f.deps.publication = { async advance() { publications++; return 'published'; } };
  await runJob(f.job, f.lease, f.deps, new AbortController().signal);
  expect(f.job.state).toBe('needs_attention'); expect(publications).toBe(0);
});

test('resume refuses publication without persisted successful validation evidence', async () => {
  const f = await fixture(); f.deps.publication = { async advance() { return 'waiting_quota'; } };
  await runJob(f.job, f.lease, f.deps, new AbortController().signal);
  delete f.snapshots.get(f.job.checkpointId!)!.state.validation; let publications = 0;
  f.deps.publication = { async advance() { publications++; return 'published'; } };
  await runJob(f.job, f.lease, f.deps, new AbortController().signal);
  expect(f.job.state).toBe('needs_attention'); expect(publications).toBe(0);
});
