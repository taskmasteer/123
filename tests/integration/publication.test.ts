import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { database, seedUsers, identities } from './database.js';
import { SupabaseRepository } from '../../packages/adapters/src/supabase-repository.js';
import { PostgresQueue } from '../../packages/adapters/src/postgres-queue.js';
import { R2Store, type ObjectTransport } from '../../packages/adapters/src/r2-store.js';
import { PostgresPublication } from '../../packages/adapters/src/postgres-publication.js';
import { VercelClient } from '../../packages/adapters/src/vercel/client.js';
import { createApp } from '../../apps/control/src/app.js';
import { createRemoteWorker } from '../../apps/worker/src/remote-worker.js';
import { runWorker } from '../../apps/worker/src/runner.js';
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
    async put(key: string, bytes: Uint8Array, mediaType: string) {
        if (this.objects.has(key))
            throw new Error('Immutable');
        this.objects.set(key, { bytes, mediaType });
    }
    async get(key: string) { return this.objects.get(key)!.bytes; }
    async head(key: string) { const f = this.objects.get(key)!; return { size: f.bytes.length, mediaType: f.mediaType }; }
}
async function fixture(before?: (path: string) => Promise<void>, reserve = true) {
    const pool = await database();
    await seedUsers(pool);
    const repo = new SupabaseRepository(pool), queue = new PostgresQueue(repo), storage = new Storage(), store = new R2Store(repo, storage, queue), worker = randomUUID();
    await pool.query("insert into private.workers(id,name,token_hash) values($1,'fixture',$2)", [worker, 'a'.repeat(64)]);
    const actor = { userId: identities.admin, role: 'admin' as const };
    const site = await repo.create({ domain: 'publication.example' }, actor), claim = (await queue.claim(worker))!;
    const files = [{ path: 'index.html', mediaType: 'text/html', bytes: Buffer.from('<!doctype html><h1>Original immutable content</h1>') }];
    const manifest = await store.put(site.id, files, '1'), revisionId = randomUUID(), requestKey = claim.job.id + ':' + manifest.id;
    const state = { jobId: claim.job.id, siteId: site.id, revisionId, revisionCreatedAt: 123, parentRevisionId: null, manifestId: manifest.id, selection: { seed: 0, styleId: 'editorial', templateVersion: '1' } };
    const cp = await store.save({ ...claim.job, stage: 'publication' }, claim.lease, state, files);
    await queue.checkpoint(claim.lease, cp, null);
    const binding = { requestKey, revisionId, manifestId: manifest.id, checkpointId: cp.id, expectedRevision: 0 };
    // Crash-boundary fixtures let the actual HTTP route make the first reservation.
    const reservation = (reserve ? await queue.reservePublication(claim.lease, binding) : undefined)!;
    let createCount = 0, promoteCount = 0, uploads = 0, verified = 0, timeoutCreate = true, wrongAlias = false, dnsReady = true, quota = false, ownershipChallenge = false, domainVerified = false;
    let deployment: any = null, readyState = 'READY';
    const calls: string[] = [];
    const client = new VercelClient({ token: 'fixture', accountId: 'team_fixture', fetch: async (input, init) => {
            const url = new URL(String(input)), path = url.pathname;
            calls.push(init!.method + ' ' + path);
            await before?.(path);
            if (quota) {
                quota = false;
                return new Response(null, { status: 429, headers: { 'retry-after': '1' } });
            }
            if (path.includes('/domains/') && path.startsWith('/v9/')) {
                if (path.endsWith('/verify'))
                    domainVerified = dnsReady;
                return Response.json({ name: site.domain, verified: ownershipChallenge ? domainVerified : dnsReady, verification: [{ type: 'TXT', domain: '_vercel.' + site.domain, value: 'challenge' }] });
            }
            if (path.startsWith('/v9/projects/'))
                return Response.json({ id: 'prj_fixture', name: 'sf-' + site.id, framework: null, buildCommand: '', installCommand: '', accountId: 'team_fixture' });
            if (path.startsWith('/v6/domains/')) {
                expect(url.searchParams.get('projectIdOrName')).toBe('prj_fixture');
                return Response.json({ misconfigured: !dnsReady, recommendedCNAME: [{ rank: 1, value: 'target.vercel-dns.com' }] });
            }
            if (path === '/v2/files') {
                uploads++;
                return new Response(null, { status: 200 });
            }
            if (path === '/v13/deployments') {
                createCount++;
                const body = JSON.parse(String(init!.body));
                expect(body).not.toHaveProperty('target');
                expect(body.files).toHaveLength(2);
                expect(body.projectSettings).toMatchObject({ framework: null, buildCommand: '', installCommand: '' });
                const id = createCount === 1 ? 'dpl_fixture' : 'dpl_fixture_' + createCount;
                deployment = { id, uid: id, projectId: 'prj_fixture', meta: body.meta, readyState };
                if (timeoutCreate) {
                    timeoutCreate = false;
                    throw new Error('connection lost after provider accepted');
                }
                return Response.json(deployment);
            }
            if (path === '/v7/deployments')
                return Response.json(url.searchParams.has('until') ? { deployments: [deployment], pagination: { next: null } } : { deployments: [], pagination: { next: 100 } });
            if (path === '/v13/deployments/' + deployment?.id)
                return Response.json({ ...deployment, readyState });
            if (path.includes('/promote/')) {
                promoteCount++;
                return new Response(null, { status: 202 });
            }
            if (path.startsWith('/v4/aliases/'))
                return Response.json({ alias: site.domain, projectId: 'prj_fixture', deploymentId: wrongAlias ? 'dpl_wrong' : deployment.id });
            throw new Error('Unexpected provider route ' + path);
        } });
    const publication = new PostgresPublication(queue, store, client, async (expected) => { verified++; expect(expected.hostname).toBe(site.domain); expect(expected.size).toBe(files[0]!.bytes.length); return { verifiedAt: 123456 }; });
    const advance = async () => { await pool.query("update private.provider_publications set retry_at=null where id=$1", [reservation.id]); await pool.query('update private.provider_accounts set blocked_until=null'); return publication.advancePublication(reservation.id); };
    return { pool, repo, queue, store, site, claim, binding, reservation, publication, advance, storage, manifest,
        counts: () => ({ createCount, promoteCount, uploads, verified }), calls, requireOwnershipChallenge: () => { ownershipChallenge = true; }, setReadyState: (v: string) => { readyState = v; }, setWrongAlias: (v: boolean) => { wrongAlias = v; }, setDns: (v: boolean) => { dnsReady = v; }, setQuota: () => { quota = true; } };
}
it.each([false, true])('generation attachment outbox survives process loss, expired lease and temporary R2 failure (cancel=%s)', async (cancel) => {
    const f = await fixture(undefined, false);
    try {
        const actor = { userId: identities.admin, role: 'admin' as const };
        const application = (publication: PostgresPublication) => createApp({ repository: f.repo, queue: f.queue, store: f.store, publication, auth: { verifyUser: async () => actor, verifyWorker: async () => ({ workerId: f.claim.lease.workerId }) } });
        const request = (app: ReturnType<typeof createApp>, path: string, body?: unknown) => app(new Request('https://control.test' + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
        // The real route commits admission, then the process stops before attach runs.
        f.publication.attach = async () => { throw new Error('process stopped after reservation commit'); };
        expect((await request(application(f.publication), `/worker/jobs/${f.claim.job.id}/publication`, { lease: f.claim.lease, binding: f.binding })).status).toBe(503);
        const reservation = (await f.pool.query('select * from private.publication_reservations where site_id=$1', [f.site.id])).rows[0];
        expect(reservation.binding).toEqual(f.binding);
        expect((await f.pool.query('select count(*) from private.provider_publications')).rows[0].count).toBe('0');
        await f.pool.query('update private.jobs set expires_at=clock_timestamp() where id=$1', [f.claim.job.id]);
        expect(await f.queue.claim(f.claim.lease.workerId)).toBeNull();
        if (cancel)
            await f.queue.cancel(f.claim.job.id);
        const recovered = () => new PostgresPublication(f.queue, f.store, f.publication.client, f.publication.verify);
        const first = application(recovered()), second = application(recovered());
        const get = f.storage.get.bind(f.storage);
        f.storage.get = async (key) => { if (key.startsWith('private/checkpoints/'))
            throw new Error('temporary R2 outage'); return get(key); };
        expect((await request(first, '/worker/publications/tick', {})).status).toBe(503);
        expect((await f.pool.query('select count(*) from private.provider_publications')).rows[0].count).toBe('0');
        expect(f.calls).toEqual([]);
        f.storage.get = get;
        await f.pool.query('update private.publication_reservations set attachment_retry_at=clock_timestamp() where id=$1', [reservation.id]);
        for (const tick of await Promise.all([request(first, '/worker/publications/tick', {}), request(second, '/worker/publications/tick', {})]))
            expect(tick.status).toBe(200);
        const status = await request(first, `/sites/${f.site.id}/publication`);
        expect(status.status).toBe(200);
        expect((await status.json()).publication).toMatchObject({ id: reservation.id, revisionId: f.binding.revisionId, origin: 'generation' });
        expect((await f.pool.query('select count(*) from private.provider_publications')).rows[0].count).toBe('1');
        for (let i = 0; i < 24; i++) {
            await f.pool.query('update private.provider_publications set retry_at=null');
            expect((await request(first, '/worker/publications/tick', {})).status).toBe(200);
        }
        expect(await recovered().view(reservation.id)).toMatchObject({ settlement: cancel ? 'cancelled' : 'settled', cancelRequested: cancel });
        expect(f.counts().createCount).toBe(cancel ? 0 : 1);
        expect((await f.repo.get(f.site.id))!.publishedId).toBe(cancel ? null : f.binding.revisionId);
    }
    finally {
        await f.pool.end();
    }
});
it('accepted-draft attachment outbox recovers through scoped latest and Resume without the original UI request key', async () => {
    const f = await fixture();
    try {
        await f.publication.attach(f.reservation.id);
        for (let i = 0; i < 24; i++)
            await f.advance();
        let actor = { userId: identities.admin, role: 'admin' as 'admin' | 'user' };
        const application = (publication: PostgresPublication) => createApp({ repository: f.repo, queue: f.queue, store: f.store, publication, auth: { verifyUser: async () => actor, verifyWorker: async () => ({ workerId: f.claim.lease.workerId }) } });
        const request = (app: ReturnType<typeof createApp>, path: string, body?: unknown) => app(new Request('https://control.test' + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
        const original = application(f.publication);
        const edited = await request(original, `/sites/${f.site.id}/edits`, { instruction: 'Keep checked content', expectedRevision: 1 });
        expect(edited.status).toBe(200);
        const claim = (await f.queue.claim(f.claim.lease.workerId))!, candidateId = claim.job.edit!.candidateId;
        const cp = await f.store.save({ ...claim.job, stage: 'completed' }, claim.lease, { jobId: claim.job.id, siteId: f.site.id, baseRevision: 1, revisionId: candidateId, manifestId: f.manifest.id, validation: { ok: true, issues: [], screenshotIds: [] } }, []);
        await f.queue.checkpoint(claim.lease, cp, null);
        await f.queue.finish(claim.lease, 'completed');
        expect((await request(original, `/sites/${f.site.id}/candidates`)).status).toBe(200);
        expect((await request(original, `/sites/${f.site.id}/candidates/${candidateId}/accept`, { expectedRevision: 1 })).status).toBe(200);
        f.publication.attach = async () => { throw new Error('process stopped after controller reservation commit'); };
        expect((await request(original, `/sites/${f.site.id}/publication`, { revisionId: candidateId, expectedRevision: 2, requestKey: randomUUID() })).status).toBe(503);
        const reservation = (await f.pool.query('select * from private.publication_reservations where site_id=$1 and resolution is null', [f.site.id])).rows[0];
        expect(reservation.binding).toEqual({ revisionId: candidateId, manifestId: f.manifest.id, expectedRevision: 2 });
        expect((await f.pool.query('select id from private.provider_publications where id=$1', [reservation.id])).rowCount).toBe(0);
        const recovered = () => new PostgresPublication(f.queue, f.store, f.publication.client, f.publication.verify);
        const first = application(recovered()), second = application(recovered());
        const journal = (await f.pool.query('select data from private.deployments where id::text=lower($1)', [reservation.request_key])).rows[0].data;
        await f.pool.query("update private.deployments set data=jsonb_set(data,'{manifestId}',to_jsonb($2::text)) where id::text=lower($1)", [reservation.request_key, randomUUID()]);
        expect((await request(first, `/sites/${f.site.id}/publication`)).status).toBe(409);
        expect((await f.pool.query('select id from private.provider_publications where id=$1', [reservation.id])).rowCount).toBe(0);
        await f.pool.query('update private.deployments set data=$2 where id::text=lower($1)', [reservation.request_key, journal]);
        const statuses = await Promise.all([request(first, `/sites/${f.site.id}/publication`), request(second, `/sites/${f.site.id}/publication`)]);
        for (const response of statuses) {
            expect(response.status).toBe(200);
            const value = await response.json();
            expect(value.publication).toMatchObject({ id: reservation.id, revisionId: candidateId, origin: 'draft' });
            expect(value.publication).not.toHaveProperty('requestKey');
        }
        expect((await f.pool.query('select count(*) from private.provider_publications where id=$1', [reservation.id])).rows[0].count).toBe('1');
        await f.pool.query('update public.sites set owner_id=$2 where id=$1', [f.site.id, identities.user]);
        actor = { userId: identities.user, role: 'user' };
        expect((await request(first, `/sites/${f.site.id}/publication/resume`, { id: reservation.id })).status).toBe(403);
        actor = { userId: identities.admin, role: 'admin' };
        expect((await request(second, `/sites/${f.site.id}/publication/resume`, { id: reservation.id })).status).toBe(200);
        for (let i = 0; i < 20; i++) {
            await f.pool.query('update private.provider_publications set retry_at=null');
            expect((await request(first, '/worker/publications/tick', {})).status).toBe(200);
        }
        expect((await f.repo.get(f.site.id))!).toMatchObject({ publishedId: candidateId, revision: 3 });
        expect(await recovered().view(reservation.id)).toMatchObject({ settlement: 'settled', origin: 'draft' });
        expect(f.counts().createCount).toBe(2);
    }
    finally {
        await f.pool.end();
    }
});
it('attachment outbox durably backs off an unreadable oldest reservation so another site can finish', async () => {
    const f = await fixture();
    try {
        const site = await f.repo.create({ domain: 'unreadable.example' }, { userId: identities.admin, role: 'admin' }), claim = (await f.queue.claim(f.claim.lease.workerId))!;
        expect(claim.job.siteId).toBe(site.id);
        const manifest = await f.store.put(site.id, [{ path: 'index.html', mediaType: 'text/html', bytes: Buffer.from('unreadable checkpoint fixture') }], '1'), revisionId = randomUUID();
        const cp = await f.store.save({ ...claim.job, stage: 'publication' }, claim.lease, { jobId: claim.job.id, siteId: site.id, revisionId, revisionCreatedAt: 1, parentRevisionId: null, manifestId: manifest.id }, []);
        await f.queue.checkpoint(claim.lease, cp, null);
        const bad = await f.queue.reservePublication(claim.lease, { requestKey: claim.job.id + ':' + manifest.id, revisionId, manifestId: manifest.id, checkpointId: cp.id, expectedRevision: 0 });
        await f.pool.query("update private.publication_reservations set created_at=created_at-interval '1 day' where id=$1", [bad.id]);
        const get = f.storage.get.bind(f.storage);
        f.storage.get = async (key) => { if (key.startsWith('private/checkpoints/' + site.id + '/'))
            throw new Error('unreadable oldest checkpoint'); return get(key); };
        const recovered = () => new PostgresPublication(f.queue, f.store, f.publication.client, f.publication.verify);
        await expect(recovered().tick()).rejects.toThrow('unreadable oldest checkpoint');
        await expect(recovered().tick()).resolves.toBeUndefined();
        expect((await f.pool.query('select attachment_retry_at>clock_timestamp() waiting from private.publication_reservations where id=$1', [bad.id])).rows[0].waiting).toBe(true);
        expect((await f.pool.query('select id from private.provider_publications where id=$1', [bad.id])).rowCount).toBe(0);
        for (let i = 0; i < 24; i++) {
            await f.pool.query('update private.provider_publications set retry_at=null');
            await recovered().tick();
        }
        expect((await f.repo.get(f.site.id))!.publishedId).toBe(f.binding.revisionId);
        expect(f.counts().createCount).toBe(1);
        expect((await f.pool.query('select kind,operation_id from private.site_operations where site_id=$1', [site.id])).rows[0]).toEqual({ kind: 'publication', operation_id: bad.id });
    }
    finally {
        await f.pool.end();
    }
});
it('repeated attachment preserves the frozen ledger during checkpoint outage and rejects a different journal', async () => {
    const f = await fixture();
    try {
        await f.publication.attach(f.reservation.id);
        const frozen = (await f.pool.query('select * from private.provider_publications where id=$1', [f.reservation.id])).rows[0];
        f.storage.get = async () => { throw new Error('checkpoint unavailable after attachment'); };
        const recovered = new PostgresPublication(f.queue, f.store, f.publication.client, f.publication.verify);
        expect(await recovered.latest(f.site.id)).toMatchObject({ id: f.reservation.id, phase: 'pending' });
        expect(await recovered.attach(f.reservation.id)).toMatchObject({ id: f.reservation.id, phase: 'pending' });
        await expect(recovered.attach(f.reservation.id, randomUUID())).rejects.toMatchObject({ code: 'CONFLICT' });
        expect((await f.pool.query('select * from private.provider_publications where id=$1', [f.reservation.id])).rows[0]).toEqual(frozen);
        expect(f.calls).toEqual([]);
    }
    finally {
        await f.pool.end();
    }
});
it('publication completes provider domain ownership verification after the supplied TXT challenge is ready', async () => {
    const f = await fixture();
    try {
        f.requireOwnershipChallenge();
        await f.publication.attach(f.reservation.id);
        for (let i = 0; i < 24; i++)
            await f.advance();
        expect(await f.publication.view(f.reservation.id)).toMatchObject({ phase: 'published', settlement: 'settled' });
        expect(f.calls).toContain('POST /v9/projects/prj_fixture/domains/publication.example/verify');
    }
    finally {
        await f.pool.end();
    }
});
it('publication cannot commit a late response after losing account ownership while its site step is still live', async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(r => entered = r), gate = new Promise<void>(r => release = r);
    const f = await fixture(async () => { entered(); await gate; });
    try {
        await f.publication.attach(f.reservation.id);
        const pending = f.advance();
        await started;
        await f.pool.query("update private.provider_accounts set step_token=$1,step_expires=clock_timestamp()+interval '40 seconds'", [randomUUID()]);
        release();
        await pending;
        expect((await f.pool.query('select data from private.provider_publications where id=$1', [f.reservation.id])).rows[0].data.action).toBe('project');
    }
    finally {
        release();
        await f.pool.end();
    }
});
it('cancellation of an accepted building deployment retains account capacity until readiness and never promotes', async () => {
    const f = await fixture();
    try {
        await f.publication.attach(f.reservation.id);
        f.setReadyState('BUILDING');
        for (let i = 0; i < 9; i++)
            await f.advance();
        expect(f.counts().createCount).toBe(1);
        await f.queue.cancel(f.claim.job.id);
        await f.advance();
        expect(await f.publication.view(f.reservation.id)).toMatchObject({ settlement: 'pending', cancelRequested: true });
        expect((await f.pool.query('select active_intent from private.provider_accounts')).rows[0].active_intent).toBe(f.reservation.id);
        f.setReadyState('READY');
        for (let i = 0; i < 3; i++)
            await f.advance();
        expect(await f.publication.view(f.reservation.id)).toMatchObject({ settlement: 'cancelled' });
        expect(f.counts().promoteCount).toBe(0);
        expect((await f.repo.get(f.site.id))!.publishedId).toBeNull();
        expect((await f.pool.query('select active_intent from private.provider_accounts')).rows[0].active_intent).toBeNull();
    }
    finally {
        await f.pool.end();
    }
});
it('expired create owner cannot install its late response and the replacement reconciles without a second create', async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(r => entered = r), gate = new Promise<void>(r => release = r);
    const f = await fixture(async (path) => {
        if (path === '/v13/deployments') {
            entered();
            await gate;
        }
    });
    try {
        await f.publication.attach(f.reservation.id);
        for (let i = 0; i < 5; i++)
            await f.advance();
        const pending = f.advance();
        await started;
        await f.pool.query('update private.provider_publications set step_expires=clock_timestamp() where id=$1', [f.reservation.id]);
        await f.pool.query('update private.provider_accounts set step_expires=clock_timestamp()');
        await f.advance();
        release();
        await pending;
        expect((await f.publication.view(f.reservation.id)).deploymentId).toBeNull();
        for (let i = 0; i < 12; i++)
            await f.advance();
        expect(await f.publication.view(f.reservation.id)).toMatchObject({ phase: 'published', settlement: 'settled' });
        expect(f.counts()).toMatchObject({ createCount: 1, promoteCount: 1 });
    }
    finally {
        release();
        await f.pool.end();
    }
});
it('verified external success survives settlement CAS conflict and retains the site reservation', async () => {
    const f = await fixture();
    try {
        await f.publication.attach(f.reservation.id);
        for (let i = 0; i < 18; i++) {
            const row = (await f.pool.query('select data from private.provider_publications where id=$1', [f.reservation.id])).rows[0];
            if (row.data.action === 'settle')
                break;
            await f.advance();
        }
        expect((await f.publication.view(f.reservation.id)).verifiedAt).toBe(123456);
        await f.pool.query('update public.sites set revision=revision+1 where id=$1', [f.site.id]);
        await f.advance();
        expect((await f.repo.get(f.site.id))!.publishedId).toBeNull();
        expect(await f.publication.history(f.site.id)).toMatchObject([{ settlement: 'conflict', verifiedAt: 123456 }]);
        await expect(f.repo.acquire({ userId: identities.admin, role: 'admin' }, f.site.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    }
    finally {
        await f.pool.end();
    }
});
it('publication reconciles paginated unknown create, waits for alias plus HTTPS, then settles exactly once', async () => {
    const f = await fixture();
    try {
        await expect(f.publication.attach(f.reservation.id)).resolves.toMatchObject({ id: f.reservation.id, phase: 'pending' });
        f.setWrongAlias(true);
        for (let i = 0; i < 18; i++)
            await f.advance();
        expect(f.counts()).toMatchObject({ createCount: 1, promoteCount: 1, uploads: 2, verified: 0 });
        expect((await f.repo.get(f.site.id))!.publishedId).toBeNull();
        await expect(f.repo.acquire({ userId: identities.admin, role: 'admin' }, f.site.id)).rejects.toMatchObject({ code: 'CONFLICT' });
        f.setWrongAlias(false);
        for (let i = 0; i < 5; i++)
            await f.advance();
        expect((await f.repo.get(f.site.id))!).toMatchObject({ publishedId: f.binding.revisionId, revision: 1 });
        expect(await f.publication.view(f.reservation.id)).toMatchObject({ phase: 'published', settlement: 'settled', verifiedAt: 123456 });
        expect(f.counts()).toMatchObject({ createCount: 1, promoteCount: 1, verified: 1 });
        expect(await f.store.read(f.manifest.id)).toHaveLength(1);
    }
    finally {
        await f.pool.end();
    }
});
it('publication preserves exclusion and archived bytes across quota, DNS waits and cancellation after promotion', async () => {
    const f = await fixture();
    try {
        await f.publication.attach(f.reservation.id);
        f.setQuota();
        expect(await f.advance()).toBe('waiting_quota');
        f.setDns(false);
        for (let i = 0; i < 15; i++)
            await f.advance();
        expect(f.counts().promoteCount).toBe(0);
        expect(await f.publication.view(f.reservation.id)).toMatchObject({ phase: 'awaiting_dns' });
        f.setDns(true);
        f.setWrongAlias(true);
        for (let i = 0; i < 18; i++)
            await f.advance();
        expect(f.counts().promoteCount).toBe(1);
        await f.queue.cancel(f.claim.job.id);
        await expect(f.repo.acquire({ userId: identities.admin, role: 'admin' }, f.site.id)).rejects.toMatchObject({ code: 'CONFLICT' });
        f.setWrongAlias(false);
        for (let i = 0; i < 5; i++)
            await f.advance();
        expect((await f.repo.current(f.site.id))!.state).toBe('cancelled');
        expect((await f.repo.get(f.site.id))!.publishedId).toBe(f.binding.revisionId);
        expect(await f.publication.view(f.reservation.id)).toMatchObject({ cancelRequested: true, settlement: 'settled' });
    }
    finally {
        await f.pool.end();
    }
});
it('publication cancelled before provider dispatch releases only its reservation without pointer change', async () => {
    const f = await fixture();
    try {
        await f.publication.attach(f.reservation.id);
        await f.queue.cancel(f.claim.job.id);
        await f.advance();
        expect(f.calls).toEqual([]);
        expect((await f.repo.get(f.site.id))!.publishedId).toBeNull();
        expect(await f.publication.view(f.reservation.id)).toMatchObject({ cancelRequested: true, settlement: 'cancelled' });
        expect((await f.pool.query('select * from private.site_operations where site_id=$1', [f.site.id])).rowCount).toBe(0);
    }
    finally {
        await f.pool.end();
    }
});
it('configured publication API exposes safe status, continuation and exact settlement receipt; absent configuration stays unavailable', async () => {
    const f = await fixture();
    try {
        await f.publication.attach(f.reservation.id);
        const auth = { verifyUser: async () => ({ userId: identities.admin, role: 'admin' as const }), verifyWorker: async () => ({ workerId: f.claim.lease.workerId }) };
        const app = createApp({ repository: f.repo, queue: f.queue, store: f.store, publication: f.publication, auth } as any);
        const call = (path: string, body?: unknown) => app(new Request('https://control.example' + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
        expect((await (await call('/session')).json()).capabilities.publish).toBe(true);
        const status = await call(`/sites/${f.site.id}/publication`);
        expect(status.status).toBe(200);
        expect(await status.json()).toMatchObject({ publication: { id: f.reservation.id }, domain: { verified: false } });
        for (let i = 0; i < 24; i++) {
            await f.pool.query('update private.provider_publications set retry_at=null');
            await call('/worker/publications/tick', {});
        }
        expect((await f.repo.get(f.site.id))!.publishedId).toBe(f.binding.revisionId);
        const receipt = await call(`/worker/jobs/${f.claim.job.id}/publication-receipt`, { lease: f.claim.lease });
        expect(receipt.status).toBe(200);
        expect(await receipt.json()).toEqual({ jobId: f.claim.job.id, siteId: f.site.id, ...f.binding });
        expect((await call('/worker/publications/tick', { id: f.reservation.id })).status).toBe(400);
        await f.queue.revokeWorker(f.claim.lease.workerId);
        expect((await call('/worker/publications/tick', {})).status).toBe(409);
        expect((await call(`/worker/jobs/${f.claim.job.id}/publication-receipt`, { lease: f.claim.lease })).status).toBe(409);
        const absent = createApp({ repository: f.repo, queue: f.queue, store: f.store, auth });
        expect((await (await absent(new Request('https://control.example/session', { headers: { authorization: 'Bearer fixture' } }))).json()).capabilities.publish).toBe(false);
    }
    finally {
        await f.pool.end();
    }
});
it('direct publication routes require current publish permission and accepted checked draft evidence, with idempotent handoff', async () => {
    const f = await fixture();
    try {
        await f.publication.attach(f.reservation.id);
        for (let i = 0; i < 24; i++)
            await f.advance();
        let actor = { userId: identities.admin, role: 'admin' as 'admin' | 'user' | 'spec-user' };
        const app = createApp({ repository: f.repo, queue: f.queue, store: f.store, publication: f.publication, auth: { verifyUser: async () => actor, verifyWorker: async () => ({ workerId: f.claim.lease.workerId }) } });
        const call = (path: string, body?: unknown) => app(new Request('https://control.test' + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
        const edited = await call(`/sites/${f.site.id}/edits`, { instruction: 'Keep the checked content', expectedRevision: 1 });
        expect(edited.status).toBe(200);
        const job = await edited.json(), claim = (await f.queue.claim(f.claim.lease.workerId))!, candidateId = claim.job.edit!.candidateId;
        expect(claim.job.id).toBe(job.id);
        const cp = await f.store.save({ ...claim.job, stage: 'completed' }, claim.lease, { jobId: job.id, siteId: f.site.id, baseRevision: 1, revisionId: candidateId, manifestId: f.manifest.id, validation: { ok: true, issues: [], screenshotIds: [] } }, []);
        await f.queue.checkpoint(claim.lease, cp, null);
        await f.queue.finish(claim.lease, 'completed');
        expect((await call(`/sites/${f.site.id}/candidates`)).status).toBe(200);
        const key = randomUUID(), publish = () => call(`/sites/${f.site.id}/publication`, { revisionId: candidateId, expectedRevision: 2, requestKey: key });
        expect((await publish()).status).toBe(409); // Existing checked candidate is not acceptance.
        expect((await call(`/sites/${f.site.id}/candidates/${candidateId}/accept`, { expectedRevision: 1 })).status).toBe(200);
        await f.pool.query("update private.edit_requests set data=jsonb_set(data,'{status}','\"rejected\"') where id=$1", [candidateId]);
        expect((await publish()).status).toBe(409); // Even a draft pointer alone cannot grant eligibility.
        await f.pool.query("update private.edit_requests set data=jsonb_set(data,'{status}','\"accepted\"') where id=$1", [candidateId]);
        await f.pool.query('update public.sites set owner_id=$2 where id=$1', [f.site.id, identities.user]);
        await f.pool.query('insert into public.assignments values($1,$2)', [f.site.id, identities.spec]);
        actor = { userId: identities.user, role: 'user' };
        expect((await publish()).status).toBe(403);
        actor = { userId: identities.spec, role: 'spec-user' };
        const accepted = await publish();
        expect(accepted.status).toBe(200);
        const intent = await accepted.json();
        expect(await (await publish()).json()).toMatchObject({ id: intent.id, origin: 'draft' });
        expect((await call(`/sites/${f.site.id}/publication`, { revisionId: candidateId, expectedRevision: 2, requestKey: randomUUID() })).status).toBe(409);
        await f.pool.query("update public.memberships set role='user' where user_id=$1", [identities.spec]);
        expect((await call(`/sites/${f.site.id}/publication/resume`, { id: intent.id })).status).toBe(403);
        expect((await f.publication.view(intent.id)).phase).toBe('pending');
        await f.pool.query("update public.memberships set role='spec-user' where user_id=$1", [identities.spec]);
        expect((await call(`/sites/${f.site.id}/publication/resume`, { id: intent.id })).status).toBe(200);
        for (let i = 0; i < 20; i++)
            await f.publication.advancePublication(intent.id);
        expect((await f.repo.get(f.site.id))!).toMatchObject({ publishedId: candidateId, revision: 3 });
        expect((await f.repo.revision(candidateId))!.kind).toBe('candidate');
        expect((await f.publication.history(f.site.id)).map(p => ({ revision: p.revisionId, settlement: p.settlement }))).toEqual(expect.arrayContaining([{ revision: candidateId, settlement: 'settled' }, { revision: f.binding.revisionId, settlement: 'settled' }]));
    }
    finally {
        await f.pool.end();
    }
});
it('actual remote runWorker automatically publishes multiple generated sites, recovers lost settlement response and offline runJob without duplicate mutations', async () => {
    const pool = await database(), root = await mkdtemp(resolve('.local-state/publication-worker-'));
    try {
        await seedUsers(pool);
        const repo = new SupabaseRepository(pool), queue = new PostgresQueue(repo), storage = new Storage(), store = new R2Store(repo, storage, queue), worker = randomUUID();
        await pool.query("insert into private.workers(id,name,token_hash) values($1,'fixture',$2)", [worker, 'c'.repeat(64)]);
        await pool.query("insert into private.catalog values('style','editorial',$1)", [{ id: 'editorial', name: 'Fixture', version: '1', enabled: true, referenceIds: [] }]);
        const sites = await Promise.all([1, 2].map(n => repo.create({ domain: `automatic${n}.example` }, { userId: identities.admin, role: 'admin' })));
        const deployments = new Map<string, any>();
        let creates = 0, promotes = 0, models = 0, lost = false;
        const leases = new Map<string, any>();
        const client = new VercelClient({ token: 'fixture', accountId: 'team_fixture', fetch: async (input, init) => {
                const url = new URL(String(input)), path = url.pathname;
                const site = sites.find(s => path.includes(s.id) || path.includes(s.domain));
                if (path.includes('/domains/') && path.startsWith('/v9/'))
                    return Response.json({ name: site!.domain, verified: true });
                if (path.startsWith('/v9/projects/'))
                    return Response.json({ id: 'prj_' + site!.id, name: 'sf-' + site!.id, accountId: 'team_fixture', framework: null, buildCommand: '', installCommand: '' });
                if (path.startsWith('/v6/domains/'))
                    return Response.json({ misconfigured: false, recommendedCNAME: [{ rank: 1, value: 'fixture.vercel-dns.com' }] });
                if (path === '/v2/files')
                    return new Response(null, { status: 200 });
                if (path === '/v13/deployments') {
                    creates++;
                    const body = JSON.parse(String(init!.body)), d = { id: 'dpl_' + body.meta.sfSite, projectId: body.project, meta: body.meta, readyState: 'READY' };
                    deployments.set(d.id, d);
                    return Response.json(d);
                }
                if (path.startsWith('/v13/deployments/'))
                    return Response.json(deployments.get(path.split('/').at(-1)!));
                if (path.includes('/promote/')) {
                    promotes++;
                    return new Response(null, { status: 202 });
                }
                if (path.startsWith('/v4/aliases/'))
                    return Response.json({ alias: site!.domain, projectId: 'prj_' + site!.id, deploymentId: 'dpl_' + site!.id });
                throw new Error('Unexpected route ' + path);
            } });
        const publication = new PostgresPublication(queue, store, client, async () => ({ verifiedAt: 123456 }));
        const app = createApp({ repository: repo, queue, store, publication, auth: { verifyUser: async () => ({ userId: identities.admin, role: 'admin' }), verifyWorker: async () => ({ workerId: worker }) } });
        const transport: typeof fetch = async (input, init) => {
            const url = new URL(String(input));
            if (url.hostname === 'fixture.r2.cloudflarestorage.com') {
                await storage.put(url.pathname.slice(1), new Uint8Array(await new Response(init?.body).arrayBuffer()), new Headers(init?.headers).get('content-type')!);
                return new Response(null, { status: 200 });
            }
            const response = await app(new Request(url, init));
            if (url.pathname.endsWith('/claim')) {
                const value = await response.clone().json();
                if (value)
                    leases.set(value.job.id, value.lease);
            }
            // Wait for the independently running continuation to settle before losing the handoff response.
            if (url.pathname.endsWith('/publication') && !lost && response.ok) {
                lost = true;
                const id = (await response.clone().json()).id;
                for (let i = 0; i < 100 && (await publication.view(id)).settlement === 'pending'; i++) {
                    await pool.query('update private.provider_publications set retry_at=null');
                    await publication.advancePublication(id);
                }
                throw new Error('lost response after server settlement');
            }
            return response;
        };
        const fake = new FakeModel(), local = { clock: { now: Date.now }, workspace: join(root, 'attempts'), model: { async run(...args: Parameters<FakeModel['run']>) { models++; return fake.run(...args); } }, templates: { async load() { return [{ path: 'index.html', mediaType: 'text/html', bytes: Buffer.from('<html><main><h1 data-topic>Topic</h1><p data-description>Description</p></main></html>') }]; } }, validate: async () => ({ ok: true, issues: [], screenshotIds: [] }), delay: async () => { await new Promise(setImmediate); } } as unknown as WorkerDeps;
        const remote = createRemoteWorker({ controlOrigin: 'https://control.test', workerId: worker, workerToken: 'fixture', fetch: transport }, local), abort = new AbortController();
        const tick = remote.queue.continuePublications!;
        remote.queue.continuePublications = async () => {
            await pool.query('update private.provider_publications set retry_at=null');
            await tick();
            if ((await Promise.all(sites.map(s => repo.get(s.id)))).every(s => s!.publishedId))
                abort.abort();
        };
        await runWorker(remote, worker, AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]));
        expect((await Promise.all(sites.map(s => repo.get(s.id)))).every(s => s!.publishedId), JSON.stringify((await pool.query('select phase,data,settlement from private.provider_publications')).rows)).toBe(true);
        expect({ creates, promotes, models, lost }).toEqual({ creates: 2, promotes: 2, models: 2, lost: true });
        for (const site of sites) {
            const job = (await repo.current(site.id))!, lease = leases.get(job.id);
            expect(job.state).toBe('completed');
            const bound = await remote.bind!(job, lease);
            let writes = 0;
            bound.revisions.put = async () => { writes++; throw new Error('duplicate revision'); };
            bound.queue.checkpoint = async () => { writes++; throw new Error('duplicate checkpoint'); };
            await runJob(job, lease, bound, new AbortController().signal);
            expect(writes).toBe(0);
        }
        expect(creates).toBe(2);
        expect(promotes).toBe(2);
    }
    finally {
        await pool.end();
        await rm(root, { recursive: true, force: true });
    }
});
