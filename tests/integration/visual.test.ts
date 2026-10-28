import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { database, seedUsers, identities } from './database.js';
import { SupabaseRepository } from '../../packages/adapters/src/supabase-repository.js';
import { PostgresQueue } from '../../packages/adapters/src/postgres-queue.js';
import { R2Store, type ObjectTransport } from '../../packages/adapters/src/r2-store.js';
import { createApp } from '../../apps/control/src/app.js';
import { runJob } from '../../apps/worker/src/pipeline.js';
import { validateStatic } from '../../apps/worker/src/validation/static.js';
import { site as fixtureFiles, directory, cleanDirectories } from '../../apps/worker/test/fixtures.js';
import { createEditableMap } from '../../packages/core/src/visual/editable-map.js';
import { AppError } from '../../packages/contracts/src/model.js';
class MemoryObjects implements ObjectTransport {
    data = new Map<string, {
        bytes: Uint8Array;
        mediaType: string;
    }>();
    async signPut(key: string) { return 'https://objects.test/' + key; }
    async put(key: string, bytes: Uint8Array, mediaType: string) {
        if (this.data.has(key))
            throw new Error('Immutable');
        this.data.set(key, { bytes: bytes.slice(), mediaType });
    }
    async head(key: string) { const v = this.data.get(key)!; return { size: v.bytes.length, mediaType: v.mediaType }; }
    async get(key: string) { return this.data.get(key)!.bytes; }
}
test.each(['normal', 'final-revoked', 'observed-restored'])('unenrolled spec-user scoped projection and durable Save, authority scenario=%s', async (scenario) => {
    const revoke = scenario !== 'normal';
    const pool = await database();
    try {
        await seedUsers(pool);
        const repo = new SupabaseRepository(pool), queue = new PostgresQueue(repo), store = new R2Store(repo, new MemoryObjects(), queue), actor = { userId: identities.spec, role: 'spec-user' as const };
        const site = await repo.create({ domain: 'visual-managed.example' }, actor), files = fixtureFiles('<h1>Original managed heading</h1><script>window.generated=true;</script>'), base = await store.put(site.id, files, 'existing'), baseRevision = randomUUID();
        await pool.query("insert into public.revisions values($1,$2,null,$3,'published',1)", [baseRevision, site.id, base.id]);
        await pool.query('update public.sites set published_id=$2 where id=$1', [site.id, baseRevision]);
        await pool.query("update private.jobs set data=jsonb_set(data,'{state}','\"completed\"') where site_id=$1", [site.id]);
        const app = createApp({ repository: repo, queue, store, auth: { verifyUser: async (token) => token === 'admin' ? { userId: identities.admin, role: 'admin' } : actor, verifyWorker: async () => { throw new AppError('UNAUTHENTICATED', 'Not enrolled'); } } });
        const request = (path: string, method = 'GET', body?: unknown, token = 'spec') => app(new Request('https://control.test' + path, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }));
        const descriptor = await (await request(`/sites/${site.id}/visual/projection?expectedRevision=0`)).json();
        expect(descriptor.size).toBeGreaterThan(0);
        let projected = '';
        for (let index = 0; index * 24000 < descriptor.size; index++) {
            const chunk = await (await request(`/sites/${site.id}/visual/projection?expectedRevision=0&mapId=${descriptor.mapId}&index=${index}`)).json();
            projected += Buffer.from(chunk.base64, 'base64').toString();
        }
        expect(projected).not.toContain('<script>');
        expect(projected).not.toContain('window.generated');
        const map = createEditableMap(files, { siteId: site.id, revisionId: baseRevision, manifestId: base.id });
        const body = { expectedRevision: 0, mapId: descriptor.mapId, requestKey: 'one-save', patch: { elementId: map.elements.find(e => e.tag === 'h1')!.elementId, text: 'Managed manual saved title' } };
        const submitted = await request(`/sites/${site.id}/visual/saves`, 'POST', body);
        expect(submitted.status).toBe(200);
        const save = await submitted.json();
        expect((await request(`/sites/${site.id}/visual/saves/${save.saveId}`)).status).toBe(200);
        const replay = await request(`/sites/${site.id}/visual/saves`, 'POST', body);
        expect(replay.status).toBe(200);
        expect((await replay.json()).saveId).toBe(save.saveId);
        const worker = randomUUID();
        await pool.query("insert into private.workers(id,name,token_hash) values($1,'visual worker',$2)", [worker, worker.replaceAll('-', '').repeat(2)]);
        const claim = (await queue.claim(worker, 'visual'))!;
        const cachedCandidate = structuredClone((await repo.editingState(site.id)).candidates[0]!);
        if (revoke)
            await pool.query("update public.memberships set role='user' where user_id=$1", [actor.userId]);
        if (scenario === 'observed-restored') {
            expect((await request(`/sites/${site.id}/visual/saves/${save.saveId}`)).status).toBe(403);
            expect((await repo.editingState(site.id)).candidates[0]!.visualSave?.state).toBe('failed');
            await pool.query("update public.memberships set role='spec-user' where user_id=$1", [actor.userId]);
        }
        await runJob(claim.job, claim.lease, { queue, sites: { get: id => repo.get(id), create: (v, p) => repo.create(v, p), list: (p, c, l) => repo.list(p, c, l), compareAndSet: async () => { throw new Error('Worker cannot install visual draft'); } }, artifacts: store, checkpoints: store, revisions: { get: id => repo.revision(id), put: async () => { throw new Error('Controller registers visual candidate'); } }, model: { identity: 'unavailable', run: async () => { throw new Error('No configured model'); } }, clock: { now: Date.now }, templates: { load: async () => { throw new Error('No template reload'); } }, publication: { advance: async () => { throw new Error('No implicit publish'); } }, workspace: await directory(), validate: async (f) => validateStatic(f) }, new AbortController().signal);
        const status = await request(`/sites/${site.id}/visual/saves/${save.saveId}`, 'GET', undefined, 'admin');
        expect(status.status, await status.clone().text()).toBe(200);
        const result = await status.json();
        expect(result.status).toBe(revoke ? 'failed' : 'completed');
        const installed = (await repo.get(site.id))!;
        expect(installed.publishedId).toBe(baseRevision);
        expect(installed.revision).toBe(revoke ? 0 : 1);
        if (revoke) {
            await pool.query("update public.memberships set role='spec-user' where user_id=$1", [actor.userId]);
            const replayed = await request(`/sites/${site.id}/visual/saves`, 'POST', body);
            expect(replayed.status).toBe(200);
            expect((await replayed.json()).status).toBe('failed');
            expect((await (await request(`/sites/${site.id}/visual/saves/${save.saveId}`, 'GET', undefined, 'admin')).json()).status).toBe('failed');
            const admission = await repo.acquire({ userId: identities.admin, role: 'admin' }, site.id);
            try {
                await expect(repo.compareAndSet(site.id, 0, { draftId: save.saveId }, admission, actor.userId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
                await expect(repo.editingStore(admission).transaction(state => { state.candidates[0] = cachedCandidate; return { value: state, result: undefined }; })).rejects.toMatchObject({ code: 'CONFLICT' });
            }
            finally {
                await repo.release(admission);
            }
            expect((await repo.get(site.id))!.revision).toBe(0);
        }
        if (!revoke) {
            expect(result.revision.id).toBe(installed.draftId);
            expect(new TextDecoder().decode((await store.read(result.revision.manifestId))[0]!.bytes)).toContain('Managed manual saved title');
        }
    }
    finally {
        await pool.end();
        await cleanDirectories();
    }
});
