import { expect, it } from 'vitest';
import { database, seedUsers, identities } from './database.js';
import { SupabaseRepository } from '../../packages/adapters/src/supabase-repository.js';
import { PostgresQueue } from '../../packages/adapters/src/postgres-queue.js';
import { R2Store, type ObjectTransport } from '../../packages/adapters/src/r2-store.js';
import { PostgresRetention } from '../../packages/adapters/src/postgres-retention.js';
import { PostgresBackup } from '../../packages/adapters/src/postgres-backup.js';
import { createApp } from '../../apps/control/src/app.js';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { registerPostgresPayload } from '../../packages/adapters/src/postgres-retention.js';
import { projectCheckpoint } from '../../packages/core/src/usage.js';
import { PostgresPublication } from '../../packages/adapters/src/postgres-publication.js';
import { VercelClient } from '../../packages/adapters/src/vercel/client.js';
class HistoryObjects implements ObjectTransport {
    objects = new Map<string, {
        bytes: Uint8Array;
        mediaType: string;
    }>();
    async signPut(key: string) { return 'https://fixture.test/' + key; }
    async put(key: string, bytes: Uint8Array, mediaType: string) { this.objects.set(key, { bytes, mediaType }); }
    async get(key: string) { return this.objects.get(key)!.bytes; }
    async head(key: string) { const f = this.objects.get(key)!; return { size: f.bytes.length, mediaType: f.mediaType }; }
    async delete(key: string) { this.objects.delete(key); }
}
it('protects an unknown checkpoint subject reached only from a durable read pin', async () => {
    const pool = await database();
    await seedUsers(pool);
    const repo = new SupabaseRepository(pool), store = new R2Store(repo, new HistoryObjects(), new PostgresQueue(repo)), actor = { userId: identities.admin, role: 'admin' as const };
    try {
        const site = await repo.create({ domain: 'unknown-pin.example' }, actor), artifact = await store.put(site.id, [{ path: 'index.html', mediaType: 'text/html', bytes: Buffer.from('unknown dependency') }], '1'), checkpointId = randomUUID(), pin = randomUUID(), now = Date.now() + 32 * 86400000, collector = new PostgresRetention(repo, store.transport);
        await repo.transaction(async (tx) => { await registerPostgresPayload(tx, { kind: 'checkpoint', id: checkpointId, siteId: site.id, objects: [], accepted: false, createdAt: 1, protectUntil: 0, state: 'available', firstOrphanAt: null, claimToken: null }); await tx.query("insert into private.payload_pins values($1,'checkpoint',$2,to_timestamp($3/1000.0))", [pin, checkpointId, now + 10 * 86400000]); });
        expect((await collector.planCleanup(now)).deletableManifestIds).toEqual([]);
        expect((await collector.planCleanup(now + 86400000)).deletableManifestIds).toEqual([]);
        await repo.transaction(tx => tx.query('delete from private.payload_pins where id=$1', [pin]));
        expect((await collector.planCleanup(now + 2 * 86400000)).deletableManifestIds).toEqual([]);
        expect((await collector.planCleanup(now + 3 * 86400000)).deletableManifestIds).toEqual([artifact.id]);
    }
    finally {
        await pool.end();
    }
});
it('takes the shared writer fence before row locks and excludes collectors across connections', async () => {
    const pool = await database();
    await seedUsers(pool);
    const repo = new SupabaseRepository(pool);
    try {
        await repo.transaction(async (tx) => {
            const locks = (await tx.query("select mode from pg_locks where pid=pg_backend_pid() and locktype='advisory'")).rows;
            expect(locks).toContainEqual({ mode: 'ShareLock' });
        });
        let release!: () => void;
        const barrier = new Promise<void>(r => release = r), entered: number[] = [];
        const siteIds = [randomUUID(), randomUUID()];
        const writers = siteIds.map(siteId => repo.transaction(async (tx) => { await tx.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [siteId]); entered.push(1); await barrier; }));
        try {
            await expect.poll(() => entered.length).toBe(2);
            expect(entered).toHaveLength(2);
            let collected = false;
            const collector = repo.transaction(async () => { collected = true; }, 'exclusive');
            await expect.poll(async () => !!(await pool.query("select 1 from pg_locks where locktype='advisory' and classid=73212 and objid=1 and not granted")).rowCount).toBe(true);
            expect(collected).toBe(false);
            release();
            await Promise.all(writers);
            await collector;
            expect(collected).toBe(true);
        }
        finally {
            release();
            await Promise.allSettled(writers);
        }
    }
    finally {
        await pool.end();
    }
});
it('backfills upgraded managed accepted ancestry and immutable evidence outside locks while preserving latest per-job usage', async () => {
    const pool = await database();
    await seedUsers(pool);
    const repo = new SupabaseRepository(pool), queue = new PostgresQueue(repo), objects = new HistoryObjects(), store = new R2Store(repo, objects, queue), site = await repo.create({ domain: 'legacy-chain.example' }, { userId: identities.admin, role: 'admin' }), worker = randomUUID();
    try {
        await pool.query("insert into private.workers(id,name,token_hash) values($1,'legacy worker',$2)", [worker, 'e'.repeat(64)]);
        const claim = (await queue.claim(worker))!, ids: string[] = [];
        let previous: string | null = null;
        for (let i = 1; i <= 3; i++) {
            const state = { jobId: site.id, siteId: site.id, manifestId: null, transcript: [{ inputTokens: i, outputTokens: i }], continuation: { inputTokens: i * 10, outputTokens: i * 5 } }, checkpoint = await store.save({ ...claim.job, stage: i === 3 ? 'completed' : 'generate', checkpointId: previous }, claim.lease, state, []);
            await queue.checkpoint(claim.lease, checkpoint, previous);
            ids.push(checkpoint.id);
            previous = checkpoint.id;
        }
        const orphan = await store.save({ ...claim.job, checkpointId: previous }, claim.lease, { jobId: site.id, siteId: site.id, manifestId: null }, []);
        await queue.finish(claim.lease, 'completed');
        await repo.transaction(tx => tx.query('delete from private.payload_inventory'));
        const original = objects.get.bind(objects);
        objects.get = async (key) => { expect(Number((await pool.query("select count(*) n from pg_locks where locktype='advisory' and classid=73212 and objid=1 and granted")).rows[0].n)).toBe(0); return original(key); };
        const retention = new PostgresRetention(repo, objects);
        await retention.backfill(store);
        expect((await pool.query('select count(*) n from private.checkpoint_evidence')).rows[0].n).toBe('3');
        expect((await pool.query('select data from private.job_usage where job_id=$1', [site.id])).rows[0].data).toMatchObject({ checkpointId: ids[2], inputTokens: 33, outputTokens: 18 });
        expect((await pool.query("select data->>'accepted' accepted from private.payload_inventory where kind='checkpoint' and id=$1", [orphan.id])).rows[0].accepted).toBe('false');
        const later = Date.now() + 32 * 86400000;
        await retention.collect(later);
        await retention.collect(later + 86400001);
        expect((await pool.query("select count(*) n from private.payload_inventory where kind='checkpoint' and state='deleted'")).rows[0].n).toBe('4');
        expect((await pool.query('select count(*) n from private.checkpoints')).rows[0].n).toBe('4');
        expect((await pool.query('select data from private.job_usage where job_id=$1', [site.id])).rows[0].data.inputTokens).toBe(33);
    }
    finally {
        await pool.end();
    }
});
it('roots the exact current installed catalog and active/retained versions while collecting superseded unreferenced bundles', async () => {
    const pool = await database();
    await seedUsers(pool);
    const repo = new SupabaseRepository(pool), queue = new PostgresQueue(repo), objects = new HistoryObjects(), store = new R2Store(repo, objects, queue), actor = { userId: identities.admin, role: 'admin' as const }, site = await repo.create({ domain: 'catalog-roots.example' }, actor), worker = randomUUID();
    try {
        await pool.query("insert into private.workers(id,name,token_hash) values($1,'catalog worker',$2)", [worker, 'd'.repeat(64)]);
        const claim = (await queue.claim(worker))!, manifest = await store.put(site.id, [{ path: 'index.html', mediaType: 'text/html', bytes: Buffer.from('<h1>catalog history</h1>') }], '1.0.0'), revision = randomUUID(), state = { jobId: site.id, siteId: site.id, manifestId: manifest.id, selection: { seed: 1, styleId: 'editorial', templateVersion: '1.0.0' } }, checkpoint = await store.save({ ...claim.job, stage: 'completed' }, claim.lease, state, []);
        await queue.checkpoint(claim.lease, checkpoint, null, projectCheckpoint(checkpoint, state, [], null));
        await queue.finish(claim.lease, 'completed');
        // Simulate two verified server installation transitions; neither a snapshot nor worker state owns this pointer.
        for (const version of ['1.0.0', '2.0.0']) {
            const id = 'bundle-' + version, key = 'private/catalog/' + id + '/index', bytes = Buffer.from(version);
            await objects.put(key, bytes, 'application/json');
            await repo.transaction(async (tx) => { await registerPostgresPayload(tx, { kind: 'catalog', id, siteId: null, objects: [{ key, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'application/json' }], createdAt: 1, protectUntil: 0, state: 'available', firstOrphanAt: null, claimToken: null }); await tx.query("insert into private.payload_edges values('catalog',$1,'retained','catalog',$2)", ['editorial@' + version, id]); await tx.query("insert into private.recovery_state values('installed-catalog',$1) on conflict(key) do update set data=excluded.data", [{ versions: ['editorial@' + version] }]); });
        }
        await repo.transaction(async (tx) => { await tx.query("insert into public.revisions values($1,$2,null,$3,'published',1)", [revision, site.id, manifest.id]); await tx.query('update public.sites set published_id=$2 where id=$1', [site.id, revision]); });
        const retention = new PostgresRetention(repo, objects), later = Date.now() + 32 * 86400000;
        await retention.collect(later);
        await retention.collect(later + 86400001);
        expect(objects.objects.has('private/catalog/bundle-1.0.0/index')).toBe(true);
        expect(objects.objects.has('private/catalog/bundle-2.0.0/index')).toBe(true);
        const backup = new PostgresBackup(repo, store), snapshot = await backup.beginSnapshot(actor);
        await repo.transaction(tx => tx.query('update private.payload_pins set expires_at=to_timestamp($2/1000.0) where id=$1', [snapshot.id, later + 10 * 86400000]));
        expect((await pool.query("select data from private.recovery_state where key='installed-catalog'")).rows[0].data).toEqual({ versions: ['editorial@2.0.0'] });
        await expect(queue.checkpoint(claim.lease, checkpoint, null, projectCheckpoint(checkpoint, state, [], null))).rejects.toMatchObject({ code: 'STALE_LEASE' });
        await repo.transaction(tx => tx.query('update public.sites set published_id=null where id=$1', [site.id]));
        await retention.collect(later + 2 * 86400000);
        expect(objects.objects.has('private/catalog/bundle-1.0.0/index')).toBe(true);
        await backup.close(actor, snapshot.id);
        await retention.collect(later + 3 * 86400000);
        await retention.collect(later + 4 * 86400000 + 1);
        expect(objects.objects.has('private/catalog/bundle-1.0.0/index')).toBe(false);
        expect(objects.objects.has('private/catalog/bundle-2.0.0/index')).toBe(true);
    }
    finally {
        await pool.end();
    }
});
it('retains six settled actions at tied external times, protects export/unattached intent roots, and exposes original source only to fresh admins', async () => {
    const pool = await database();
    await seedUsers(pool);
    const repo = new SupabaseRepository(pool), queue = new PostgresQueue(repo), objects = new HistoryObjects(), store = new R2Store(repo, objects, queue), admin = { userId: identities.admin, role: 'admin' as const }, site = await repo.create({ domain: 'eight-outcomes.example' }, admin), backup = new PostgresBackup(repo, store), retention = new PostgresRetention(repo, objects), revisions: string[] = [], manifests: string[] = [], actions: string[] = [];
    try {
        await pool.query("update private.jobs set data=jsonb_set(data,'{state}','\"completed\"') where id=$1", [site.id]);
        await pool.query("insert into private.provider_accounts(id) values('history_fixture')");
        for (let i = 0; i < 8; i++) {
            const m = await store.put(site.id, [{ path: 'index.html', mediaType: 'text/html', bytes: Buffer.from('<h1>Original ' + i + '</h1>') }], '1'), revision = randomUUID(), action = randomUUID();
            revisions.push(revision);
            manifests.push(m.id);
            actions.push(action);
            await repo.transaction(async (tx) => { await tx.query("insert into public.revisions values($1,$2,$3,$4,'published',$5)", [revision, site.id, revisions[i - 1] ?? null, m.id, i]); await tx.query("insert into private.publication_reservations(id,site_id,request_key,binding,origin_controller_id,resolution) values($1::uuid,$2,$1::text,$3,$4,'settled')", [action, site.id, { revisionId: revision, manifestId: m.id, expectedRevision: i }, randomUUID()]); await tx.query("insert into private.provider_publications(id,site_id,revision_id,manifest_id,manifest_hash,account_id,phase,settlement,verified_at,data) values($1,$2,$3,$4,$5,'history_fixture','published','settled',100,'{}')", [action, site.id, revision, m.id, 'a'.repeat(64)]); });
        }
        await pool.query('update public.sites set published_id=$2,revision=8 where id=$1', [site.id, revisions[7]]);
        const exported = await backup.exportSite(admin, site.id, revisions[1]!), unattached = randomUUID();
        await repo.transaction(tx => tx.query('insert into private.publication_reservations(id,site_id,request_key,binding,origin_controller_id) values($1::uuid,$2,$1::text,$3,$4)', [unattached, site.id, { revisionId: revisions[0], manifestId: manifests[0], expectedRevision: 8 }, randomUUID()]));
        const now = Date.now() + 700000;
        expect((await retention.planCleanup(now)).deletableManifestIds).toEqual([]);
        const app = createApp({ repository: repo, queue, store, backup, auth: { verifyUser: async (token) => ({ userId: token === 'admin' ? identities.admin : token === 'spec' ? identities.spec : identities.user, role: token === 'admin' ? 'admin' : token === 'spec' ? 'spec-user' : 'user' }), verifyWorker: async () => { throw new Error('unused'); } } }), request = (path: string, token = 'admin') => app(new Request('https://control.test' + path, { headers: { authorization: 'Bearer ' + token } }));
        const history = await (await request(`/sites/${site.id}/history`)).json();
        expect(history.items.filter((o: any) => o.retained).map((o: any) => o.id)).toEqual(actions.slice(2).reverse());
        expect(history.items.filter((o: any) => o.current)).toHaveLength(1);
        expect(history.items[0].verifiedAt).toBe(100);
        expect(history.items[0].sequence).toBeGreaterThan(history.items[1].sequence);
        for (const token of ['spec', 'user']) {
            await pool.query('insert into public.assignments values($1,$2) on conflict do nothing', [site.id, token === 'spec' ? identities.spec : identities.user]);
            expect((await request(`/sites/${site.id}/source?revisionId=${revisions[7]}`, token)).status).toBe(403);
            expect((await request('/admin/recovery/status', token)).status).toBe(403);
        }
        const tree = await (await request(`/sites/${site.id}/source?revisionId=${revisions[7]}`)).json();
        expect(tree.files).toEqual([{ path: 'index.html', size: 19 }]);
        expect((await request(`/sites/${site.id}/source/file?revisionId=${revisions[7]}&path=../private`)).status).toBe(400);
        await backup.close(admin, exported.id);
        await repo.transaction(tx => tx.query("update private.publication_reservations set resolution='cancelled' where id=$1", [unattached]));
        await retention.planCleanup(now);
        expect((await retention.planCleanup(now + 86400001)).deletableManifestIds.sort()).toEqual(manifests.slice(0, 2).sort());
        await retention.collect(now + 86400001);
        await expect(store.read(manifests[0]!)).rejects.toMatchObject({ code: 'CONFLICT' });
        expect((await pool.query('select count(*) n from public.revisions')).rows[0].n).toBe('8');
        let calls = 0;
        const publisher = new PostgresPublication(queue, store, new VercelClient({ token: 'fixture', accountId: 'team_history', fetch: async () => { calls++; throw new Error('no provider calls during admission'); } }), async () => ({ verifiedAt: Date.now() })), key = randomUUID(), rollback = await publisher.requestPublication(admin, site.id, revisions[3]!, 8, key, 'rollback');
        expect(rollback.origin).toBe('rollback');
        expect((await pool.query('select data from private.deployments where id=$1', [key])).rows[0].data).toMatchObject({ selection: 'rollback', state: 'pending', revisionId: revisions[3] });
        expect((await pool.query('select binding from private.publication_reservations where id=$1', [rollback.id])).rows[0].binding.selection).toBe('rollback');
        expect((await repo.get(site.id))!.publishedId).toBe(revisions[7]);
        expect((await pool.query('select count(*) n from private.edit_requests')).rows[0].n).toBe('0');
        expect(calls).toBe(0);
    }
    finally {
        await pool.end();
    }
});
it('rejects a new revision pointing at tombstoned bytes without weakening immutable ancestry', async () => {
    const pool = await database();
    await seedUsers(pool);
    const repo = new SupabaseRepository(pool), actor = { userId: identities.admin, role: 'admin' as const };
    try {
        const site = await repo.create({ domain: 'history.example' }, actor), id = '44444444-4444-4444-8444-444444444444';
        await pool.query('insert into private.artifacts values($1,$2,$3,true)', [id, site.id, { id, siteId: site.id, files: [], templateVersion: '1', createdAt: 1 }]);
        await repo.transaction(tx => tx.query("insert into private.payload_inventory values('artifact',$1,$2,'{}','claimed',1,gen_random_uuid())", [id, site.id]));
        await expect(repo.transaction(tx => tx.query("insert into public.revisions values(gen_random_uuid(),$1,null,$2,'published',1)", [site.id, id]))).rejects.toMatchObject({ code: 'CONFLICT' });
        expect((await pool.query('select count(*) from private.artifacts')).rows[0].count).toBe('1');
    }
    finally {
        await pool.end();
    }
});
