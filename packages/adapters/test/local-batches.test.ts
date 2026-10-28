import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalDatabase } from '../src/local-database.js';
import { LocalBatches } from '../src/local-batches.js';
import { createLocalQueue } from '../src/local-queue.js';
import { createLocalState } from '../src/local-state.js';
const owner = { userId: 'owner', role: 'user' } as const;
it('binds request keys to canonical rows, retains errors and isolates existing domain failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-batch-')), db = await openLocalDatabase(root), b = new LocalBatches(db);
    try {
        const rows = [{ rowNumber: 2, domain: 'пример.рф', about: 'Exact one-row about' }, { rowNumber: 3, domain: 'xn--e1afmkfd.xn--p1ai' }, { rowNumber: 4, domain: '' }, { rowNumber: 5, domain: 'next.test' }];
        const first = await b.submitBatch(owner, rows, 'request-1');
        expect(first.siteIds).toHaveLength(2);
        expect(await b.submitBatch(owner, rows, 'request-1')).toEqual(first);
        await expect(b.submitBatch(owner, [{ rowNumber: 2, domain: 'changed.test' }], 'request-1')).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(db.sql.prepare('select count(*) n from sites').get()!.n).toBe(2);
        expect((await b.page(owner, first.batchId)).items).toHaveLength(4);
        const conflict = await b.submitBatch(owner, [{ rowNumber: 2, domain: 'next.test' }, { rowNumber: 3, domain: 'other.test' }], 'request-2');
        expect(conflict.siteIds).toHaveLength(1);
        expect((await b.page(owner, conflict.batchId)).items[0]!.issues[0]!.code).toBe('DUPLICATE_DOMAIN');
    }
    finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});
it('keeps direct grants separate from batch scope through worker CAS and fences cancelled writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-local-grants-')), db = await openLocalDatabase(root), b = new LocalBatches(db), q = await createLocalQueue(root, { now: () => 1000 }, db), sites = await createLocalState(root, { now: () => 1000 }, db), admin = { userId: 'admin', role: 'admin' } as const;
    try {
        const batch = await b.submitBatch(owner, [{ rowNumber: 2, domain: 'grants.test' }], 'grants'), siteId = batch.siteIds[0]!;
        await sites.compareAndSet(siteId, 0, { assignedUserIds: ['direct'] });
        await expect(b.get({ userId: 'direct', role: 'spec-user' }, batch.batchId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await b.assign(admin, batch.batchId, ['assigned']);
        expect((await sites.get(siteId))!.assignedUserIds.sort()).toEqual(['assigned', 'direct']);
        const claim = (await q.claim('worker'))!;
        await sites.workerCompareAndSet(siteId, 1, { generationStatus: 'running' }, claim.lease);
        await b.assign(admin, batch.batchId, []);
        expect((await sites.get(siteId))!.assignedUserIds).toEqual(['direct']);
        await b.cancelBatch(owner, batch.batchId);
        await expect(sites.workerCompareAndSet(siteId, 2, { publishedId: 'must-not-install' }, claim.lease)).rejects.toMatchObject({ code: 'STALE_LEASE' });
        expect((await sites.get(siteId))!.publishedId).toBeNull();
    }
    finally {
        await q.close();
        await sites.close();
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});
it('pauses at stage boundaries, resumes only paused work and fences cancelled generation without touching later edits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-pause-')), db = await openLocalDatabase(root), b = new LocalBatches(db), q = await createLocalQueue(root, { now: () => 1000 }, db);
    try {
        const batch = await b.submitBatch(owner, [{ rowNumber: 2, domain: 'a.test' }, { rowNumber: 3, domain: 'b.test' }], 'key');
        const claim = (await q.claim('worker'))!;
        await b.pauseBatch(owner, batch.batchId);
        expect(await q.claim('second')).toBeNull();
        expect(await q.pauseAtBoundary!(claim.lease)).toBe(true);
        await b.resumeBatch(owner, batch.batchId);
        const resumed = (await q.claim('worker'))!;
        await q.finish(resumed.lease, 'needs_attention');
        await b.pauseBatch(owner, batch.batchId);
        await b.resumeBatch(owner, batch.batchId);
        expect((await q.get(resumed.job.id))!.state).toBe('needs_attention');
        await expect(b.cancelBatch({ userId: 'assigned', role: 'spec-user' }, batch.batchId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await b.cancelBatch(owner, batch.batchId);
        expect(await q.claim('worker')).toBeNull();
    }
    finally {
        await q.close();
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});
