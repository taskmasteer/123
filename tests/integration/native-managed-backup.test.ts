import { expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { database, seedUsers, identities } from './database.js';
import { SupabaseRepository } from '../../packages/adapters/src/supabase-repository.js';
import { PostgresQueue } from '../../packages/adapters/src/postgres-queue.js';
import { R2Store, metadata, type ObjectTransport } from '../../packages/adapters/src/r2-store.js';
import { PostgresBackup } from '../../packages/adapters/src/postgres-backup.js';
import { PostgresBatches } from '../../packages/adapters/src/postgres-batches.js';
import { PostgresImportResources } from '../../packages/adapters/src/postgres-import-resources.js';
import { openLocalDatabase } from '../../packages/adapters/src/local-database.js';
import { createLocalState } from '../../packages/adapters/src/local-state.js';
import { createLocalRevisions } from '../../packages/adapters/src/local-revisions.js';
import { createLocalArtifacts } from '../../packages/adapters/src/local-artifacts.js';
import { NativeArchives } from '../../apps/worker/src/native-archives.js';
import { validateSite } from '../../apps/worker/src/validation/browser.js';
import { projectCheckpoint } from '../../packages/core/src/usage.js';
import { createApp } from '../../apps/control/src/app.js';
import { directory, cleanDirectories, site as fixtureFiles } from '../../apps/worker/test/fixtures.js';
class Objects implements ObjectTransport {
    data = new Map<string, {
        bytes: Uint8Array;
        mediaType: string;
    }>();
    async signPut(k: string) { return 'https://fixture.r2.cloudflarestorage.com/' + k; }
    async put(k: string, bytes: Uint8Array, mediaType: string) { if (this.data.has(k))
        throw new Error('immutable'); this.data.set(k, { bytes: bytes.slice(), mediaType }); }
    async get(k: string) { return this.data.get(k)!.bytes; }
    async head(k: string) { const f = this.data.get(k)!; return { size: f.bytes.length, mediaType: f.mediaType }; }
    async delete(k: string) { this.data.delete(k); }
}
it('copies actual managed original source, validation PNGs, import bytes and pinned catalog through the private encrypted archive with source installation unavailable', async () => {
    let pool = await database();
    await seedUsers(pool);
    const actor = { userId: identities.admin, role: 'admin' as const }, repo = new SupabaseRepository(pool), queue = new PostgresQueue(repo), objects = new Objects(), store = new R2Store(repo, objects, queue), worker = randomUUID(), root = await directory(), local = await openLocalDatabase(join(root, 'native')), sites = await createLocalState(join(root, 'native', 'sites'), { now: Date.now }, local), revisions = await createLocalRevisions(local.root, local), artifacts = await createLocalArtifacts(join(local.root, 'artifacts')), requests: string[] = [];
    try {
        await pool.query("insert into private.workers(id,name,token_hash) values($1,'source worker',$2)", [worker, 'a'.repeat(64)]);
        const site = await repo.create({ domain: 'independent-native.example' }, actor), claim = (await queue.claim(worker))!, files = fixtureFiles('<h1>Independent managed source</h1>'), validationRoot = await directory(), report = await validateSite(files, { screenshotRoot: validationRoot });
        expect(report.ok).toBe(true);
        for (const path of report.screenshotIds) {
            const f = { path, mediaType: 'image/png', bytes: await readFile(join(validationRoot, path.slice(11))) }, prepared = await store.prepare(worker, { lease: claim.lease, purpose: 'validation', files: [metadata(f)], templateVersion: '1.0.0', expectedCheckpointId: null });
            await objects.put(prepared.files[0]!.objectKey, f.bytes, f.mediaType);
            await store.complete(worker, prepared.uploadId, claim.lease);
        }
        const manifest = await store.put(site.id, files, '1.0.0'), revisionId = randomUUID(), state = { jobId: site.id, siteId: site.id, baseRevision: 0, revisionId, parentRevisionId: null, revisionCreatedAt: 1, manifestId: manifest.id, selection: { seed: 1, styleId: 'editorial', templateVersion: '1.0.0' }, validation: report, transcript: [{ inputTokens: 7, outputTokens: 5 }], modelIdentity: 'demo' }, cp = await store.save({ ...claim.job, stage: 'completed' }, claim.lease, state, files);
        await queue.checkpoint(claim.lease, cp, null, projectCheckpoint(cp, state, files, null));
        await queue.finish(claim.lease, 'completed');
        await repo.transaction(async (tx) => { await tx.query("insert into public.revisions values($1,$2,null,$3,'published',1)", [revisionId, site.id, manifest.id]); await tx.query('update public.sites set published_id=$2,revision=1 where id=$1', [site.id, revisionId]); });
        const csv = Buffer.from('domain,about\nimport-source.example,Original import data\n'), imports = new PostgresImportResources(new PostgresBatches(repo)), resource = await imports.request(actor, 'resource.begin', { name: 'original.csv', size: csv.length, sha256: createHash('sha256').update(csv).digest('hex') }) as {
            id: string;
        };
        await imports.request(actor, 'resource.chunk', { id: resource.id, index: 0, base64: csv.toString('base64') });
        await imports.request(actor, 'import.prepare', { id: resource.id });
        let app = createApp({ repository: repo, queue, store, backup: new PostgresBackup(repo, store), auth: { verifyUser: async () => actor, verifyWorker: async () => { throw new Error('unused'); } } });
        const native = new NativeArchives({ native: true, root: local.root, baseRoot: join(root, 'native'), sourceRoot: resolve('.'), database: local, sites, revisions, artifacts, quiesce: async (capture) => capture(), close: async () => { throw new Error('Managed restore never switches local root'); }, fetch: async (input, init) => { const url = String(input); requests.push(String(init?.body ?? '')); return app(new Request(url, init)); } }), source = { origin: 'https://source.test', accessToken: 'source-admin-token' };
        const completed = async (id: string, remote: typeof source) => {
            let result: any;
            await expect.poll(async () => {
                result = await native.request({ action: 'status', id, remote });
                if (result.state === 'failed')
                    throw new Error(result.error);
                return result.state;
            }, { timeout: 30000 }).toBe('ready');
            return result.result;
        };
        const made = await native.request({ action: 'backup', passphrase: 'independent managed password', remote: source }) as {
            id: string;
        }, handle = await completed(made.id, source);
        expect(handle.handle.kind).toBe('backup');
        const exported = join(root, 'independent.sfbak');
        await native.request({ action: 'save', id: made.id, destination: exported, remote: source });
        await native.request({ action: 'close', id: made.id, remote: source });
        expect((await readFile(exported)).includes(Buffer.from('Independent managed source'))).toBe(false);
        expect(requests.join('\n')).not.toContain('independent managed password');
        await pool.end();
        objects.data.clear();
        pool = await database();
        await seedUsers(pool);
        const destination = randomUUID();
        await pool.query('insert into auth.users values($1)', [destination]);
        await pool.query("insert into public.users values($1,'fresh-admin@example.test')", [destination]);
        await pool.query("insert into public.memberships values($1,'admin',true)", [destination]);
        const targetRepo = new SupabaseRepository(pool), targetQueue = new PostgresQueue(targetRepo), targetObjects = new Objects(), targetStore = new R2Store(targetRepo, targetObjects, targetQueue), targetActor = { userId: destination, role: 'admin' as const }, backup = new PostgresBackup(targetRepo, targetStore, async (id) => (await pool.query('select id,email from public.users where id=$1', [id])).rows[0]);
        app = createApp({ repository: targetRepo, queue: targetQueue, store: targetStore, backup, auth: { verifyUser: async () => targetActor, verifyWorker: async () => { throw new Error('unused'); } } });
        const target = { origin: 'https://target.test', accessToken: 'fresh-admin-token' }, inspected = await native.request({ action: 'inspect', passphrase: 'independent managed password', archivePath: exported, remote: target }) as {
            id: string;
        }, review = await completed(inspected.id, target);
        expect(review.adapter).toBe('managed');
        await native.request({ action: 'map', id: inspected.id, remote: target, mappings: review.users.map((u: any) => ({ sourceId: u.id, destinationId: u.id === identities.admin ? destination : u.id })) });
        const installed = await native.request({ action: 'restore', id: inspected.id, mappings: [], remote: target }) as {
            id: string;
        };
        expect(await completed(installed.id, target)).toMatchObject({ restoredSites: 1, quarantined: true });
        expect((await targetRepo.get(site.id))!.ownerId).toBe(destination);
        expect((await targetStore.load(cp.id)).files).toEqual(files.map(f => ({ ...f, bytes: Buffer.from(f.bytes) })));
        expect(Buffer.from((await targetStore.read(manifest.id))[0]!.bytes)).toEqual(Buffer.from(files[0]!.bytes));
        for (const id of report.screenshotIds)
            expect(Buffer.from((await targetStore.readValidation(site.id, cp.id, id)).bytes)).toEqual(await readFile(join(validationRoot, id.slice(11))));
        expect((await targetStore.readPinnedTemplate('editorial', '1.0.0'))!.map(f => f.path)).toEqual(['index.html', 'styles.css']);
        expect((await pool.query('select bytes from private.import_chunks where resource_id=$1', [resource.id])).rows[0].bytes).toEqual(csv);
        expect((await pool.query("select count(*) n from private.recovery_snapshot_records where data->>'type'='chunk'")).rows[0].n).toBe('0');
        expect((await pool.query("select data from private.recovery_state where key='installation'")).rows[0].data.authMapping[identities.admin]).toBe(destination);
        expect((await readdir(join(root, 'native', '.exports'))).filter(n => n.endsWith('.sfbak'))).toEqual([]);
    }
    finally {
        await pool.end();
        await sites.close();
        await local.close();
        await cleanDirectories();
    }
}, 60000);
