import { PostgresRestorePreparation } from '../../packages/adapters/src/postgres-restore-preparation.js';
import { PostgresRetention } from '../../packages/adapters/src/postgres-retention.js';import { createLocalQueue } from '../../packages/adapters/src/local-queue.js';
import { createCheckpointStore } from '../../packages/adapters/src/local-checkpoints.js';
import { readRecoveryRecord } from '../../packages/adapters/src/recovery-records.js';
import { cp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { portableArchive } from '../../packages/adapters/src/backup-archive.js';
import { LocalBackup } from '../../packages/adapters/src/local-backup.js';
import { openLocalDatabase } from '../../packages/adapters/src/local-database.js';
import { createLocalArtifacts } from '../../packages/adapters/src/local-artifacts.js';
import { createLocalState } from '../../packages/adapters/src/local-state.js';
import { createLocalRevisions } from '../../packages/adapters/src/local-revisions.js';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { database, seedUsers, identities } from './database.js';
import { SupabaseRepository } from '../../packages/adapters/src/supabase-repository.js';
import { PostgresQueue } from '../../packages/adapters/src/postgres-queue.js';
import { R2Store, type ObjectTransport } from '../../packages/adapters/src/r2-store.js';
import { PostgresBackup } from '../../packages/adapters/src/postgres-backup.js';
import { projectCheckpoint } from '../../packages/core/src/usage.js';
import { manifestHash, publisherPolicyVersion, digest, publisherConfiguration } from '../../packages/core/src/publication.js';
import { appendInstalledCatalog } from './recovery-fixture.js';
class BackupStorage implements ObjectTransport {
    objects = new Map<string, {
        bytes: Uint8Array;
        mediaType: string;
    }>();
    async signPut(key: string) { return 'https://fixture.r2.cloudflarestorage.com/' + key; }
    async put(key: string, bytes: Uint8Array, mediaType: string) {
        if (this.objects.has(key))
            throw new Error('Immutable');
        this.objects.set(key, { bytes: Uint8Array.from(bytes), mediaType });
    }
    async head(key: string) { const f = this.objects.get(key)!; return { size: f.bytes.length, mediaType: f.mediaType }; }
    async get(key: string) { return this.objects.get(key)!.bytes; }
}
it('keeps the maximum original, object, verified and metadata ordinals disjoint safe bigints', async () => {
    const pool = await database();
    await seedUsers(pool);
    const repo = new SupabaseRepository(pool), store = new R2Store(repo, new BackupStorage(), new PostgresQueue(repo)), actor = { userId: identities.admin, role: 'admin' as const }, backup = new PostgresBackup(repo, store, async (id) => ({ id, email: 'verified@example.test' }));
    try {
        const header = { type: 'header' as const, version: 1 as const, adapter: 'managed' as const, schema: 8 as const, sourceId: randomUUID(), createdAt: 1 }, restore = await backup.beginRestore(actor, header, [{ sourceId: actor.userId, destinationId: actor.userId }], 1000000), bytes = Buffer.from('x');
        await backup.stageRecord(actor, restore.id, 999999, { type: 'file', root: 'object', path: 'private/artifacts/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/files/0', payload: 'payloads/999999.bin', size: 1, sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'application/octet-stream' });
        await backup.stageChunk(actor, restore.id, 999999, 0, bytes.toString('base64'));
        expect((await pool.query('select seq::text seq from private.recovery_snapshot_records where snapshot_id=$1 and seq>=1000000000', [restore.id])).rows.map(r => r.seq)).toEqual(['2999998000']);
        await backup.finishObject(actor, restore.id, 999999);
        const row = { type: 'row', table: 'private.audit', row: { id: randomUUID(), actor_id: actor.userId, action: 'namespace', target_id: randomUUID() } };
        await backup.stageMetadataChunk(actor, restore.id, 999998, 0, Buffer.from(JSON.stringify(row)).toString('base64'));
        expect((await pool.query('select seq::text seq from private.recovery_snapshot_records where snapshot_id=$1 and seq>=4000000000 order by seq', [restore.id])).rows.map(r => r.seq)).toEqual(['4000999999', '5099999800']);
        await backup.finishMetadata(actor, restore.id, 999998);
        expect((await pool.query('select data from private.recovery_snapshot_records where snapshot_id=$1 and seq=999998', [restore.id])).rows[0].data).toEqual(row);
        await expect(backup.stageChunk(actor, restore.id, 1000000, 0, 'eA==')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        await expect(backup.stageMetadataChunk(actor, restore.id, 1000000, 0, 'eA==')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        await backup.close(actor, restore.id);
    }
    finally {
        await pool.end();
    }
});
it('materializes an actual consistent 5000-record managed metadata snapshot in bounded resource records', async () => {
    const pool = await database();
    await seedUsers(pool);
    const repo = new SupabaseRepository(pool), queue = new PostgresQueue(repo), store = new R2Store(repo, new BackupStorage(), queue), backup = new PostgresBackup(repo, store), actor = { userId: identities.admin, role: 'admin' as const };
    try {
        await repo.transaction(tx => tx.query("insert into public.sites(id,domain,owner_id,input) select gen_random_uuid(),'volume-'||n||'.example',$1,jsonb_build_object('domain','volume-'||n||'.example') from generate_series(1,5000) n", [actor.userId]));
        const worker = randomUUID();
        await repo.transaction(tx => tx.query("insert into private.workers(id,name,token_hash) values($1,'excluded hash',$2)", [worker, 'f'.repeat(64)]));
        const admission = await repo.acquire(actor, (await pool.query('select id from public.sites limit 1')).rows[0].id), snapshot = await backup.beginSnapshot(actor);
        const second = await backup.beginSnapshot(actor);
        expect(second.records).toBe(snapshot.records);
        expect((await pool.query("select 1 from private.recovery_snapshot_records where snapshot_id=$1 and (data->>'table' in ('private.recovery_snapshots','private.recovery_snapshot_records','private.payload_pins') or data::text like $2 or data::text like $3) limit 1", [second.id, '%' + snapshot.id + '%', '%' + 'f'.repeat(64) + '%'])).rowCount).toBe(0);
        expect((await pool.query("select 1 from private.recovery_snapshot_records where snapshot_id=$1 and data->>'table'='private.site_operations' and data#>>'{row,kind}'='controller'", [second.id])).rowCount).toBe(0);
        await backup.close(actor, second.id);
        await repo.release(admission);
        expect(snapshot.records).toBeGreaterThanOrEqual(5000);
        expect((await pool.query("select count(*) n from private.recovery_snapshot_records where snapshot_id=$1 and data->>'table'='public.sites'", [snapshot.id])).rows[0].n).toBe('5000');
        const record = await backup.record(actor, snapshot.id, snapshot.records - 1, 0);
        expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThan(64000);
        await backup.close(actor, snapshot.id);
    }
    finally {
        await pool.end();
    }
});
it('creates an independent authenticated encrypted copy and rejects wrong password/tampering before extraction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'backup-'));
    try {
        const archive = portableArchive(root), bytes = Buffer.from('private original bytes');
        let originalAvailable = true;
        const path = await archive.create('correct password', (async function* () {
            yield { name: 'payloads/000000.bin', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), read: async () => {
                    if (!originalAvailable)
                        throw new Error('Original unavailable');
                    return bytes;
                } };
        })());
        originalAvailable = false;
        expect((await readFile(path)).includes(bytes)).toBe(false);
        await expect(archive.verify(path, 'incorrect password')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        const restored = await archive.verify(path, 'correct password');
        expect(restored.entries).toHaveLength(1);
        expect(await readFile(restored.entries.at(0)!.file)).toEqual(bytes);
        const altered = await readFile(path);
        altered[altered.length - 1]! ^= 1;
        await writeFile(join(root, 'changed.sfbak'), altered);
        await expect(archive.verify(join(root, 'changed.sfbak'), 'correct password')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
it('stages a managed independent copy with remapped verified Auth and keeps terminal jobs/provider evidence quarantined', async () => {
    let pool = await database();
    await seedUsers(pool);
    let repo = new SupabaseRepository(pool), queue = new PostgresQueue(repo);
    const originalStorage = new BackupStorage(), store = new R2Store(repo, originalStorage, queue), actor = { userId: identities.admin, role: 'admin' as const }, worker = randomUUID();
    await pool.query("insert into private.workers(id,name,token_hash) values($1,'backup worker',$2)", [worker, 'b'.repeat(64)]);
    const site = await repo.create({ domain: 'managed-recovery.example' }, actor), claim = (await queue.claim(worker))!, manifest = await store.put(site.id, [{ path: 'index.html', mediaType: 'text/html', bytes: Buffer.from('independent managed original') }], '1'), revision = { id: randomUUID(), siteId: site.id, parentId: null, manifestId: manifest.id, kind: 'published', createdAt: 10 };
    const checkpointFiles = [{ path: 'snapshot.html', mediaType: 'text/html', bytes: Buffer.from('Private checkpoint source file') }];
    const state = { schema: 1, jobId: site.id, siteId: site.id, baseRevision: 0, revisionId: revision.id, manifestId: manifest.id, revisionCreatedAt: 10, parentRevisionId: null, selection: { seed: 1, styleId: 'editorial', templateVersion: '1.0.0' }, validation: { ok: true, issues: [], screenshotIds: [] }, transcript: [{ inputTokens: 5, outputTokens: 3 }], modelIdentity: 'demo' }, cp = await store.save({ ...claim.job, stage: 'completed' }, claim.lease, state, checkpointFiles), sourceCheckpoint = (await pool.query('select metadata from private.checkpoints where id=$1', [cp.id])).rows[0].metadata;
    const sourceFileKey = sourceCheckpoint.manifest.files[0].objectKey, sourceStateKey = sourceCheckpoint.state.objectKey;
    await queue.checkpoint(claim.lease, cp, null, projectCheckpoint(cp, state, checkpointFiles, null));
    await queue.finish(claim.lease, 'completed');
    const publication = randomUUID();
    await repo.transaction(async (tx) => { await tx.query('insert into public.revisions values($1,$2,null,$3,$4,$5)', [revision.id, site.id, manifest.id, 'published', 10]); await tx.query('update public.sites set published_id=$2,revision=1 where id=$1', [site.id, revision.id]); await tx.query("insert into private.publication_reservations(id,site_id,request_key,binding,origin_controller_id,resolution) values($1,$2,$5,$3,$4,'settled')", [publication, site.id, { revisionId: revision.id, manifestId: manifest.id, expectedRevision: 0 }, randomUUID(), publication]); await tx.query("insert into private.provider_accounts(id) values('team_fixture')"); await tx.query("insert into private.provider_publications(id,site_id,revision_id,manifest_id,manifest_hash,account_id,phase,settlement,verified_at,evidence,data) values($1,$2,$3,$4,$5,'team_fixture','published','settled',100,$6,$7)", [publication, site.id, revision.id, manifest.id, manifestHash(manifest), { verifiedAt: 100, providerTarget: 'historical' }, { revision, policyVersion: publisherPolicyVersion, policyHash: digest(publisherConfiguration.bytes) }]); });
    const legacyIds: string[] = [], legacyManifests: string[] = [];
    let lastLegacyRevision = revision.id;
    for (let i = 0; i < 8; i++) {
        const m = await store.put(site.id, [{ path: 'index.html', mediaType: 'text/html', bytes: Buffer.from('Legacy tied output ' + i) }], '1.0.0'), rev = randomUUID(), id = randomUUID();
        legacyIds.push(id);
        legacyManifests.push(m.id);
        await repo.transaction(async (tx) => { await tx.query("select set_config('site_factory.restore_import','1',true)"); await tx.query("insert into public.revisions values($1,$2,$3,$4,'published',100)", [rev, site.id, lastLegacyRevision, m.id]); await tx.query("insert into private.publication_reservations(id,site_id,request_key,binding,origin_controller_id,resolution) values($1::uuid,$2,$1::text,$3,$4,'settled')", [id, site.id, { revisionId: rev, manifestId: m.id, expectedRevision: i + 1 }, randomUUID()]); await tx.query("insert into private.provider_publications(id,site_id,revision_id,manifest_id,manifest_hash,account_id,phase,settlement,verified_at,data) values($1,$2,$3,$4,$5,'team_fixture','published','settled',100,'{}')", [id, site.id, rev, m.id, manifestHash(m)]); });
        lastLegacyRevision = rev;
    }
    await repo.transaction(tx => tx.query('update public.sites set published_id=$2,revision=9 where id=$1', [site.id, lastLegacyRevision]));
    expect((await pool.query('select count(*) n from private.provider_publications where id=any($1::uuid[]) and settled_seq is null and settled_at is null', [legacyIds])).rows[0].n).toBe('8');
    const source = new PostgresBackup(repo, store), snapshot = await source.beginSnapshot(actor), records: {
        seq: number;
        data: any;
    }[] = [], objects = new Map<number, Uint8Array>();
    for (let seq = 0; seq < snapshot.records; seq++) {
        const record = await source.record(actor, snapshot.id, seq, 0), data = JSON.parse(Buffer.from(record.base64, 'base64').toString('utf8'));
        records.push({ seq, data });
        if (data.type === 'file')
            objects.set(seq, Buffer.from((await source.resource(actor, snapshot.id, seq, 0)).base64, 'base64'));
    }
    await appendInstalledCatalog(records, objects, true);
    expect(JSON.stringify(records)).not.toContain('b'.repeat(64));
    await pool.end();
    originalStorage.objects.clear();
    pool = await database();
    await seedUsers(pool);
    const destination = randomUUID();
    await pool.query('insert into auth.users values($1)', [destination]);
    await pool.query("insert into public.users values($1,'destination@example.test')", [destination]);
    await pool.query("insert into public.memberships values($1,'admin',true)", [destination]);
    repo = new SupabaseRepository(pool);
    queue = new PostgresQueue(repo);
    const targetStorage = new BackupStorage(), targetStore = new R2Store(repo, targetStorage, queue), admin = { userId: destination, role: 'admin' as const }, target = new PostgresBackup(repo, targetStore, async (id) => {
        const row = (await pool.query('select id,email from public.users where id=$1', [id])).rows[0];
        if (!row)
            throw new Error('unverified');
        return row;
    });
    try {
        await expect(target.beginRestore(admin, { type: 'header', version: 1, adapter: 'local', schema: 8, sourceId: 'x', createdAt: 1 }, [], 1)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        const begun = await target.beginRestore(admin, records[0]!.data, [{ sourceId: identities.user, destinationId: identities.user }, { sourceId: identities.spec, destinationId: identities.spec }, { sourceId: identities.admin, destinationId: destination }], records.length);
        for (const r of records)
            await target.stageRecord(admin, begun.id, r.seq, r.data);
        await expect(target.install(admin, begun.id)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        expect((await pool.query('select count(*) n from public.sites')).rows[0].n).toBe('0');
        for (const [seq, bytes] of objects) {
            await target.stageChunk(admin, begun.id, seq, 0, Buffer.from(bytes).toString('base64'));
            await target.finishObject(admin, begun.id, seq);
        }
        const originalQuery = pool.query.bind(pool),preparationPrototype=PostgresRestorePreparation.prototype as any,originalPreparationQuery=preparationPrototype.query;
        let lookups = 0;
        preparationPrototype.query = (async function(this:PostgresRestorePreparation,sql: any, params: any[]) { if (String(sql).includes("data->>'source'=any") && Array.isArray(params?.[1]) && params[1].includes(sourceFileKey) && ++lookups === 1)
            throw new Error('deliberate checkpoint remap failure'); return originalPreparationQuery.call(this,sql, params); });
        try {
            await expect(target.install(admin, begun.id)).rejects.toThrow('deliberate checkpoint remap failure');
            expect((await originalQuery('select count(*) n from public.sites')).rows[0].n).toBe('0');
        }
        finally {
            preparationPrototype.query = originalPreparationQuery;
        }
        let entered!: () => void, release!: () => void, released = false, earlyState = false;
        const enteredRemap = new Promise<void>(r => entered = r), hold = new Promise<void>(r => release = r);
        lookups = 0;
        preparationPrototype.query = (async function(this:PostgresRestorePreparation,sql: any, params: any[]) { if (String(sql).includes("data->>'source'=any")) {
            if (Array.isArray(params?.[1]) && params[1].includes(sourceFileKey) && ++lookups === 1) {
                entered();
                await hold;
            }
            if (params?.[1] === sourceStateKey && lookups === 1 && !released)
                earlyState = true;
        } return originalPreparationQuery.call(this,sql, params); });
        const installing = target.install(admin, begun.id);
        let report: Awaited<typeof installing>;
        try {
            await enteredRemap;
            expect(earlyState).toBe(false);
        }
        finally {
            released = true;
            release();
            try {
                report = await installing;
            }
            finally {
                preparationPrototype.query = originalPreparationQuery;
            }
        }
        expect(Buffer.from((await targetStore.load(cp.id)).files[0]!.bytes)).toEqual(Buffer.from(checkpointFiles[0]!.bytes));
        expect((await pool.query('select metadata from private.checkpoints where id=$1', [cp.id])).rows[0].metadata.manifest.files[0].objectKey).not.toBe(sourceFileKey);
        expect(report).toMatchObject({ restoredSites: 1, restoredRevisions: 9, quarantined: true });
        expect((await repo.get(site.id))!.ownerId).toBe(destination);
        expect((await pool.query('select count(*) n from private.provider_publications where id=any($1::uuid[]) and settled_seq is null and settled_at is null and verified_at=100', [legacyIds])).rows[0].n).toBe('8');
        await repo.transaction(async (tx) => { await tx.query("select set_config('site_factory.restore','1',true)"); await tx.query('update private.provider_publications set cancel_requested=false where id=any($1::uuid[])', [legacyIds]); });
        expect((await pool.query('select count(*) n from private.provider_publications where id=any($1::uuid[]) and settled_seq is null and settled_at is null', [legacyIds])).rows[0].n).toBe('8');
        const legacyRetention = new PostgresRetention(repo, targetStorage as any), later = Date.now() + 33 * 86400000;
        expect((await legacyRetention.planCleanup(later)).deletableManifestIds).toEqual([]);
        expect((await legacyRetention.planCleanup(later + 86400001)).deletableManifestIds).toEqual([]);
        for (const id of legacyManifests)
            expect((await targetStore.read(id)).length).toBe(1);
        expect((await pool.query('select data,worker_id,expires_at from private.jobs where id=$1', [site.id])).rows[0]).toMatchObject({ data: { state: 'completed' }, worker_id: null, expires_at: null });
        expect((await pool.query('select token_hash,revoked_at from private.workers where id=$1', [worker])).rows[0].token_hash).not.toBe('b'.repeat(64));
        expect((await targetStore.read(manifest.id))[0]!.bytes).toEqual(new Uint8Array(Buffer.from('independent managed original')));
        expect(manifestHash((await pool.query('select manifest from private.artifacts where id=$1', [manifest.id])).rows[0].manifest)).toBe(manifestHash(manifest));
        expect((await pool.query('select manifest_hash,evidence from private.provider_publications where id=$1', [publication])).rows[0]).toMatchObject({ manifest_hash: manifestHash(manifest), evidence: { providerTarget: 'historical' } });
    }
    finally {
        await pool.end();
    }
});
it('restores one site and history into a fresh independent root with terminal work intact and active work quarantined', async () => {
    const root = await mkdtemp(join(tmpdir(), 'local-backup-')), source = join(root, 'source'), target = join(root, 'restored'), work = join(root, 'exports');
    await mkdir(join(source, 'templates'), { recursive: true });
    await mkdir(join(source, 'references'));
    await writeFile(join(source, 'templates', 'catalog.json'), '[]');
    await writeFile(join(source, 'references', 'catalog.json'), '[]');
    const data = join(root, 'data'), db = await openLocalDatabase(data), admin = { userId: 'local-demo-admin', role: 'admin' as const };
    try {
        const sites = await createLocalState(join(data, 'sites'), { now: () => 1 }, db), site = await sites.create({ domain: 'recovered.example' }, admin), artifacts = await createLocalArtifacts(join(data, 'artifacts')), revisions = await createLocalRevisions(data, db);
        for (let i = 0; i < 2; i++) {
            const manifest = await artifacts.put(site.id, [{ path: 'index.html', mediaType: 'text/html', bytes: Buffer.from('version' + i) }], '1'), revision = { id: randomUUID(), siteId: site.id, parentId: null, manifestId: manifest.id, kind: 'published' as const, createdAt: i };
            await revisions.put(revision);
            if (i === 0) {
                await sites.compareAndSet(site.id, i, { publishedId: revision.id });
                const id = randomUUID();
                db.sql.prepare('insert into publication_outcomes values(?,?,?)').run(id, site.id, JSON.stringify({ id, siteId: site.id, revisionId: revision.id, manifestId: manifest.id, sequence: 199, settledAt: i, verifiedAt: null, settlement: 'settled', origin: 'generation', mode: 'demo' }));
            }
            else
                await sites.settlePublication!(site.id, i, { publishedId: revision.id }, { id: randomUUID(), siteId: site.id, revisionId: revision.id, manifestId: manifest.id, settledAt: i, verifiedAt: null, settlement: 'settled', origin: 'generation', mode: 'demo' });
        }
        const savedSite = (await sites.get(site.id))!;
        const backup = new LocalBackup(db, source, work), archive = await backup.createBackup(admin, 'independent password');
        await rm(join(data, 'artifacts'), { recursive: true, force: true });
        const report = await backup.restoreBackup(admin, archive, 'independent password', target);
        expect(report).toMatchObject({ restoredSites: 1, restoredRevisions: 2, quarantined: true });
        const restored = await openLocalDatabase(target);
        try {
            expect(restored.sql.prepare('select count(*) n from publication_outcomes').get()?.n).toBe(2);
            expect(restored.sql.prepare("select key from recovery_state where key='quarantine'").get()?.key).toBe('quarantine');
            const revision = JSON.parse(String(restored.sql.prepare("select data from records where id=?").get(savedSite.publishedId!)!.data));
            expect((await (await createLocalArtifacts(join(target, 'artifacts'))).read(revision.manifestId))[0]!.bytes).toEqual(new Uint8Array(Buffer.from('version1')));
            expect(JSON.parse(String(restored.sql.prepare('select data from publication_outcomes order by rowid desc limit 1').get()!.data)).sequence).toBe(200);
            restored.transaction(() => restored.sql.prepare("delete from recovery_state where key='quarantine'").run());
            const liveSites = await createLocalState(join(target, 'sites'), { now: () => 99 }, restored), liveArtifacts = await createLocalArtifacts(join(target, 'artifacts')), liveRevisions = await createLocalRevisions(target, restored), manifest = await liveArtifacts.put(site.id, [{ path: 'index.html', mediaType: 'text/html', bytes: Buffer.from('fresh after independent restore') }], '1'), next = { id: randomUUID(), siteId: site.id, parentId: revision.id, manifestId: manifest.id, kind: 'published' as const, createdAt: 99 }, outcome = randomUUID();
            await liveRevisions.put(next);
            await liveSites.settlePublication!(site.id, 2, { publishedId: next.id }, { id: outcome, siteId: site.id, revisionId: next.id, manifestId: manifest.id, settledAt: 99, verifiedAt: null, settlement: 'settled', origin: 'rollback', mode: 'demo' });
            expect(JSON.parse(String(restored.sql.prepare('select data from publication_outcomes where id=?').get(outcome)!.data)).sequence).toBe(201);
            await liveSites.close();
        }
        finally {
            await restored.close();
        }
    }
    finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});
it('rejects unavailable exact local retained template versions during backup and staged restore without changing the active root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'local-catalog-recovery-')), source = join(root, 'installed');
    await mkdir(source);
    await cp(resolve('templates'), join(source, 'templates'), { recursive: true });
    await cp(resolve('references'), join(source, 'references'), { recursive: true });
    const db = await openLocalDatabase(join(root, 'data')), clock = { now: Date.now }, sites = await createLocalState(join(db.root, 'sites'), clock, db), queue = await createLocalQueue(db.root, clock, db), checkpoints = await createCheckpointStore(join(db.root, 'checkpoints'), clock), admin = { userId: 'local-demo-admin', role: 'admin' as const };
    try {
        const site = await sites.create({ domain: 'pinned-catalog.test' }, admin);
        await queue.enqueue({ id: site.id, siteId: site.id, kind: 'generate', stage: 'generate', state: 'queued', checkpointId: null, baseRevision: 0 });
        const claim = (await queue.claim('fixture'))!, state = { jobId: site.id, siteId: site.id, manifestId: null, selection: { styleId: 'editorial', templateVersion: '1.0.0', seed: 1 } }, checkpoint = await checkpoints.save(claim.job, claim.lease, state, []);
        await queue.checkpoint(claim.lease, checkpoint, null, projectCheckpoint(checkpoint, state, [], null));
        await queue.finish(claim.lease, 'paused');
        const backup = new LocalBackup(db, source, join(root, 'exports')), path = await backup.createBackup(admin, 'catalog recovery password'), verified = await portableArchive(join(root, 'verify')).verify(path, 'catalog recovery password');
        const changed = (bytes: Uint8Array) => { const styles = JSON.parse(Buffer.from(bytes).toString()); styles.find((s: any) => s.id === 'editorial').version = '9.0.0'; return Buffer.from(JSON.stringify(styles)); };
        async function* forged() { let ordinal = 0; for (const entry of verified.entries) {
            if (!entry.name.startsWith('records/'))
                continue;
            const record = await readRecoveryRecord(entry);
            let payload: Uint8Array | undefined;
            if (record.type === 'file') {
                let match;
                for (const candidate of verified.entries)
                    if (candidate.name === record.payload) {
                        match = candidate;
                        break;
                    }
                payload = await readFile(match!.file);
                if (record.root === 'catalog' && record.path === 'templates/catalog.json') {
                    payload = changed(payload);
                    record.size = payload.length;
                    record.sha256 = createHash('sha256').update(payload).digest('hex');
                }
            }
            const bytes = Buffer.from(JSON.stringify(record));
            yield { name: 'records/' + ordinal++ + '.json', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), read: async () => bytes };
            if (record.type === 'file') {
                const bytes = payload!;
                yield { name: record.payload, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), read: async () => bytes };
            }
        } }
        const invalid = await portableArchive(join(root, 'forged')).create('catalog recovery password', forged());
        await expect(backup.restoreBackup(admin, invalid, 'catalog recovery password', join(root, 'invalid-target'))).rejects.toMatchObject({ code: 'NEEDS_ATTENTION' });
        expect((await sites.get(site.id))!.revision).toBe(0);
        await expect(readFile(join(root, 'invalid-target', 'factory.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
        await writeFile(join(source, 'templates', 'catalog.json'), changed(await readFile(join(source, 'templates', 'catalog.json'))));
        await expect(backup.createBackup(admin, 'catalog recovery password')).rejects.toMatchObject({ code: 'NEEDS_ATTENTION' });
        expect((await queue.get(site.id))!.state).toBe('paused');
        await rm(verified.directory, { recursive: true, force: true });
    }
    finally {
        await queue.close();
        await sites.close();
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
}, 30000);
