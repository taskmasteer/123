import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { Job, Lease } from '../../../packages/contracts/src/model.js';
import { createLocalQueue } from '../../../packages/adapters/src/local-queue.js';
import { createLocalCatalog } from '../../../packages/adapters/src/local-catalog.js';
import { FakePublication } from '../../../packages/adapters/src/fake-publication.js';
import { createLocalRevisions } from '../../../packages/adapters/src/local-revisions.js';
import { createLocalState } from '../../../packages/adapters/src/local-state.js';
import { createLocalArtifacts } from '../../../packages/adapters/src/local-artifacts.js';
import { FakeModel } from '../../../packages/adapters/src/fake-model.js';
import { runJob } from '../src/pipeline.js';
import { validateStatic } from '../src/validation/static.js';
import { createCheckpointStore } from '../src/checkpoints.js';
import { ManualClock } from '../../../packages/testing/src/clock.js';
import { cleanDirectories, directory, site } from './fixtures.js';

afterEach(cleanDirectories);
const clock = () => new ManualClock(1000);
const job = (siteId: string = randomUUID()): Job => ({ id: randomUUID(), siteId, kind: 'generate', stage: 'brief', state: 'queued', baseRevision: 0, checkpointId: null });
const admin = { userId: 'administrator', role: 'admin' } as const;

test('queue survives restart, fences expired workers and serializes each site', async () => {
  const root = await directory(); const time = clock(); let queue = await createLocalQueue(root, time);
  const first = job(); const second = job(first.siteId); await queue.enqueue(first); await queue.enqueue(second);
  const claim = await queue.claim('worker-a'); expect(claim).not.toBeNull();
  expect(await queue.claim('worker-b')).toBeNull();
  await queue.close(); queue = await createLocalQueue(root, time);
  expect((await queue.get(first.id))!.state).toBe('running');
  time.advanceBy(120001); const recovered = await queue.claim('worker-b');
  expect(recovered!.job.id).toBe(first.id); expect(recovered!.lease.generation).toBe(2);
  await expect(queue.finish(claim!.lease, 'completed')).rejects.toMatchObject({ code: 'STALE_LEASE' });
  await queue.finish(recovered!.lease, 'completed'); expect((await queue.claim('worker-b'))!.job.id).toBe(second.id); await queue.close();
});

test('queue bounds a device to two active jobs and supports explicit retry', async () => {
  const queue = await createLocalQueue(await directory(), clock());
  const jobs = [job(), job(), job()]; for (const item of jobs) await queue.enqueue(item);
  const first = await queue.claim('device'); expect(first).not.toBeNull();
  expect(await queue.claim('device')).not.toBeNull(); expect(await queue.claim('device')).toBeNull();
  await queue.finish(first!.lease, 'waiting_provider'); await queue.retry(first!.job.id);
  expect((await queue.claim('device'))!.job.id).toBe(first!.job.id); await queue.close();
});

test('a persisted running job without a lease is rejected on reopen', async () => {
  const root = await directory(); const queue = await createLocalQueue(root, clock()); await queue.close();
  await writeFile(join(root, 'queue.json'), JSON.stringify({ version: 1, entries: [{ job: { ...job(), state: 'running' }, generation: 1, lease: null }] }));
  await expect(createLocalQueue(root, clock())).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});

