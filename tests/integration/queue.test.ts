import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { database, seedUsers, identities } from './database.js';
import { SupabaseRepository } from '../../packages/adapters/src/supabase-repository.js';
import { PostgresQueue } from '../../packages/adapters/src/postgres-queue.js';
import { createApp } from '../../apps/control/src/app.js';
import { tokenHash } from '../../apps/control/src/auth.js';
import { AppError } from '../../packages/contracts/src/model.js';
test('visual-only enrolled claim filters before locking and leaves ordinary queued generation untouched',async()=>{const pool=await database();try{await seedUsers(pool);const repo=new SupabaseRepository(pool),queue=new PostgresQueue(repo),worker=randomUUID();await pool.query("insert into private.workers(id,name,token_hash) values($1,'visual',$2)",[worker,worker.replaceAll('-','').repeat(2)]);const created=await Promise.all([repo.create({domain:'filter-a.example'},{userId:identities.admin,role:'admin'}),repo.create({domain:'filter-b.example'},{userId:identities.admin,role:'admin'})]);const sites=created.sort((a,b)=>a.id.localeCompare(b.id));const visual=sites[1]!;await pool.query("update private.jobs set data=jsonb_set(jsonb_set(data,'{kind}','\"edit\"'),'{edit}',$2::jsonb) where site_id=$1",[visual.id,JSON.stringify({candidateId:randomUUID(),baseDraftId:randomUUID(),baseManifestId:randomUUID(),parentRevisionId:randomUUID(),instruction:'Visual',conversation:[],producer:{kind:'visual',version:1,binding:{version:1,siteId:visual.id,revisionId:randomUUID(),manifestId:randomUUID(),lineage:'lineage',mapId:'map'},patch:{elementId:'e_'+'a'.repeat(64),text:'Saved'}}})]);const claim=await queue.claim(worker,'visual');expect(claim?.job.siteId).toBe(visual.id);expect((await repo.current(sites[0]!.id))!.state).toBe('queued');expect((await queue.claim(worker))?.job.siteId).toBe(sites[0]!.id);}finally{await pool.end();}});
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

test('direct job controls enforce fresh editing permission while ordinary users can control their generation', async () => {
    const pool = await database();
    try {
        await seedUsers(pool);
        const repo = new SupabaseRepository(pool), queue = new PostgresQueue(repo);
        const user = { userId: identities.user, role: 'user' as const };
        const editor = { userId: identities.spec, role: 'spec-user' as const };
        const admin = { userId: identities.admin, role: 'admin' as const };
        const app = createApp({ repository: repo, queue, auth: {
            // Deliberately retain the pre-demotion session principal: the write
            // transaction must consult current membership, not this role.
            verifyUser: async token => token === 'admin' ? admin : token === 'editor' ? editor : user,
            verifyWorker: async () => { throw new Error('Not used'); }
        } });
        const request = (siteId: string, action: 'retry' | 'cancel', token = 'user') => app(new Request(`https://control.test/sites/${siteId}/jobs/${action}`, {
            method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: '{}'
        }));
        const own = await repo.create({ domain: 'own-generation.example' }, user);
        expect((await request(own.id, 'cancel')).status).toBe(200);
        expect((await repo.current(own.id))!.state).toBe('cancelled');
        const paused = await repo.create({ domain: 'own-paused-generation.example' }, user);
        await pool.query("update private.jobs set data=jsonb_set(data,'{state}','\"paused\"') where id=$1", [paused.id]);
        expect((await request(paused.id, 'retry')).status).toBe(200);
        expect((await repo.current(paused.id))!.state).toBe('queued');

        const assignedGeneration = await repo.create({ domain: 'assigned-generation-control.example' }, admin);
        await pool.query('insert into public.assignments(site_id,user_id) values($1,$2),($1,$3)', [assignedGeneration.id, user.userId, editor.userId]);
        await pool.query("update private.jobs set data=jsonb_set(data,'{state}','\"paused\"') where id=$1", [assignedGeneration.id]);
        const assignedBefore = (await pool.query('select * from private.jobs where id=$1', [assignedGeneration.id])).rows[0];
        for (const token of ['user', 'editor']) for (const action of ['retry', 'cancel'] as const) {
            expect((await request(assignedGeneration.id, action, token)).status, `assigned generation ${token} ${action}`).toBe(403);
            expect((await pool.query('select * from private.jobs where id=$1', [assignedGeneration.id])).rows[0]).toEqual(assignedBefore);
        }
        expect((await request(assignedGeneration.id, 'retry', 'admin')).status).toBe(200);
        expect((await request(assignedGeneration.id, 'cancel', 'admin')).status).toBe(200);

        for (const scope of ['own', 'assigned', 'demoted'] as const) {
            const owner = scope === 'own' ? user : scope === 'demoted' ? editor : admin;
            const site = await repo.create({ domain: `${scope}-edit-controls.example` }, owner);
            if (scope === 'assigned') await pool.query('insert into public.assignments(site_id,user_id) values($1,$2)', [site.id, user.userId]);
            if (scope === 'demoted') await pool.query("update public.memberships set role='user' where user_id=$1", [editor.userId]);
            for (const state of ['paused', 'waiting_provider'] as const) {
                // The stored job is the authorization subject. No HTTP kind/role
                // field may turn this existing edit into an ordinary generation.
                const job = { ...(await repo.current(site.id))!, kind: 'edit' as const, state,
                    edit: { candidateId: randomUUID(), baseDraftId: null, baseManifestId: randomUUID(), parentRevisionId: randomUUID(), instruction: 'Edit existing copy', conversation: [] } };
                await pool.query('update private.jobs set data=$2 where id=$1', [job.id, job]);
                for (const action of ['retry', 'cancel'] as const) {
                    const before = (await pool.query('select * from private.jobs where id=$1', [job.id])).rows[0];
                    const admission = (await pool.query('select * from private.site_operations where site_id=$1', [site.id])).rows[0];
                    expect((await request(site.id, action, scope === 'demoted' ? 'editor' : 'user')).status, `${scope} ${state} ${action}`).toBe(403);
                    expect((await pool.query('select * from private.jobs where id=$1', [job.id])).rows[0]).toEqual(before);
                    expect((await pool.query('select * from private.site_operations where site_id=$1', [site.id])).rows[0]).toEqual(admission);
                }
            }
            if (scope === 'demoted') {
                await pool.query("update public.memberships set role='spec-user' where user_id=$1", [editor.userId]);
                expect((await request(site.id, 'retry', 'editor')).status).toBe(200);
                expect((await request(site.id, 'cancel', 'editor')).status).toBe(200);
            } else {
                expect((await request(site.id, 'retry', 'admin')).status).toBe(200);
                expect((await request(site.id, 'cancel', 'admin')).status).toBe(200);
            }
        }
    } finally { await pool.end(); }
});
