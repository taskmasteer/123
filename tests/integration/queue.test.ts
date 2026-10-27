import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { database, seedUsers, identities } from './database.js';
import { SupabaseRepository } from '../../packages/adapters/src/supabase-repository.js';
import { PostgresQueue } from '../../packages/adapters/src/postgres-queue.js';
import { createApp } from '../../apps/control/src/app.js';
import { tokenHash } from '../../apps/control/src/auth.js';
import { AppError } from '../../packages/contracts/src/model.js';
test('concurrent server claims are unique, limited to two per device, and skip a locked site', async () => {
    const pool = await database();
    try {
        await seedUsers(pool);
        const repo = new SupabaseRepository(pool), worker = randomUUID(), other = randomUUID();
        for (const id of [worker, other])
            await pool.query("insert into private.workers(id,name,token_hash) values($1,'fixture',$2)", [id, id.replaceAll('-', '').repeat(2)]);
        const sites = await Promise.all(Array.from({ length: 5 }, (_, i) => repo.create({ domain: `queue${i}.example` }, { userId: identities.admin, role: 'admin' })));
        const supported = (await pool.query("select to_regprocedure('private.claim_job(uuid)') supported")).rows[0].supported;
        expect(supported, 'durable claim must be installed by the additive migration').not.toBeNull();
        const locked = await pool.connect();
        try {
            await locked.query('begin');
            await locked.query('select id from public.sites where id=$1 for update', [sites[0]!.id]);
            const results = await Promise.all(Array.from({ length: 4 }, () => pool.query('select private.claim_job($1) result', [worker])));
            const claims = results.map(r => r.rows[0].result).filter(Boolean);
            expect(claims).toHaveLength(2);
            expect(new Set(claims.map(c => c.job.id)).size).toBe(2);
            expect(claims.some(c => c.job.siteId === sites[0]!.id)).toBe(false);
            for (const c of claims) {
                const row = (await pool.query('select extract(epoch from (expires_at-claimed_at))*1000 duration from private.jobs where id=$1', [c.job.id])).rows[0];
                expect(Number(row.duration)).toBe(120000);
                expect(c.lease.generation).toBe(1);
            }
            expect((await pool.query('select private.claim_job($1) result', [other])).rows[0].result).not.toBeNull();
        }
        finally {
            await locked.query('rollback');
            locked.release();
        }
        const client = await pool.connect();
        try {
            await client.query('set role authenticated');
            await expect(client.query('select private.claim_job($1)', [worker])).rejects.toMatchObject({ code: '42501' });
        }
        finally {
            await client.query('reset role');
            client.release();
        }
    }
    finally {
        await pool.end();
    }
});
test('admin enrollment retries one credential and worker API rejects identity spoofing and revoked retries', async () => {
    const pool = await database();
    try {
        await seedUsers(pool);
        const repo = new SupabaseRepository(pool), queue = new PostgresQueue(repo), actor = { userId: identities.admin, role: 'admin' as const };
        const app = createApp({ repository: repo, queue, auth: { verifyUser: async () => actor, verifyWorker: async (token) => { const worker = await repo.worker(tokenHash(token)); if (!worker)
                    throw new AppError('UNAUTHENTICATED', 'Invalid worker'); return worker; } } });
        const token = Buffer.alloc(32, 7).toString('base64url'), workerId = randomUUID();
        const session = await app(new Request('https://control.test/session', { headers: { authorization: 'Bearer admin' } }));
        expect((await session.json()).capabilities.generation).toBe(false);
        const request = (path: string, credential: string, body: unknown) => app(new Request('https://control.test' + path, { method: 'POST', headers: { authorization: 'Bearer ' + credential, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
        const enrollment = { workerId, name: 'Device A', token, controlOrigin: 'https://control.test' };
        for (let i = 0; i < 2; i++) {
            const r = await request('/workers/enroll', 'admin', enrollment);
            expect(r.status).toBe(200);
            expect(await r.json()).toEqual({ workerId, name: 'Device A' });
        }
        expect((await pool.query('select count(*)::int n from private.workers')).rows[0].n).toBe(1);
        expect((await request('/workers/enroll', 'admin', { ...enrollment, token: Buffer.alloc(32, 9).toString('base64url') })).status).toBe(409);
        await repo.create({ domain: 'api-queue.example' }, actor);
        expect((await request('/worker/jobs/claim', token, { workerId: randomUUID() })).status).toBe(400);
        const response = await request('/worker/jobs/claim', token, {});
        expect(response.status).toBe(200);
        const claimed = await response.json();
        expect(claimed.lease.workerId).toBe(workerId);
        expect((await request(`/worker/jobs/${claimed.job.id}/heartbeat`, token, { lease: { ...claimed.lease, workerId: randomUUID() } })).status).toBe(409);
        expect((await request(`/worker/jobs/${claimed.job.id}/heartbeat`, token, { lease: claimed.lease })).status).toBe(200);
        await request(`/workers/${workerId}/revoke`, 'admin', {});
        expect((await request('/workers/enroll', 'admin', enrollment)).status).toBe(409);
        expect((await request('/worker/jobs/claim', token, {})).status).toBe(401);
    }
    finally {
        await pool.end();
    }
});
test('enqueue composes with admission; missing admission and revoked credentials fail closed', async () => {
    const pool = await database();
    try {
        await seedUsers(pool);
        const repo = new SupabaseRepository(pool), queue = new PostgresQueue(repo), worker = randomUUID();
        await pool.query("insert into private.workers(id,name,token_hash) values($1,'fixture',$2)", [worker, 'd'.repeat(64)]);
        const actor = { userId: identities.admin, role: 'admin' as const }, site = await repo.create({ domain: 'admission.example' }, actor);
        await queue.cancel(site.id);
        const admission = await repo.acquire(actor, site.id);
        const job = { id: randomUUID(), siteId: site.id, kind: 'generate' as const, stage: 'brief', state: 'queued' as const, checkpointId: null, baseRevision: 0 };
        await repo.transaction(async (tx) => { await repo.guard(tx, admission); await queue.enqueueInTransaction(tx, job, admission.token); });
        await repo.release(admission);
        const claimed = (await queue.claim(worker))!;
        expect(claimed.job.id).toBe(job.id);
        await pool.query('delete from private.site_operations where site_id=$1', [site.id]);
        await expect(queue.heartbeat(claimed.lease)).rejects.toMatchObject({ code: 'STALE_LEASE' });
        await queue.revokeWorker(worker);
        await expect(queue.claim(worker)).rejects.toMatchObject({ code: 'STALE_LEASE' });
    }
    finally {
        await pool.end();
    }
});
test('explicit resume retains saved progress and trusted provider retry ticket across claims', async () => {
    const pool = await database();
    try {
        await seedUsers(pool);
        const repo = new SupabaseRepository(pool), queue = new PostgresQueue(repo), worker = randomUUID();
        await pool.query("insert into private.workers(id,name,token_hash) values($1,'resume',$2)", [worker, '9'.repeat(64)]);
        const site = await repo.create({ domain: 'resume.example' }, { userId: identities.admin, role: 'admin' }), claim = (await queue.claim(worker))!;
        await queue.pauseWorker(worker, true);
        expect(await queue.pauseAtBoundary(claim.lease)).toBe(true);
        await queue.pauseWorker(worker, false);
        const resumed = await queue.claim(worker);
        expect(resumed?.job.id).toBe(site.id);
        await queue.finish(resumed!.lease, 'needs_attention');
        await expect(queue.retry(site.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    }
    finally {
        await pool.end();
    }
});