test('checkpoint metadata and file bytes survive a fresh store instance', async () => {
  const root = await directory(); const time = clock(); const store = await createCheckpointStore(root, time); const item = job();
  const lease: Lease = { jobId: item.id, workerId: 'device', generation: 1, expiresAt: 121000 };
  const checkpoint = await store.save({ ...item, stage: 'generate' }, lease, { secretBrief: 'private prompt', siteId: item.siteId }, site());
  const reopened = await createCheckpointStore(root, time); const loaded = await reopened.load(checkpoint.id);
  expect(loaded.state).toEqual({ secretBrief: 'private prompt', siteId: item.siteId });
  expect(loaded.files).toEqual(site()); expect(loaded.checkpoint.jobId).toBe(item.id);
  await expect(reopened.load('../outside')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  time.advanceBy(120001); await expect(store.save(item, lease, {}, [])).rejects.toMatchObject({ code: 'STALE_LEASE' });
});

test('five jobs get different pinned styles and admin disabling affects only new jobs', async () => {
  const root = await directory(); let catalog = await createLocalCatalog(process.cwd(), root);
  const jobs: Job[] = []; for (let index = 0; index < 5; index++) jobs.push(await catalog.prepare(job(), index, 123));
  expect(new Set(jobs.map((item) => item.generation?.styleId)).size).toBe(5);
  const selected = jobs[0]!.generation!;
  await catalog.updateStyle(admin, selected.styleId, false);
  catalog = await createLocalCatalog(process.cwd(), root);
  expect((await catalog.prepare(job(), 0, 123)).generation!.styleId).not.toBe(selected.styleId);
  expect((await catalog.prepare(jobs[0]!, 0, 999)).generation).toEqual(selected);
  expect((await catalog.load(selected.styleId, selected.templateVersion)).length).toBeGreaterThanOrEqual(2);
  await expect(catalog.load(selected.styleId, 'missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

test('catalog exposes source metadata, rejects non-admin writes and persists descriptions', async () => {
  const root = await directory(); const catalog = await createLocalCatalog(process.cwd(), root);
  const listing = await catalog.list(); expect(listing.references.length).toBe(14);
  const reference = listing.references[0]!;
  await expect(catalog.updateStyle({ userId: 'member', role: 'spec-user' }, 'editorial', false)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await catalog.updateReference(admin, reference.id, 'Use the composition with original local illustrations.');
  const next = await createLocalCatalog(process.cwd(), root);
  expect((await next.list()).references.find((entry) => entry.id === reference.id)!.description).toBe('Use the composition with original local illustrations.');
  await expect(next.prepare(job(), 0, 0, 'unknown')).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

test('fake publication explicitly reports demo status and is idempotently published', async () => {
  const publication = new FakePublication();
  expect(await publication.advance('stable-intent')).toBe('published');
  expect(await publication.advance('stable-intent')).toBe('published');
  expect(publication.runtimeStatus).toEqual({ mode: 'demo', realHosting: false });
});

test('revision records survive restart, are immutable and reject a parent from another site', async () => {
  const root = await directory(); const revisions = await createLocalRevisions(root);
  const revision = { id: randomUUID(), siteId: randomUUID(), parentId: null, manifestId: randomUUID(), kind: 'published' as const, createdAt: 1000 };
  await revisions.put(revision); const reopened = await createLocalRevisions(root);
  expect(await reopened.get(revision.id)).toEqual(revision);
  await reopened.put(revision);
  await expect(reopened.put({ ...revision, manifestId: randomUUID() })).rejects.toMatchObject({ code: 'CONFLICT' });
  await expect(reopened.put({ ...revision, id: randomUUID(), siteId: randomUUID(), parentId: revision.id })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});

test('real local queue, checkpoints and revision indirection resume after all adapters reopen', async () => {
  const root = await directory(); const time = clock();
  let sites = await createLocalState(join(root, 'sites'), time); let queue = await createLocalQueue(join(root, 'queue'), time);
  const created = await sites.create({ domain: 'restart.example', about: 'Readable event processing for small teams' }, admin);
  const catalog = await createLocalCatalog(process.cwd(), join(root, 'catalog'));
  const planned = await catalog.prepare(job(created.id), 0, 3); await queue.enqueue(planned);
  const claim = (await queue.claim('device'))!;
  const checkpoints = await createCheckpointStore(join(root, 'checkpoints'), time);
  const artifacts = await createLocalArtifacts(join(root, 'artifacts'), time);
  const revisions = await createLocalRevisions(join(root, 'revisions'));
  await runJob(claim.job, claim.lease, { queue, sites, checkpoints, artifacts, revisions, clock: time, model: new FakeModel(),
    publication: { async advance() { return 'waiting_quota'; } }, templates: catalog, workspace: join(root, 'work'), validate: async (files) => validateStatic(files) }, new AbortController().signal);
  const waiting = (await queue.get(planned.id))!; expect(waiting.state).toBe('waiting_provider');
  const saved = await checkpoints.load(waiting.checkpointId!);
  expect(saved.state.selection).toEqual(planned.generation);
  expect(await revisions.get(saved.state.revisionId as string)).toBeNull();
  await queue.close(); await sites.close();
  queue = await createLocalQueue(join(root, 'queue'), time); sites = await createLocalState(join(root, 'sites'), time);
  const reopenedCheckpoints = await createCheckpointStore(join(root, 'checkpoints'), time);
  const reopenedRevisions = await createLocalRevisions(join(root, 'revisions'));
  await catalog.updateStyle(admin, planned.generation!.styleId, false);
  await queue.retry(planned.id); const resumed = (await queue.claim('new-device'))!;
  await runJob(resumed.job, resumed.lease, { queue, sites, checkpoints: reopenedCheckpoints, artifacts, revisions: reopenedRevisions, clock: time,
    model: { async run() { throw new Error('Must not regenerate a persisted archive'); } }, publication: new FakePublication(),
    templates: { async load() { throw new Error('Must not reload disabled template'); } }, workspace: join(root, 'reopened-work'),
    validate: async () => { throw new Error('Must reuse completed validation'); } }, new AbortController().signal);
  expect((await queue.get(planned.id))!.state).toBe('completed');
  const publishedSite = (await sites.get(created.id))!; expect(publishedSite.publishedId).toBe(saved.state.revisionId);
  const published = await reopenedRevisions.get(publishedSite.publishedId!);
  expect(published!.manifestId).toBe(saved.state.manifestId);
  expect((await artifacts.read(published!.manifestId)).map((file) => file.path).sort()).toEqual(['assets/network.svg', 'index.html', 'styles.css']);
  const completed = await reopenedCheckpoints.load((await queue.get(planned.id))!.checkpointId!);
  expect(completed.state.intentId).toBe(saved.state.intentId);
  expect(completed.state.brief).toBe(saved.state.brief);
  await queue.close(); await sites.close();
});
