import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { database, seedUsers, identities } from './database.js';
import { SupabaseRepository } from '../../packages/adapters/src/supabase-repository.js';
import { PostgresBatches } from '../../packages/adapters/src/postgres-batches.js';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { createApp } from '../../apps/control/src/app.js';
import { PostgresQueue } from '../../packages/adapters/src/postgres-queue.js';
import { writeFile } from 'node:fs/promises';
it('locks only one admission candidate while a competing worker waits for capacity serialization', async () => {
    const pool = await database(), gate = await pool.connect();
    let pending: Promise<unknown> | undefined;
    let gateHeld = false;
    try {
        await seedUsers(pool);
        const repo = new SupabaseRepository(pool), queue = new PostgresQueue(repo), worker = randomUUID(), actor = { userId: identities.user, role: 'user' } as const;
        await pool.query('insert into private.workers(id,name,token_hash) values($1,$2,$3)', [worker, 'fixture', 'b'.repeat(64)]);
        await new PostgresBatches(repo).submitBatch(actor, Array.from({ length: 4 }, (_, i) => ({ rowNumber: i + 2, domain: `candidate-${i}.test` })), 'candidates');
        await pool.query("create function private.block_claim_fixture() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(7654321); return new; end $$;create trigger block_claim_fixture before update on private.workers for each row execute function private.block_claim_fixture()");
        await gate.query('begin');
        gateHeld = true;
        await gate.query('select pg_advisory_xact_lock(7654321)');
        pending = queue.claim(worker);
        await expect.poll(async () => Number((await pool.query("select count(*) n from pg_locks where locktype='advisory' and objid=7654321 and not granted")).rows[0].n)).toBeGreaterThan(0);
        const available = await pool.query('select id from public.sites order by id for update skip locked');
        expect(available.rows).toHaveLength(3);
        await gate.query('rollback');
        gateHeld = false;
        const first = await pending as Awaited<ReturnType<typeof queue.claim>>;
        pending = undefined;
        expect(first).not.toBeNull();
        const second = await queue.claim(worker);
        expect(second).not.toBeNull();
        expect(second!.job.id).not.toBe(first!.job.id);
        expect(await queue.claim(worker)).toBeNull();
        await queue.finish(second!.lease, 'needs_attention');
        expect(await queue.claim(worker)).not.toBeNull();
    }
    finally {
        if (gateHeld)
            await gate.query('rollback');
        gate.release();
        await pending;
        await pool.end();
    }
});
it('atomically admits canonical rows, replays exact requests, isolates conflicts and enforces explicit assignment provenance', async () => {
    const pool = await database();
    try {
        await seedUsers(pool);
        const repo = new SupabaseRepository(pool), b = new PostgresBatches(repo), owner = { userId: identities.user, role: 'user' } as const, admin = { userId: identities.admin, role: 'admin' } as const, spec = { userId: identities.spec, role: 'spec-user' } as const;
        const rows = [{ rowNumber: 2, domain: 'пример.рф', about: 'First exact description' }, { rowNumber: 3, domain: 'xn--e1afmkfd.xn--p1ai' }, { rowNumber: 4, domain: 'other.test' }];
        const results = await Promise.all([b.submitBatch(owner, rows, 'same'), b.submitBatch(owner, rows, 'same')]);
        expect(results[0]!.siteIds).toHaveLength(2);
        expect(results[1]).toEqual(results[0]);
        await expect(b.submitBatch(owner, [{ rowNumber: 2, domain: 'changed.test' }], 'same')).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(Number((await pool.query('select count(*) n from private.site_operations')).rows[0].n)).toBe(2);
        const id = results[0]!.batchId;
        await expect(b.request(spec, 'batch.get', { id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await b.request(admin, 'batch.assign', { id, userIds: [spec.userId] });
        expect(await b.request(spec, 'batch.get', { id })).toMatchObject({ canControl: false });
        await expect(b.request(spec, 'batch.cancel', { id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
        const siteId = results[0]!.siteIds[0]!;
        await pool.query('insert into public.assignments values($1,$2)', [siteId, spec.userId]);
        await b.request(admin, 'batch.assign', { id, userIds: [] });
        expect((await repo.get(siteId))!.assignedUserIds).toContain(spec.userId);
        expect((await repo.get(results[0]!.siteIds[1]!))!.assignedUserIds).not.toContain(spec.userId);
        await b.request(admin, 'batch.assign', { id, userIds: [spec.userId] });
        const rls = await pool.connect();
        try {
            await rls.query('set role authenticated');
            await rls.query("select set_config('request.jwt.claim.sub',$1,false)", [spec.userId]);
            expect((await rls.query('select id from public.sites')).rows).toHaveLength(2);
            await expect(rls.query('select * from private.batch_rows')).rejects.toMatchObject({ code: '42501' });
        }
        finally {
            await rls.query('reset role');
            rls.release();
        }
        await b.request(owner, 'batch.pause', { id });
        expect((await pool.query('select pause_requested from private.jobs')).rows.every(r => r.pause_requested)).toBe(true);
        await b.request(owner, 'batch.resume', { id });
        const laterEdit = randomUUID();
        await pool.query("update private.jobs set data=jsonb_set(data,'{state}','\"completed\"') where id=$1", [siteId]);
        await pool.query("insert into private.jobs(id,site_id,data) values($1,$2,$3)", [laterEdit, siteId, { id: laterEdit, siteId, kind: 'edit', stage: 'brief', state: 'queued', checkpointId: null, baseRevision: 0 }]);
        await pool.query("update private.site_operations set operation_id=$2 where site_id=$1", [siteId, laterEdit]);
        await b.request(owner, 'batch.cancel', { id });
        expect((await pool.query("select data->>'state' state from private.jobs where id=$1", [laterEdit])).rows[0].state).toBe('queued');
        expect((await pool.query('select operation_id from private.site_operations where site_id=$1', [siteId])).rows[0].operation_id).toBe(laterEdit);
        expect((await pool.query("select data->>'state' state from private.jobs where batch_id=$1", [id])).rows.map(r => r.state).sort()).toEqual(['cancelled', 'completed']);
    }
    finally {
        await pool.end();
    }
});
it('pages 5000 managed registry records with stable scoped filters and a serialized byte budget', async () => {
    const pool = await database();
    const timings: Record<string, number> = {};
    try {
        await seedUsers(pool);
        const repo = new SupabaseRepository(pool), actor = { userId: identities.user, role: 'user' } as const;
        let t = performance.now();
        await pool.query("insert into public.sites(id,domain,owner_id,input) select ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'managed-'||n||'.test',$1,jsonb_build_object('domain','managed-'||n||'.test','about',repeat('中',300)) from generate_series(1,5000) n", [actor.userId]);
        timings.seedMs = performance.now() - t;
        t = performance.now();
        const ids: string[] = [];
        let cursor: string | undefined;
        let maxPageBytes = 0;
        do {
            const page = await repo.list(actor, cursor, 100);
            maxPageBytes = Math.max(maxPageBytes, Buffer.byteLength(JSON.stringify(page)));
            ids.push(...page.items.map(s => s.id));
            cursor = page.nextCursor ?? undefined;
        } while (cursor);
        timings.pagesMs = performance.now() - t;
        expect(new Set(ids).size).toBe(5000);
        expect(ids).toEqual([...ids].sort());
        expect(maxPageBytes).toBeLessThan(1000000);
        const filters = { domain: 'managed-1' }, filtered: string[] = [];
        cursor = undefined;
        do {
            const page = await repo.list(actor, cursor, 37, filters);
            filtered.push(...page.items.map(s => s.domain));
            if (!cursor && page.nextCursor) {
                await expect(repo.list(actor, page.nextCursor, 37, { domain: 'managed-2' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
                await expect(repo.list({ ...actor, role: 'admin' }, page.nextCursor, 37, filters)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
            }
            cursor = page.nextCursor ?? undefined;
        } while (cursor);
        expect(filtered).toHaveLength(1111);
        expect(new Set(filtered).size).toBe(1111);
        expect(filtered.every(d => d.includes('managed-1'))).toBe(true);
        await writeFile('.local-state/task-10-managed-registry-measurement.json', JSON.stringify({ records: 5000, maxPageBytes, ...timings, rssBytes: process.memoryUsage().rss }));
    }
    finally {
        await pool.end();
    }
});
it('wires staged HTTP source and PNG mapping through fresh services to a lease-bound worker logo resource', async () => {
    const pool = await database();
    try {
        await seedUsers(pool);
        const repo = new SupabaseRepository(pool), queue = new PostgresQueue(repo), worker = randomUUID();
        await pool.query('insert into private.workers(id,name,token_hash) values($1,$2,$3)', [worker, 'fixture', 'a'.repeat(64)]);
        const actor = { userId: identities.user, role: 'user' } as const;
        const app = createApp({ repository: repo, queue, auth: { verifyUser: async () => actor, verifyWorker: async () => ({ workerId: worker }) } });
        const call = async (method: string, params: unknown) => { const response = await app(new Request('https://control.test/batches/commands', { method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) })); const value = await response.json(); expect(response.status, JSON.stringify(value)).toBe(200); return value; };
        const upload = async (name: string, bytes: Buffer, extra: Record<string, unknown> = {}) => { const r = await call('resource.begin', { name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ...extra }); await call('resource.chunk', { id: r.id, index: 0, base64: bytes.toString('base64') }); return r.id; };
        const id = await upload('source.csv', Buffer.from('domain,about,logo\nlogo.test,Original,brand.png\n' + Array.from({ length: 29 }, (_, i) => `row-${i + 1}.test,Row ${i + 1},`).join('\n') + '\n,Invalid,\n'));
        let s = await call('import.prepare', { id });
        s = await call('import.update', { id, revision: s.revision, rowNumber: 2, about: 'Exact edited row' });
        const png = PNG.sync.write(new PNG({ width: 2, height: 3 })), logo = await upload('brand.png', png, { draftId: id, rowNumber: 2, revision: s.revision });
        s = await call('logo.complete', { id: logo });
        expect(await call('import.commit', { id, revision: s.revision, requestKey: 'same' })).toEqual({ batchId: id });
        expect((await call('batch.rows', { id })).items).toHaveLength(5);
        expect(Number((await pool.query('select count(*) n from public.sites')).rows[0].n)).toBe(25);
        const batchService = new PostgresBatches(repo);
        await batchService.request({ userId: identities.admin, role: 'admin' }, 'batch.assign', { id, userIds: [identities.spec] });
        await new PostgresBatches(repo).advance();
        expect((await repo.get((await pool.query("select id from public.sites where domain='row-29.test'")).rows[0].id))!.assignedUserIds).toContain(identities.spec);
        await pool.query("update private.jobs j set pause_requested=true from public.sites s where j.site_id=s.id and s.domain<>'logo.test'");
        const claim = (await queue.claim(worker))!;
        const get = () => app(new Request(`https://control.test/worker/jobs/${claim.job.id}/logo`, { method: 'POST', headers: { authorization: 'Bearer worker', 'content-type': 'application/json' }, body: JSON.stringify({ lease: claim.lease, id: logo }) }));
        const image = await get();
        expect(image.status).toBe(200);
        expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
        await queue.cancel(claim.job.id, actor);
        expect((await get()).status).toBe(409);
        const tooLarge = await app(new Request('https://control.test/batches/commands', { method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' }, body: JSON.stringify({ method: 'resource.chunk', params: { id, index: 1, base64: 'A'.repeat(65000) } }) }));
        expect(tooLarge.status).toBe(400);
    }
    finally {
        await pool.end();
    }
});
