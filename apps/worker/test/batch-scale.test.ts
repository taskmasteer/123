import { createHash } from 'node:crypto';
import { LocalImportResources } from '../../../packages/adapters/src/import-resources.js';
import { it, expect } from 'vitest';
import { mkdtemp, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError } from '../../../packages/contracts/src/model.js';
import { openLocalDatabase } from '../../../packages/adapters/src/local-database.js';
import { LocalBatches } from '../../../packages/adapters/src/local-batches.js';
import { createLocalState } from '../../../packages/adapters/src/local-state.js';
import { createLocalQueue } from '../../../packages/adapters/src/local-queue.js';
import { createLocalRevisions } from '../../../packages/adapters/src/local-revisions.js';
import { createLocalArtifacts } from '../../../packages/adapters/src/local-artifacts.js';
import { FakeModel } from '../../../packages/adapters/src/fake-model.js';
import { FakePublication } from '../../../packages/adapters/src/fake-publication.js';
import { parseImport } from '../../../packages/core/src/import/rows.js';
import { createCheckpointStore } from '../src/checkpoints.js';
import { runJob, type WorkerDeps } from '../src/pipeline.js';
import { validateStatic } from '../src/validation/static.js';
import { site as files } from './fixtures.js';
const actor = { userId: 'owner', role: 'user' } as const, clock = { now: Date.now };
it('measures 5000 normalized records beyond the old JSON cap, complete stable pages, filters, snapshot and restart', async () => {
    await mkdir('.local-state', { recursive: true });
    const root = await mkdtemp(join(tmpdir(), 'sf-5000-'));
    let db = await openLocalDatabase(root);
    const before = process.memoryUsage(), timing: Record<string, number> = {};
    try {
        const source = Buffer.from('domain,about,mentionedUrl\n' + Array.from({ length: 5000 }, (_, i) => `site-${i}.test,${'description '.repeat(50)},https://example.com/`).join('\n'));
        expect(source.length).toBeGreaterThan(2000000);
        let t = performance.now();
        let batches = new LocalBatches(db), resources = new LocalImportResources(batches);
        const started = await resources.request(actor, 'resource.begin', { name: 'sites.csv', size: source.length, sha256: createHash('sha256').update(source).digest('hex') }) as {
            id: string;
        };
        for (let offset = 0; offset < source.length; offset += 24000)
            await resources.request(actor, 'resource.chunk', { id: started.id, index: offset / 24000, base64: source.subarray(offset, offset + 24000).toString('base64') });
        timing.uploadMs = performance.now() - t;
        t = performance.now();
        const prepared = await resources.request(actor, 'import.prepare', { id: started.id }) as {
            revision: number;
        };
        timing.prepareMs = performance.now() - t;
        t = performance.now();
        const committed = await resources.request(actor, 'import.commit', { id: started.id, revision: prepared.revision, requestKey: 'scale-5000' }) as {
            batchId: string;
        };
        timing.commitMs = performance.now() - t;
        expect(db.sql.prepare('select count(*) n from sites').get()!.n).toBe(25);
        await db.close();
        t = performance.now();
        db = await openLocalDatabase(root);
        timing.partialReopenMs = performance.now() - t;
        batches = new LocalBatches(db);
        t = performance.now();
        let maxAdmissionChunkMs = 0;
        while (Number(db.sql.prepare('select count(*) n from sites').get()!.n) < 5000) {
            const step = performance.now();
            await batches.admit(actor, committed.batchId, 25);
            maxAdmissionChunkMs = Math.max(maxAdmissionChunkMs, performance.now() - step);
        }
        timing.admissionContinuationMs = performance.now() - t;
        timing.maxAdmissionChunkMs = maxAdmissionChunkMs;
        const batch = { siteIds: batches.rows(committed.batchId).flatMap(r => r.siteId ? [r.siteId] : []) };
        expect(new Set(batch.siteIds).size).toBe(5000);
        const sites = await createLocalState(root, clock, db), seen: string[] = [];
        let cursor: string | undefined;
        t = performance.now();
        do {
            const page = await sites.list(actor, cursor, 100);
            expect(page.items.length).toBeLessThanOrEqual(100);
            seen.push(...page.items.map(s => s.id));
            cursor = page.nextCursor ?? undefined;
        } while (cursor);
        timing.pagesMs = performance.now() - t;
        expect(seen).toEqual(batch.siteIds);
        const filtered = await sites.list(actor, undefined, 2, { domain: 'site-1' });
        expect(filtered.items.every(s => s.domain.includes('site-1'))).toBe(true);
        await expect(sites.list(actor, filtered.nextCursor!, 2, { domain: 'site-2' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        const snapshot = await db.snapshot(join(root, 'snapshot'));
        const restored = await openLocalDatabase(join(root, 'snapshot'));
        expect(restored.sql.prepare('select count(*) n from sites').get()!.n).toBe(5000);
        await restored.close();
        await sites.close();
        await db.close();
        t = performance.now();
        db = await openLocalDatabase(root);
        timing.reopenMs = performance.now() - t;
        const reopened = await createLocalState(root, clock, db);
        expect((await reopened.list(actor, undefined, 100)).items.map(s => s.id)).toEqual(seen.slice(0, 100));
        await reopened.close();
        const disk = await stat(join(root, 'factory.sqlite'));
        await writeFile('.local-state/task-10-registry-measurement.json', JSON.stringify({ records: 5000, sourceBytes: source.length, sqliteBytes: disk.size, ...timing, heapDeltaBytes: process.memoryUsage().heapUsed - before.heapUsed, rssBytes: process.memoryUsage().rss, snapshotRoots: snapshot.immutableRoots }));
    }
    finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
}, 120000);
it('runs 100 fake generation jobs with two workers, persisted pause/resume and isolated row failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-100-')), db = await openLocalDatabase(root), sites = await createLocalState(root, clock, db), queue = await createLocalQueue(root, clock, db), b = new LocalBatches(db);
    const t = performance.now();
    try {
        const batch = await b.submitBatch(actor, Array.from({ length: 100 }, (_, i) => ({ mentionedUrl: 'https://example.com/', rowNumber: i + 2, domain: `fake-${i}.test` })), 'fake100');
        const model = new FakeModel(), deps: WorkerDeps = { sites, queue, clock, revisions: await createLocalRevisions(root, db), artifacts: await createLocalArtifacts(join(root, 'artifacts')), checkpoints: await createCheckpointStore(join(root, 'checkpoints'), clock), model: { async run(request, tools, signal) {
                    if (request.site.domain === 'fake-13.test')
                        throw new AppError('NEEDS_ATTENTION', 'Injected per-row failure');
                    return model.run(request, tools, signal);
                } }, publication: new FakePublication(), workspace: join(root, 'attempts'), templates: { async load() { return files(); } }, validate: async (f) => validateStatic(f) };
        const claims = await Promise.all([queue.claim('worker-a'), queue.claim('worker-b')]);
        await b.pauseBatch(actor, batch.batchId);
        await Promise.all(claims.map(c => runJob(c!.job, c!.lease, deps, new AbortController().signal)));
        expect(await queue.claim('worker-a')).toBeNull();
        expect((await queue.get(claims[0]!.job.id))!.state).toBe('paused');
        await b.resumeBatch(actor, batch.batchId);
        const worker = async (id: string) => {
            while (true) {
                const claim = await queue.claim(id);
                if (!claim)
                    return;
                await runJob(claim.job, claim.lease, deps, new AbortController().signal);
            }
        };
        await Promise.all([worker('worker-a'), worker('worker-b')]);
        const states = db.sql.prepare('select state,count(*) n from jobs group by state').all();
        expect(states).toContainEqual({ state: 'completed', n: 99 });
        expect(states).toContainEqual({ state: 'needs_attention', n: 1 });
        expect(db.sql.prepare('select count(distinct id) n from sites').get()!.n).toBe(100);
        await writeFile('.local-state/task-10-fake-jobs-measurement.json', JSON.stringify({ jobs: 100, workers: 2, elapsedMs: performance.now() - t, states, rssBytes: process.memoryUsage().rss }));
    }
    finally {
        await queue.close();
        await sites.close();
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
}, 120000);
