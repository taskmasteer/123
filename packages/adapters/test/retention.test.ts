import { expect, it } from 'vitest';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openLocalDatabase } from '../src/local-database.js';
import { createLocalArtifacts } from '../src/local-artifacts.js';
import { LocalRetention } from '../src/local-retention.js';
import { registerLocalPayload } from '../src/retention-schema.js';
import { orphanGraceMs } from '../../core/src/retention.js';
import { createCheckpointStore } from '../src/local-checkpoints.js';
import { createLocalQueue } from '../src/local-queue.js';
import { createLocalState } from '../src/local-state.js';
it('keeps subject closure conservative for an unknown checkpoint protected only by a read pin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'retention-pin-')), db = await openLocalDatabase(root), siteId = randomUUID(), checkpointId = randomUUID(), now = Date.now() + 32 * orphanGraceMs;
    try {
        const store = await createLocalArtifacts(join(root, 'artifacts'), { now: () => 1 }), artifact = await store.put(siteId, [{ path: 'index.html', mediaType: 'text/html', bytes: Buffer.from('unknown dependency') }], '1'), collector = new LocalRetention(db);
        db.transaction(() => { registerLocalPayload(db.sql, { kind: 'checkpoint', id: checkpointId, siteId, objects: [], accepted: false, createdAt: 1, protectUntil: 0, state: 'available', firstOrphanAt: null, claimToken: null }); db.sql.prepare('insert into payload_pins values(?,?,?,?)').run('unknown-read', 'checkpoint', checkpointId, now + 10 * orphanGraceMs); });
        expect((await collector.planCleanup(now)).deletableManifestIds).toEqual([]);
        expect((await collector.planCleanup(now + orphanGraceMs)).deletableManifestIds).toEqual([]);
        db.sql.prepare('delete from payload_pins where id=?').run('unknown-read');
        expect((await collector.planCleanup(now + 2 * orphanGraceMs)).deletableManifestIds).toEqual([]);
        expect((await collector.planCleanup(now + 3 * orphanGraceMs)).deletableManifestIds).toEqual([artifact.id]);
    }
    finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});
it('collects only two of eight settled output states after grace and fences a stale new reference', async () => {
    const root = await mkdtemp(join(tmpdir(), 'retention-')), db = await openLocalDatabase(root);
    let now = 0;
    try {
        const siteId = randomUUID(), store = await createLocalArtifacts(join(root, 'artifacts'), { now: () => now }), manifests: import('../../contracts/src/model.js').Manifest[] = [];
        for (let i = 0; i < 8; i++) {
            const m = await store.put(siteId, [{ path: 'index.html', mediaType: 'text/html', bytes: Buffer.from(String(i)) }], '1');
            manifests.push(m);
            db.sql.prepare('insert into records values(?,?,?,?)').run('revisions', 'r' + i, siteId, JSON.stringify({ id: 'r' + i, siteId, manifestId: m.id, parentId: i ? 'r' + (i - 1) : null, kind: 'published', createdAt: i }));
            db.sql.prepare('insert into publication_outcomes values(?,?,?)').run('o' + i, siteId, JSON.stringify({ id: 'o' + i, siteId, revisionId: 'r' + i, manifestId: m.id, settledAt: i, verifiedAt: null, settlement: 'settled', origin: 'draft', mode: 'demo' }));
        }
        const site = { id: siteId, domain: 'retention.example', ownerId: 'admin', assignedUserIds: [], input: { domain: 'retention.example' }, revision: 8, publishedId: 'r7', draftId: null, generationStatus: 'completed', domainStatus: 'demo' };
        db.sql.prepare('insert into sites(id,domain,owner_id,status,data) values(?,?,?,?,?)').run(siteId, site.domain, 'admin', 'completed', JSON.stringify(site));
        const collector = new LocalRetention(db);
        now = 700000;
        expect((await collector.planCleanup(now)).deletableManifestIds).toEqual([]);
        now += orphanGraceMs;
        expect((await collector.planCleanup(now)).deletableManifestIds.sort()).toEqual(manifests.slice(0, 2).map(m => m.id).sort());
        await collector.collect(now);
        await expect(store.read(manifests[0]!.id)).rejects.toMatchObject({ code: 'CONFLICT' });
        await expect(store.read(manifests[7]!.id)).resolves.toHaveLength(1);
        expect(db.sql.prepare("select count(*) n from records where kind='revisions'").get()?.n).toBe(8);
        await expect(access(join(root, 'artifacts', 'manifests', manifests[0]!.id, 'manifest.json'))).resolves.toBeUndefined();
        expect(() => db.transaction(() => registerLocalPayload(db.sql, { kind: 'artifact', id: manifests[0]!.id, siteId, objects: [], createdAt: 0, protectUntil: 0, state: 'available', firstOrphanAt: null, claimToken: null }))).toThrow();
    }
    finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});
