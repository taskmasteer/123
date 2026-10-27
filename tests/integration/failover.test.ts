import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { database, seedUsers, identities } from './database.js';
import { SupabaseRepository } from '../../packages/adapters/src/supabase-repository.js';
import { PostgresQueue } from '../../packages/adapters/src/postgres-queue.js';
import { R2Store, metadata, type ObjectTransport } from '../../packages/adapters/src/r2-store.js';
import { jobsRoute } from '../../apps/control/src/routes/jobs.js';
import { createApp } from '../../apps/control/src/app.js';
import { createRemoteWorker } from '../../apps/worker/src/remote-worker.js';
import { runJob, type WorkerDeps } from '../../apps/worker/src/pipeline.js';
import { FakeModel } from '../../packages/adapters/src/fake-model.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
class Storage implements ObjectTransport {
    objects = new Map<string, {
        bytes: Uint8Array;
        mediaType: string;
    }>();
    async signPut(key: string) { return 'https://fixture.r2.cloudflarestorage.com/' + key; }
    async put(key: string, bytes: Uint8Array, mediaType: string) { if (this.objects.has(key))
        throw new Error('Immutable'); this.objects.set(key, { bytes, mediaType }); }
    async head(key: string) { const f = this.objects.get(key)!; return { size: f.bytes.length, mediaType: f.mediaType }; }
    async get(key: string) { return this.objects.get(key)!.bytes; }
}
test('only committed checkpoints resume; stale generation cannot heartbeat, upload, commit, finish or CAS', async () => {
    const pool = await database();
    try {
        await seedUsers(pool);
        const repo = new SupabaseRepository(pool), queue = new PostgresQueue(repo), storage = new Storage(), store = new R2Store(repo, storage, queue);
        const site = await repo.create({ domain: 'failover.example' }, { userId: identities.admin, role: 'admin' }), a = randomUUID(), b = randomUUID();
        for (const id of [a, b])
            await pool.query("insert into private.workers(id,name,token_hash) values($1,'fixture',$2)", [id, id.replaceAll('-', '').repeat(2)]);
        const first = (await queue.claim(a))!, files = [{ path: 'index.html', mediaType: 'text/html', bytes: Buffer.from('consistent checkpoint bytes') }];
        const state = { jobId: first.job.id, siteId: site.id, continuation: { inputTokens: 13, outputTokens: 7, privateReplay: 'preserved' } };
        const checkpoint = await store.save({ ...first.job, stage: 'generate' }, first.lease, state, files);
        expect((await repo.current(site.id))!.checkpointId).toBeNull();
        await queue.checkpoint(first.lease, checkpoint, null);
        await queue.checkpoint(first.lease, checkpoint, null);
        expect((await repo.current(site.id))!.checkpointId).toBe(checkpoint.id);
        const nextJob = { ...first.job, checkpointId: checkpoint.id, stage: 'generate' };
        const unreferenced = await store.save(nextJob, first.lease, state, files);
        const orphan = await store.prepare(a, { lease: first.lease, purpose: 'artifact', templateVersion: '1', files: files.map(metadata), expectedCheckpointId: checkpoint.id });
        await storage.put(orphan.files[0]!.objectKey, files[0]!.bytes, 'text/html');
        await pool.query('update private.jobs set expires_at=clock_timestamp() where id=$1', [first.job.id]);
        await expect(queue.heartbeat({ ...first.lease, expiresAt: Date.now() + 999999 })).rejects.toMatchObject({ code: 'STALE_LEASE' });
        const second = (await new PostgresQueue(new SupabaseRepository(pool)).claim(b))!;
        expect(second.lease.generation).toBe(2);
        expect(second.job.stage).toBe('generate');
        expect(second.job.checkpointId).toBe(checkpoint.id);
        expect((await store.load(checkpoint.id)).state).toEqual(state);
        expect(Buffer.from((await store.load(checkpoint.id)).files[0]!.bytes)).toEqual(files[0]!.bytes);
        const snapshot = await jobsRoute(queue, store, b, `/worker/jobs/${second.job.id}/snapshot`, { lease: second.lease, id: checkpoint.id }) as {
            checkpoint: {
                id: string;
            };
            files: {
                path: string;
            }[];
        };
        expect(snapshot.checkpoint.id).toBe(checkpoint.id);
        expect(snapshot.files[0]!.path).toBe('index.html');
        const bytes = await jobsRoute(queue, store, b, `/worker/jobs/${second.job.id}/resource`, { lease: second.lease, id: checkpoint.id, kind: 'checkpoint', path: 'index.html' }) as Response;
        expect(Buffer.from(await bytes.arrayBuffer())).toEqual(files[0]!.bytes);
        await expect(jobsRoute(queue, store, b, `/worker/jobs/${second.job.id}/snapshot`, { lease: second.lease, id: unreferenced.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
        for (const operation of [() => queue.heartbeat(first.lease), () => queue.checkpoint(first.lease, unreferenced, checkpoint.id), () => queue.finish(first.lease, 'completed'), () => queue.compareAndSet(a, first.lease, 0, { generationStatus: 'completed' }), () => store.complete(a, orphan.uploadId, first.lease)])
            await expect(operation()).rejects.toMatchObject({ code: 'STALE_LEASE' });
        expect((await repo.get(site.id))!.revision).toBe(0);
        expect((await repo.current(site.id))!.checkpointId).toBe(checkpoint.id);
        expect((await pool.query('select 1 from private.artifacts where id=$1', [orphan.uploadId])).rowCount).toBe(0);
        await expect(queue.compareAndSet(b, second.lease, 1, { generationStatus: 'completed' })).rejects.toMatchObject({ code: 'CONFLICT' });
        const fresh = await store.save(second.job, second.lease, state, files);
        await queue.checkpoint(second.lease, fresh, checkpoint.id);
        await expect(queue.checkpoint(second.lease, checkpoint, null)).rejects.toMatchObject({ code: 'CONFLICT' });
        await queue.finish(second.lease, 'paused');
        expect(await queue.claim(a)).toBeNull();
    }
    finally {
        await pool.end();
    }
});
test('explicit authenticated provider retry binds a durable ticket to the failed checkpoint without losing usage', async () => {
    const pool = await database();
    try {
        await seedUsers(pool);
        const repo = new SupabaseRepository(pool), queue = new PostgresQueue(repo), store = new R2Store(repo, new Storage(), queue), worker = randomUUID();
        const actor = { userId: identities.admin, role: 'admin' as const };
        await pool.query("insert into private.workers(id,name,token_hash) values($1,'recovery',$2)", [worker, '8'.repeat(64)]);
        const site = await repo.create({ domain: 'provider-retry.example' }, actor), claim = (await queue.claim(worker))!;
        const continuation = { provider: 'openai-responses', version: 1, binding: 'fixture', items: [], turns: 1, retries: 2, retryAt: 0, transportExhausted: false, requestPending: false, inputTokens: 10, outputTokens: 5, uncertainRequests: 1, responseId: null, terminal: 'failed', recoverable: 'account', summary: '', seen: {} };
        const cp = await store.save({ ...claim.job, stage: 'generate' }, claim.lease, { jobId: site.id, siteId: site.id, baseRevision: 0, continuation }, []);
        await queue.checkpoint(claim.lease, cp, null);
        await queue.finish(claim.lease, 'needs_attention');
        const app = createApp({ repository: repo, queue, store, auth: { verifyUser: async () => actor, verifyWorker: async () => ({ workerId: worker }) } });
        const session = await app(new Request('https://control.test/session', { headers: { authorization: 'Bearer fixture' } }));
        expect((await session.json()).capabilities).toMatchObject({ generation: true, publish: false, export: false });
        const response = await app(new Request(`https://control.test/sites/${site.id}/jobs/retry`, { method: 'POST', headers: { authorization: 'Bearer fixture-admin', 'content-type': 'application/json' }, body: JSON.stringify({ modelIdentity: 'openai:corrected-model' }) }));
        expect(response.status).toBe(200);
        const restored = (await queue.claim(worker))!;
        expect(restored.job.checkpointId).toBe(cp.id);
        expect(restored.job.providerRecovery).toMatchObject({ checkpointId: cp.id, modelIdentity: 'openai:corrected-model' });
        expect((await store.load(cp.id)).state.continuation).toMatchObject({ inputTokens: 10, outputTokens: 5, retries: 2, uncertainRequests: 1 });
    }
    finally {
        await pool.end();
    }
});
test('controller handoff survives its finally-release and rejects changed binding', async () => {
    const pool = await database();
    try {
        await seedUsers(pool);
        const repo = new SupabaseRepository(pool), queue = new PostgresQueue(repo), actor = { userId: identities.admin, role: 'admin' as const };
        const site = await repo.create({ domain: 'controller-handoff.example' }, actor);
        await queue.cancel(site.id);
        const store = new R2Store(repo, new Storage(), queue), manifest = await store.put(site.id, [{ path: 'index.html', bytes: Buffer.from('accepted'), mediaType: 'text/html' }], '1'), revisionId = randomUUID();
        await pool.query("insert into public.revisions values($1,$2,null,$3,'candidate',1)", [revisionId, site.id, manifest.id]);
        await pool.query('update public.sites set draft_id=$2 where id=$1', [site.id, revisionId]);
        const admission = await repo.acquire(actor, site.id), binding = { revisionId, manifestId: manifest.id, expectedRevision: 0 };
        const reserved = await repo.transaction(tx => queue.reserveControllerPublication(tx, admission, 'controller-request', binding));
        expect(await repo.transaction(tx => queue.reserveControllerPublication(tx, admission, 'controller-request', binding))).toEqual(reserved);
        await expect(repo.transaction(tx => queue.reserveControllerPublication(tx, admission, 'controller-request', { ...binding, revisionId: randomUUID() }))).rejects.toMatchObject({ code: 'CONFLICT' });
        await repo.release(admission);
        expect((await pool.query('select kind,operation_id from private.site_operations where site_id=$1', [site.id])).rows[0]).toEqual({ kind: 'publication', operation_id: reserved.id });
        await expect(repo.acquire(actor, site.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    }
    finally {
        await pool.end();
    }
});
test('managed HTTP pipeline uploads matching private checkpoints and reserves publication without claiming provider success', async () => {
    const pool = await database(), root = await mkdtemp(resolve('.local-state/managed-pipeline-'));
    try {
        await seedUsers(pool);
        const repo = new SupabaseRepository(pool), queue = new PostgresQueue(repo), storage = new Storage(), store = new R2Store(repo, storage, queue), worker = randomUUID();
        await pool.query("insert into private.workers(id,name,token_hash) values($1,'managed',$2)", [worker, 'e'.repeat(64)]);
        await pool.query("insert into private.catalog values('style','editorial',$1)", [{ id: 'editorial', version: '1.0.0', enabled: true, referenceIds: [] }]);
        const actor = { userId: identities.admin, role: 'admin' as const }, site = await repo.create({ domain: 'managed-pipeline.example' }, actor);
        const app = createApp({ repository: repo, queue, store, auth: { verifyUser: async () => actor, verifyWorker: async () => ({ workerId: worker }) } });
        const transport = (async (input, init) => {
            const url = new URL(String(input));
            if (url.hostname === 'fixture.r2.cloudflarestorage.com') {
                expect(new Headers(init?.headers).has('authorization')).toBe(false);
                await storage.put(url.pathname.slice(1), new Uint8Array(await new Response(init?.body).arrayBuffer()), new Headers(init?.headers).get('content-type')!);
                return new Response(null, { status: 200 });
            }
            expect(url.origin).toBe('https://control.test');
            return app(new Request(url, init));
        }) as typeof fetch;
        const local = { clock: { now: Date.now }, workspace: join(root, 'attempts'), model: new FakeModel(), templates: { async load() { return [{ path: 'index.html', mediaType: 'text/html', bytes: Buffer.from('<html><main><h1 data-topic>Topic</h1><p data-description>Description</p></main></html>') }]; } }, validate: async () => ({ ok: true, issues: [], screenshotIds: [] }) } as unknown as WorkerDeps;
        const deps = createRemoteWorker({ controlOrigin: 'https://control.test', workerId: worker, workerToken: 'fixture-token', fetch: transport }, local), claimed = (await deps.queue.claim(worker))!;
        await runJob(claimed.job, claimed.lease, await deps.bind!(claimed.job, claimed.lease), new AbortController().signal);
        const job = (await repo.current(site.id))!;
        expect(job.state).toBe('waiting_provider');
        expect(job.stage).toBe('publication');
        expect((await repo.get(site.id))!.publishedId).toBeNull();
        const saved = await store.load(job.checkpointId!);
        expect(saved.state.manifestId).toBeTruthy();
        expect(saved.state.transcript).toHaveLength(1);
        expect((await pool.query('select binding from private.publication_reservations where origin_job_id=$1', [job.id])).rows[0].binding.checkpointId).toBe(job.checkpointId);
        const reservation = (await pool.query('select * from private.publication_reservations where origin_job_id=$1', [job.id])).rows[0];
        await expect(repo.transaction(tx => queue.settlePublicationInTransaction(tx, reservation.id, 'settled'))).rejects.toMatchObject({ code: 'CONFLICT' });
        // Task9 settlement fixture: immutable revision + pointer CAS and reservation
        // resolution share this one transaction. No provider success is asserted here.
        await repo.transaction(async (tx) => {
            await tx.query('select id from public.sites where id=$1 for update', [site.id]);
            await tx.query("insert into public.revisions values($1,$2,null,$3,'published',1)", [reservation.binding.revisionId, site.id, reservation.binding.manifestId]);
            await tx.query('update public.sites set published_id=$2,revision=1 where id=$1', [site.id, reservation.binding.revisionId]);
            await queue.settlePublicationInTransaction(tx, reservation.id, 'settled');
        });
        expect((await repo.current(site.id))!.state).toBe('completed');
        await queue.finish(claimed.lease, 'completed');
        expect((await pool.query('select 1 from private.site_operations where site_id=$1', [site.id])).rowCount).toBe(0);
    }
    finally {
        await pool.end();
        await rm(root, { recursive: true, force: true });
    }
});
test('pause stops new claims and cancellation/revocation preserve publication reservation and published content', async () => {
    const pool = await database();
    try {
        await seedUsers(pool);
        const repo = new SupabaseRepository(pool), queue = new PostgresQueue(repo), worker = randomUUID();
        await pool.query("insert into private.workers(id,name,token_hash) values($1,'fixture',$2)", [worker, 'c'.repeat(64)]);
        const site = await repo.create({ domain: 'reserved.example' }, { userId: identities.admin, role: 'admin' });
        const current = (await queue.claim(worker))!;
        await queue.pauseWorker(worker, true);
        expect(await queue.shouldPause(current.lease)).toBe(true);
        expect(await queue.claim(worker)).toBeNull();
        const storage = new Storage(), store = new R2Store(repo, storage, queue);
        const manifest = await store.put(site.id, [{ path: 'index.html', bytes: Buffer.from('published'), mediaType: 'text/html' }], '1');
        const revision = randomUUID();
        await pool.query("insert into public.revisions values($1,$2,null,$3,'published',1)", [revision, site.id, manifest.id]);
        await pool.query('update public.sites set published_id=$2 where id=$1', [site.id, revision]);
        const checkpoint = await store.save({ ...current.job, stage: 'publication' }, current.lease, { jobId: current.job.id, siteId: site.id, manifestId: manifest.id, revisionId: revision }, []);
        await queue.checkpoint(current.lease, checkpoint, null);
        const binding = { requestKey: current.job.id + ':' + manifest.id, manifestId: manifest.id, revisionId: revision, expectedRevision: 0, checkpointId: checkpoint.id };
        await expect(queue.finish(current.lease, 'completed')).rejects.toMatchObject({ code: 'CONFLICT' });
        const reservation = await queue.reservePublication(current.lease, binding);
        expect(await queue.reservePublication(current.lease, binding)).toEqual(reservation);
        const app = createApp({ repository: repo, queue, store, auth: { verifyUser: async () => ({ userId: identities.admin, role: 'admin' }), verifyWorker: async () => ({ workerId: worker }) } });
        // A lost handoff response is replayable while the same lease is live, even
        // though the admission has already transferred from job to publication.
        const replay = await app(new Request(`https://control.test/worker/jobs/${current.job.id}/publication`, { method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' }, body: JSON.stringify({ lease: current.lease, binding }) }));
        expect(replay.status).toBe(200);
        expect(await replay.json()).toEqual({ id: reservation.id, state: 'pending' });
        await queue.cancel(current.job.id);
        await queue.revokeWorker(worker);
        expect((await repo.get(site.id))!.publishedId).toBe(revision);
        expect((await pool.query('select kind,operation_id from private.site_operations where site_id=$1', [site.id])).rows[0]).toEqual({ kind: 'publication', operation_id: reservation.id });
        await expect(repo.acquire({ userId: identities.admin, role: 'admin' }, site.id)).rejects.toMatchObject({ code: 'CONFLICT' });
        expect((await repo.current(site.id))!.state).toBe('cancelled');
        expect((await store.load(checkpoint.id)).state.manifestId).toBe(manifest.id);
    }
    finally {
        await pool.end();
    }
});
test('authority waits for locks before checking expiry and rejects a revocation racing checkpoint commit', async () => {
    const pool = await database();
    try {
        await seedUsers(pool);
        const repo = new SupabaseRepository(pool), queue = new PostgresQueue(repo), worker = randomUUID();
        await pool.query("insert into private.workers(id,name,token_hash) values($1,'race',$2)", [worker, 'f'.repeat(64)]);
        const site = await repo.create({ domain: 'locked-race.example' }, { userId: identities.admin, role: 'admin' }), first = (await queue.claim(worker))!;
        const gate = await pool.connect(), contender = await pool.connect();
        try {
            await gate.query('begin');
            await gate.query('select id from public.sites where id=$1 for update', [site.id]);
            await contender.query('begin');
            const pid = (await contender.query('select pg_backend_pid() pid')).rows[0].pid;
            const blocked = queue.assertCurrent(contender, worker, first.lease).then(() => ({ ok: true }), error => ({ error }));
            let observed = false;
            for (let i = 0; i < 100; i++) {
                if ((await pool.query('select cardinality(pg_blocking_pids($1))>0 blocked', [pid])).rows[0].blocked) {
                    observed = true;
                    break;
                }
            }
            expect(observed, 'the second independent connection must reach the lock barrier').toBe(true);
            await gate.query('update private.jobs set expires_at=clock_timestamp() where id=$1', [site.id]);
            await gate.query('commit');
            expect(await blocked).toMatchObject({ error: { code: 'STALE_LEASE' } });
            await contender.query('rollback');
            const second = (await queue.claim(worker))!, store = new R2Store(repo, new Storage(), queue);
            const cp = await store.save({ ...second.job, stage: 'generate' }, second.lease, { jobId: site.id, siteId: site.id }, []);
            await gate.query('begin');
            await gate.query('select id from private.workers where id=$1 for update', [worker]);
            const commit = queue.checkpoint(second.lease, cp, null).then(() => ({ ok: true }), error => ({ error }));
            // Revocation owns the same worker row required by the committing transaction.
            await gate.query('update private.workers set revoked_at=clock_timestamp() where id=$1', [worker]);
            await gate.query('commit');
            expect(await commit).toMatchObject({ error: { code: 'STALE_LEASE' } });
            expect((await repo.current(site.id))!.checkpointId).toBeNull();
        }
        finally {
            await gate.query('rollback');
            await contender.query('rollback');
            gate.release();
            contender.release();
        }
    }
    finally {
        await pool.end();
    }
});
