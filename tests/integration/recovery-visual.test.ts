import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { database, seedUsers, identities } from './database.js';
import { SupabaseRepository } from '../../packages/adapters/src/supabase-repository.js';
import { PostgresQueue } from '../../packages/adapters/src/postgres-queue.js';
import { R2Store, type ObjectTransport } from '../../packages/adapters/src/r2-store.js';
import { PostgresBackup } from '../../packages/adapters/src/postgres-backup.js';
import { PostgresRetention } from '../../packages/adapters/src/postgres-retention.js';
import { createApp } from '../../apps/control/src/app.js';
import { runJob } from '../../apps/worker/src/pipeline.js';
import { validateStatic } from '../../apps/worker/src/validation/static.js';
import { site as fixtureFiles, directory, cleanDirectories } from '../../apps/worker/test/fixtures.js';
import { createEditableMap } from '../../packages/core/src/visual/editable-map.js';
import { AppError } from '../../packages/contracts/src/model.js';
import { validateSite } from '../../apps/worker/src/validation/browser.js';
import { metadata } from '../../packages/adapters/src/r2-store.js';
import { projectCheckpoint } from '../../packages/core/src/usage.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PostgresPublication } from '../../packages/adapters/src/postgres-publication.js';
import { VercelClient } from '../../packages/adapters/src/vercel/client.js';
import { appendInstalledCatalog } from './recovery-fixture.js';
class Objects implements ObjectTransport {
    data = new Map<string, {
        bytes: Uint8Array;
        mediaType: string;
    }>();
    async signPut(key: string) { return 'https://fixture.test/' + key; }
    async put(key: string, bytes: Uint8Array, mediaType: string) { if (this.data.has(key))
        throw new Error('immutable'); this.data.set(key, { bytes: bytes.slice(), mediaType }); }
    async get(key: string) { return this.data.get(key)!.bytes; }
    async head(key: string) { const f = this.data.get(key)!; return { size: f.bytes.length, mediaType: f.mediaType }; }
    async delete(key: string) { this.data.delete(key); }
}
it('remaps pending original visual saver, blocks status autoaccept while quarantined, and accepts from evidence after detail pruning', async () => {
    let pool = await database();
    await seedUsers(pool);
    let repo = new SupabaseRepository(pool), queue = new PostgresQueue(repo), objects = new Objects(), store = new R2Store(repo, objects, queue);
    const actor = { userId: identities.spec, role: 'spec-user' as const }, admin = { userId: identities.admin, role: 'admin' as const };
    const site = await repo.create({ domain: 'restore-visual.example' }, actor), files = fixtureFiles('<h1>Before restored Save</h1>'), base = await store.put(site.id, files, '1.0.0'), revisionId = randomUUID();
    await repo.transaction(async (tx) => { await tx.query("insert into public.revisions values($1,$2,null,$3,'published',1)", [revisionId, site.id, base.id]); await tx.query('update public.sites set published_id=$2 where id=$1', [site.id, revisionId]); await tx.query("update private.jobs set data=jsonb_set(data,'{state}','\"completed\"') where id=$1", [site.id]); });
    const makeApp = (identity = actor) => createApp({ repository: repo, queue, store, auth: { verifyUser: async () => identity, verifyWorker: async () => { throw new AppError('UNAUTHENTICATED', 'unused'); } } });
    let app = makeApp();
    const request = (path: string, method = 'GET', body?: unknown) => app(new Request('https://control.test' + path, { method, headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    const map = createEditableMap(files, { siteId: site.id, revisionId, manifestId: base.id }), submitted = await request(`/sites/${site.id}/visual/saves`, 'POST', { expectedRevision: 0, mapId: map.binding.mapId, requestKey: 'pending-portable-save', patch: { elementId: map.elements.find(e => e.tag === 'h1')!.elementId, text: 'Restored verified saver' } });
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    const save = await submitted.json();
    const worker = randomUUID();
    await pool.query("insert into private.workers(id,name,token_hash) values($1,'visual',$2)", [worker, 'a'.repeat(64)]);
    const claim = (await queue.claim(worker, 'visual'))!;
    await runJob(claim.job, claim.lease, { queue, sites: { get: id => repo.get(id), create: (i, a) => repo.create(i, a), list: (a, c, l) => repo.list(a, c, l), compareAndSet: async () => { throw new Error('controller only'); } }, artifacts: store, checkpoints: store, revisions: { get: id => repo.revision(id), put: async () => { throw new Error('controller only'); } }, model: { identity: 'unavailable', run: async () => { throw new Error('visual never invokes provider'); } }, clock: { now: Date.now }, templates: { load: async () => { throw new Error('visual never reloads template'); } }, publication: { advance: async () => { throw new Error('no provider'); } }, workspace: await directory(), validate: async (f) => validateStatic(f) }, new AbortController().signal);
    const original = (await repo.editingState(site.id)).candidates[0]!, checkpoint = (await pool.query('select checkpoint_id from private.jobs where id=$1', [claim.job.id])).rows[0].checkpoint_id as string;
    expect(original.visualSave?.state).toBe('pending');
    const backup = new PostgresBackup(repo, store), snapshot = await backup.beginSnapshot(admin), records: any[] = [], payloads = new Map<number, Uint8Array>();
    for (let seq = 0; seq < snapshot.records; seq++) {
        let raw = '';
        for (let offset = 0;;) {
            const chunk = await backup.record(admin, snapshot.id, seq, offset);
            raw += Buffer.from(chunk.base64, 'base64').toString();
            if (chunk.nextOffset === null)
                break;
            offset = chunk.nextOffset;
        }
        const record = JSON.parse(raw);
        records.push(record);
        if (record.type === 'file') {
            const parts = [];
            for (let offset = 0;;) {
                const chunk = await backup.resource(admin, snapshot.id, seq, offset);
                parts.push(Buffer.from(chunk.base64, 'base64'));
                if (chunk.nextOffset === null)
                    break;
                offset = chunk.nextOffset;
            }
            payloads.set(seq, Buffer.concat(parts));
        }
    }
    await appendInstalledCatalog(records, payloads);
    await pool.end();
    objects.data.clear();
    pool = await database();
    await seedUsers(pool);
    const mapped = randomUUID();
    await pool.query('insert into auth.users values($1)', [mapped]);
    await pool.query("insert into public.users values($1,'mapped@example.test')", [mapped]);
    await pool.query("insert into public.memberships values($1,'spec-user',true)", [mapped]);
    repo = new SupabaseRepository(pool);
    queue = new PostgresQueue(repo);
    objects = new Objects();
    store = new R2Store(repo, objects, queue);
    const target = new PostgresBackup(repo, store, async (id) => (await pool.query('select id,email from public.users where id=$1', [id])).rows[0]);
    try {
        const restore = await target.beginRestore(admin, records[0], Object.values(identities).map(id => ({ sourceId: id, destinationId: id === identities.spec ? mapped : id })), records.length);
        for (const [seq, record] of records.entries())
            await target.stageRecord(admin, restore.id, seq, record);
        for (const [seq, bytes] of payloads) {
            for (let offset = 0, index = 0; offset < bytes.length; offset += 24000, index++)
                await target.stageChunk(admin, restore.id, seq, index, Buffer.from(bytes.subarray(offset, offset + 24000)).toString('base64'));
            await target.finishObject(admin, restore.id, seq);
        }
        await target.install(admin, restore.id);
        const restored = (await repo.editingState(site.id)).candidates[0]!;
        expect(restored.visualSave).toEqual({ ...original.visualSave, actorId: mapped });
        app = makeApp({ userId: mapped, role: 'spec-user' });
        expect((await request(`/sites/${site.id}/visual/saves/${save.saveId}`)).status).toBe(409);
        expect((await repo.get(site.id))!.draftId).toBeNull();
        expect((await repo.editingState(site.id)).candidates[0]!.visualSave?.state).toBe('pending');
        await target.release(admin);
        const retention = new PostgresRetention(repo, objects), later = Date.now() + 32 * 86400000;
        await retention.collect(later);
        await retention.collect(later + 86400001);
        await expect(store.load(checkpoint)).rejects.toThrow();
        expect((await store.evidence(checkpoint)).checkpoint.id).toBe(checkpoint);
        const accepted = await request(`/sites/${site.id}/visual/saves/${save.saveId}`);
        expect(accepted.status, await accepted.clone().text()).toBe(200);
        expect((await accepted.json()).status).toBe('completed');
        expect((await repo.get(site.id))!.draftId).toBe(save.saveId);
        expect((await repo.editingState(site.id)).candidates[0]!.visualSave?.actorId).toBe(mapped);
        const descriptor = await request(`/sites/${site.id}/visual/projection?expectedRevision=1`);
        expect(descriptor.status, await descriptor.clone().text()).toBe(200);
        expect((await descriptor.json()).size).toBeGreaterThan(0);
        const edit = await request(`/sites/${site.id}/edits`, 'POST', { instruction: 'Keep restored original content', expectedRevision: 1 });
        expect(edit.status, await edit.clone().text()).toBe(200);
        const laterJob = await edit.json();
        await queue.cancel(laterJob.id, { userId: mapped, role: 'spec-user' });
        expect((await request(`/sites/${site.id}/candidates`)).status).toBe(200);
        let providerCalls = 0;
        const publisher = new PostgresPublication(queue, store, new VercelClient({ token: 'fixture', accountId: 'team_restored', fetch: async () => { providerCalls++; throw new Error('no external provider'); } }), async () => ({ verifiedAt: Date.now() })), intent = await publisher.requestPublication(admin, site.id, save.saveId, 1, randomUUID());
        expect(intent.revisionId).toBe(save.saveId);
        expect(intent.phase).toBe('pending');
        expect(providerCalls).toBe(0);
    }
    finally {
        await pool.end();
        await cleanDirectories();
    }
});
it('uploads real headless validation PNGs with exact lease provenance, authorized read and independent snapshot bytes', async () => {
    const pool = await database();
    await seedUsers(pool);
    const repo = new SupabaseRepository(pool), queue = new PostgresQueue(repo), objects = new Objects(), store = new R2Store(repo, objects, queue), actor = { userId: identities.spec, role: 'spec-user' as const }, admin = { userId: identities.admin, role: 'admin' as const };
    try {
        const site = await repo.create({ domain: 'validation-copy.example' }, actor), worker = randomUUID();
        await pool.query("insert into private.workers(id,name,token_hash) values($1,'PNG worker',$2)", [worker, 'c'.repeat(64)]);
        const claim = (await queue.claim(worker))!, root = await directory(), files = fixtureFiles('<h1>Verified screenshot</h1>'), report = await validateSite(files, { screenshotRoot: root });
        expect(report.ok).toBe(true);
        expect(report.screenshotIds).toHaveLength(2);
        const pngs = [];
        for (const id of report.screenshotIds) {
            const file = { path: id, mediaType: 'image/png', bytes: await readFile(join(root, id.slice(11))) }, prepared = await store.prepare(worker, { lease: claim.lease, purpose: 'validation', templateVersion: '1.0.0', files: [metadata(file)], expectedCheckpointId: null });
            await objects.put(prepared.files[0]!.objectKey, file.bytes, 'image/png');
            await store.complete(worker, prepared.uploadId, claim.lease);
            pngs.push(file);
        }
        const manifest = await store.put(site.id, files, '1.0.0'), state = { jobId: site.id, siteId: site.id, manifestId: manifest.id, baseRevision: 0, validation: report }, checkpoint = await store.save({ ...claim.job, stage: 'completed' }, claim.lease, state, []);
        await queue.checkpoint(claim.lease, checkpoint, null, projectCheckpoint(checkpoint, state, [], null));
        await queue.finish(claim.lease, 'completed');
        expect(Buffer.from((await store.readValidation(site.id, checkpoint.id, report.screenshotIds[0]!)).bytes)).toEqual(Buffer.from(pngs[0]!.bytes));
        await expect(store.readValidation(randomUUID(), checkpoint.id, report.screenshotIds[0]!)).rejects.toMatchObject({ code: 'NOT_FOUND' });
        const app = createApp({ repository: repo, queue, store, backup: new PostgresBackup(repo, store), auth: { verifyUser: async (token) => ({ userId: token === 'admin' ? identities.admin : token === 'user' ? identities.user : identities.spec, role: token === 'admin' ? 'admin' : token === 'user' ? 'user' : 'spec-user' }), verifyWorker: async () => { throw new AppError('UNAUTHENTICATED', 'unused'); } } }), request = (path: string, token = 'spec') => app(new Request('https://control.test' + path, { headers: { authorization: 'Bearer ' + token } })), path = `/sites/${site.id}/validation?checkpointId=${checkpoint.id}&imageId=${report.screenshotIds[0]}`;
        expect((await request(path)).status).toBe(200);
        expect((await request(path, 'user')).status).toBe(404);
        expect((await request(`/sites/${site.id}/source?revisionId=${randomUUID()}`)).status).toBe(403);
        const backup = new PostgresBackup(repo, store), snapshot = await backup.beginSnapshot(admin), pngRecords = (await pool.query("select seq,data from private.recovery_snapshot_records where snapshot_id=$1 and data->>'type'='file' and data->>'mediaType'='image/png'", [snapshot.id])).rows;
        expect(pngRecords).toHaveLength(2);
        for (const record of pngRecords) {
            let bytes = Buffer.alloc(0);
            for (let offset = 0;;) {
                const part = await backup.resource(admin, snapshot.id, Number(record.seq), offset);
                bytes = Buffer.concat([bytes, Buffer.from(part.base64, 'base64')]);
                if (part.nextOffset === null)
                    break;
                offset = part.nextOffset;
            }
            expect(pngs.some(p => Buffer.from(p.bytes).equals(bytes))).toBe(true);
        }
        await pool.query("update public.memberships set role='user' where user_id=$1", [identities.admin]);
        await expect(backup.record(admin, snapshot.id, 0, 0)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    finally {
        await pool.end();
        await cleanDirectories();
    }
});