it('records missing legacy coverage for its subject while unrelated orphan collection can proceed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legacy-missing-')), db = await openLocalDatabase(root), base = Date.now(), clock = { now: () => base }, sites = await createLocalState(join(root, 'sites'), clock, db), queue = await createLocalQueue(root, clock, db), store = await createCheckpointStore(join(root, 'checkpoints'), clock), artifacts = await createLocalArtifacts(join(root, 'artifacts'), clock), actor = { userId: 'admin', role: 'admin' as const };
    try {
        const broken = await sites.create({ domain: 'broken-subject.test' }, actor), other = await sites.create({ domain: 'other-subject.test' }, actor);
        await queue.enqueue({ id: broken.id, siteId: broken.id, kind: 'generate', stage: 'generate', state: 'queued', checkpointId: null, baseRevision: 0 });
        const claimed = (await queue.claim('worker'))!, checkpoint = await store.save(claimed.job, claimed.lease, { jobId: broken.id, siteId: broken.id, manifestId: null }, []);
        await queue.checkpoint(claimed.lease, checkpoint);
        await queue.finish(claimed.lease, 'needs_attention');
        const own = await artifacts.put(broken.id, [{ path: 'index.html', mediaType: 'text/html', bytes: Buffer.from('own') }], '1'), orphan = await artifacts.put(other.id, [{ path: 'index.html', mediaType: 'text/html', bytes: Buffer.from('other') }], '1');
        await rm(join(root, 'checkpoints', checkpoint.id + '.json'));
        const retention = new LocalRetention(db);
        await retention.backfill(store, false);
        expect(db.sql.prepare('select key from recovery_state where key=?').get('legacy-coverage:checkpoint:' + checkpoint.id)).toBeTruthy();
        await expect(retention.backfill(store)).rejects.toMatchObject({ code: 'NEEDS_ATTENTION' });
        await retention.collect(base + 32 * orphanGraceMs);
        await retention.collect(base + 33 * orphanGraceMs + 1);
        await expect(artifacts.read(orphan.id)).rejects.toMatchObject({ code: 'CONFLICT' });
        await expect(artifacts.read(own.id)).resolves.toHaveLength(1);
    }
    finally {
        await queue.close();
        await sites.close();
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});
it('backfills legacy current/recovery proofs without overwriting latest usage and prunes an acceptance-unknown envelope only after30days and grace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legacy-retention-')), db = await openLocalDatabase(root), base = Date.now(), clock = { now: () => base }, sites = await createLocalState(join(root, 'sites'), clock, db), queue = await createLocalQueue(root, clock, db), store = await createCheckpointStore(join(root, 'checkpoints'), clock), actor = { userId: 'admin', role: 'admin' as const };
    try {
        const site = await sites.create({ domain: 'legacy-current.test' }, actor), job = { id: site.id, siteId: site.id, kind: 'generate' as const, stage: 'generate', state: 'queued' as const, checkpointId: null, baseRevision: 0 };
        await queue.enqueue(job);
        const first = (await queue.claim('legacy-worker'))!, state = (tokens: number) => ({ jobId: job.id, siteId: site.id, manifestId: null, transcript: [{ inputTokens: tokens, outputTokens: tokens }] });
        const cp1 = await store.save(first.job, first.lease, state(10), []);
        await queue.checkpoint(first.lease, cp1);
        await queue.finish(first.lease, 'needs_attention');
        await queue.retry(job.id, { id: randomUUID(), checkpointId: cp1.id, modelIdentity: 'model:configured' });
        const second = (await queue.claim('legacy-worker'))!, cp2 = await store.save(second.job, second.lease, state(30), []);
        await queue.checkpoint(second.lease, cp2);
        const orphan = await store.save({ ...second.job, checkpointId: cp2.id }, second.lease, state(999), []);
        await queue.finish(second.lease, 'needs_attention');
        db.transaction(() => db.sql.prepare('delete from payload_inventory').run());
        const retention = new LocalRetention(db);
        await retention.backfill(store);
        expect(db.sql.prepare('select count(*) n from checkpoint_evidence').get()!.n).toBe(2);
        expect(() => db.sql.prepare('delete from checkpoint_evidence where id=?').run(cp1.id)).toThrow();
        expect(() => db.sql.prepare("update checkpoint_evidence set data='{}' where id=?").run(cp2.id)).toThrow();
        expect(JSON.parse(String(db.sql.prepare('select data from job_usage where job_id=?').get(job.id)!.data))).toMatchObject({ checkpointId: cp2.id, inputTokens: 30 });
        expect(JSON.parse(String(db.sql.prepare("select data from payload_inventory where kind='checkpoint' and id=?").get(orphan.id)!.data)).accepted).toBeUndefined();
        await retention.collect(base + 2 * orphanGraceMs);
        expect((await store.load(orphan.id)).checkpoint.id).toBe(orphan.id);
        await retention.collect(base + 32 * orphanGraceMs);
        await retention.collect(base + 33 * orphanGraceMs + 1);
        await expect(store.load(orphan.id)).rejects.toMatchObject({ code: 'CONFLICT' });
        expect((await store.load(cp1.id)).checkpoint.id).toBe(cp1.id);
        expect((await store.load(cp2.id)).checkpoint.id).toBe(cp2.id);
        expect(db.sql.prepare("select state from payload_inventory where kind='checkpoint' and id=?").get(orphan.id)!.state).toBe('deleted');
    }
    finally {
        await queue.close();
        await sites.close();
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});
