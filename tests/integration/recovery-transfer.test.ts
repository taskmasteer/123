import { PostgresRestorePreparation, recoveryDependencyFactsQuery } from '../../packages/adapters/src/postgres-restore-preparation.js';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { createAuth } from '../../apps/control/src/auth.js';
import { expect, it } from 'vitest';
import { database, identities, seedUsers } from './database.js';
import { SupabaseRepository } from '../../packages/adapters/src/supabase-repository.js';
import { R2Store } from '../../packages/adapters/src/r2-store.js';
import { PostgresBackup } from '../../packages/adapters/src/postgres-backup.js';
import { createApp } from '../../apps/control/src/app.js';
import { PostgresRecoveryTransfer, verifiedPngProofQuery } from '../../packages/adapters/src/postgres-recovery-transfer.js';
import { batchContent, transferCursor } from '../../packages/contracts/src/recovery-transfer.js';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { NativeArchives, type NativeArchiveDeps } from '../../apps/worker/src/native-archives.js';
import { directory, cleanDirectories } from '../../apps/worker/test/fixtures.js';
import { RecoveryTransferSpool, seedSmallBodyRecoveryVolume } from './recovery-transfer-fixture.js';
import { appendInstalledCatalog } from './recovery-fixture.js';
import { AppError } from '../../packages/contracts/src/model.js';
const digest = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
function metadataPart(record: unknown, seq: number) {
    const bytes = Buffer.from(JSON.stringify(record));
    return {
        seq, offset: 0, size: bytes.length, sha256: digest(bytes), base64: bytes.toString('base64'), complete: true
    };
}
function envelope(binding: any, kind: 'metadata' | 'resources', items: any[]) {
    const b = {
        binding, kind, cursor: transferCursor(binding, kind, items[0].seq, items[0].offset), items
    };
    return {
        ...b, digest: digest(batchContent(b))
    };
}
async function transferCase(records: number, run: (c: any) => Promise<void>) {
    const pool = await database();
    await seedUsers(pool);
    const objects = new Map<string, Uint8Array>(), actor = {
        userId: identities.admin, role: 'admin' as const
    }, repo = new SupabaseRepository(pool);
    const transport = {
        signPut: async () => '', put: async (k: string, b: Uint8Array) => { objects.set(k, b); }, get: async (k: string) => objects.get(k)!, head: async () => ({
            size: 0, mediaType: ''
        }), delete: async (k: string) => { objects.delete(k); }
    };
    const store = new R2Store(repo, transport), backup = new PostgresBackup(repo, store, async (id) => (await pool.query('select id,email from public.users where id=$1', [id])).rows[0]), header = {
        type: 'header', version: 1, adapter: 'managed', schema: 8, sourceId: randomUUID(), createdAt: 1
    } as const;
    const begun = await backup.beginRestore(actor, header, [], records), t = new PostgresRecoveryTransfer(backup, digest('fixture')), initial = await t.renew(actor, begun.id);
    try {
        await run({
            pool, objects, transport, actor, repo, store, backup, header, id: begun.id, t, binding: initial.binding
        });
    }
    finally {
        await pool.end();
    }
}
it('bounds fresh-table PNG-shape proof lookup to one same-restore proof per digest', () => transferCase(1, async (c) => {
    const { pool, id, actor, backup, header } = c, foreign = await backup.beginRestore(actor, header, [], 1);
    await pool.query("insert into private.recovery_snapshot_records select $1,4000000000+n,jsonb_build_object('type','verified','source','private/artifacts/fixture/'||n,'sha256',repeat('a',64),'pngVerified',false) from generate_series(1,10000) n", [id]);
    await pool.query("insert into private.recovery_snapshot_records select $1,4000020000+n,jsonb_build_object('type','verified','source','private/validation/fixture/'||n,'sha256',repeat('b',64),'pngVerified',true) from generate_series(1,1000) n", [id]);
    await pool.query("insert into private.recovery_snapshot_records values($1,4000000000,jsonb_build_object('type','verified','sha256',repeat('a',64),'pngVerified',true))", [foreign.id]);
    const hashes = ['a'.repeat(64), 'b'.repeat(64)];
    expect((await pool.query(verifiedPngProofQuery, [id, hashes])).rows).toEqual([{
            hash: 'b'.repeat(64)
        }]);
    const plan = (await pool.query('explain(analyze,buffers,format json) ' + verifiedPngProofQuery, [id, hashes])).rows[0]['QUERY PLAN'][0], nodes: any[] = [];
    const walk = (node: any) => {
        nodes.push(node);
        for (const child of node.Plans ?? [])
            walk(child);
    };
    walk(plan.Plan);
    expect(nodes.some(n => n['Index Name'] === 'recovery_verified_png_digest')).toBe(true);
    expect(nodes.reduce((n, p) => n + Number(p['Rows Removed by Filter'] ?? 0), 0)).toBe(0);
    expect(nodes.filter(n => n['Index Name']).every(n => Number(n['Actual Rows']) <= 1)).toBe(true);
    await writeFile('.local-state/task15-png-proof-plan.json', JSON.stringify(plan, null, 2));
}));
it('binds the verified session at issuance and fences every legacy recovery ID route', () => transferCase(1, async (c) => {
    const { repo, store, backup, actor, pool, id } = c;
    const app = createApp({
        repository: repo, store, backup, auth: {
            verifyUser: async () => actor, verifyWorker: async () => { throw new Error('unused'); }
        }
    });
    const made = await app(new Request('https://control.test/admin/recovery/snapshots', {
        method: 'POST', headers: {
            authorization: 'Bearer fixture', 'content-type': 'application/json'
        }, body: '{}'
    }));
    expect(made.status).toBe(200);
    const snapshot = await made.json(), scope = (await pool.query('select session_scope from private.recovery_transfers where id=$1', [snapshot.id])).rows;
    expect(scope).toEqual([{
            session_scope: digest('fixture')
        }]);
    const foreignRead = await app(new Request(`https://control.test/admin/recovery/snapshots/${snapshot.id}/record?seq=0`, {
        headers: {
            authorization: 'Bearer other-session'
        }
    }));
    expect(foreignRead.status).toBe(404);
    const foreignWrite = await app(new Request(`https://control.test/admin/recovery/restores/${id}/mappings`, {
        method: 'POST', headers: {
            authorization: 'Bearer other-session', 'content-type': 'application/json'
        }, body: '{"mappings":[]}'
    }));
    expect(foreignWrite.status).toBe(404);
    for (const action of ['record-part', 'record-complete', 'chunk', 'object-complete', 'install', 'close', 'mappings']) {
        const denied = await app(new Request(`https://control.test/admin/recovery/restores/${id}/${action}`, {
            method: 'POST', headers: {
                authorization: 'Bearer other-session', 'content-type': 'application/json'
            }, body: '{}'
        }));
        expect(denied.status).toBe(404);
    }
    const ownRead = await app(new Request(`https://control.test/admin/recovery/snapshots/${snapshot.id}/record?seq=0`, {
        headers: {
            authorization: 'Bearer fixture'
        }
    }));
    expect(ownRead.status).toBe(200);
}));
it('accepts only a cryptographically verified same-session token refresh on issued transfer IDs', () => transferCase(1, async (c) => {
    const { repo, backup, store, actor, pool } = c, { privateKey, publicKey } = await generateKeyPair('RS256'), jwk = await exportJWK(publicKey);
    jwk.kid = 'transfer';
    const auth = createAuth({
        issuer: 'https://auth.test', audience: 'authenticated', jwks: createLocalJWKSet({
            keys: [jwk]
        }), membership: id => repo.membership(id), worker: async () => null
    }), sid = randomUUID();
    const token = (session_id: string, nonce: string) => new SignJWT({
        session_id, nonce
    }).setIssuedAt().setSubject(actor.userId).setIssuer('https://auth.test').setAudience('authenticated').setExpirationTime('5m').setProtectedHeader({
        alg: 'RS256', kid: 'transfer'
    }).sign(privateKey);
    const first = await token(sid, 'first'), refresh = await token(sid, 'refresh'), other = await token(randomUUID(), 'other'), app = createApp({
        auth, repository: repo, backup, store
    });
    const post = (path: string, bearer: string, body: unknown = {}) => app(new Request('https://control.test' + path, {
        method: 'POST', headers: {
            authorization: 'Bearer ' + bearer, 'content-type': 'application/json'
        }, body: JSON.stringify(body)
    }));
    const made = await post('/admin/recovery/snapshots', first);
    expect(made.status).toBe(200);
    const { id } = await made.json();
    expect((await post('/admin/recovery/snapshots/' + id + '/renew', refresh)).status).toBe(200);
    expect((await post('/admin/recovery/snapshots/' + id + '/renew', other)).status).toBe(404);
    expect((await post('/admin/recovery/snapshots/' + id + '/renew', refresh + 'x')).status).toBe(401);
    await pool.query('update private.recovery_transfers set session_scope=null where id=$1', [id]);
    expect((await post('/admin/recovery/snapshots/' + id + '/renew', refresh)).status).toBe(404);
}));
it('keeps session membership current during an exclusive commit while real actions remain fenced', () => transferCase(1, async (c) => {
    const { repo, backup, store, actor, pool } = c, app = createApp({
        repository: repo, backup, store, auth: {
            verifyUser: async () => actor, verifyWorker: async () => { throw Error('unused'); }
        }
    }), held = await pool.connect();
    let blocked: Promise<Response> | undefined;
    try {
        await held.query('begin');
        await held.query('select pg_advisory_xact_lock(73212,1)');
        const request = (path: string) => app(new Request('https://control.test' + path, {
            headers: {
                authorization: 'Bearer fixture'
            }
        }));
        const session = await request('/session');
        expect(session.status).toBe(200);
        expect((await session.json()).principal.role).toBe('admin');
        blocked = request('/admin/recovery/status');
        await expect.poll(async () => Number((await pool.query("select count(*) n from pg_locks where locktype='advisory' and classid=73212 and objid=1 and not granted")).rows[0].n)).toBeGreaterThan(0);
        await pool.query("update public.memberships set role='user' where user_id=$1", [actor.userId]);
        const current = await request('/session');
        expect((await current.json()).capabilities.admin).toBe(false);
        await held.query('rollback');
        expect((await blocked).status).toBe(403);
    }
    finally {
        await held.query('rollback');
        held.release();
        await blocked?.catch(() => { });
    }
}));
it('upgrades legacy digest proofs through actual bounded bytes rather than manifest claims', () => transferCase(2, async (c) => {
    const { t, actor, id, binding, header, pool, transport } = c, bytes = Buffer.from('verified body'), file = {
        type: 'file', root: 'object', path: 'private/artifacts/' + randomUUID() + '/' + randomUUID() + '/files/0', payload: 'payloads/1.bin', mediaType: 'text/html', size: bytes.length, sha256: digest(bytes)
    };
    await t.stageBatch(actor, id, envelope(binding, 'metadata', [metadataPart(header, 0), metadataPart(file, 1)]));
    await t.stageBatch(actor, id, envelope(binding, 'resources', [{
            seq: 1, offset: 0, size: bytes.length, sha256: digest(bytes), base64: bytes.toString('base64'), complete: true
        }]));
    await pool.query("update private.recovery_snapshot_records set data=data-'sha1'-'mediaType' where snapshot_id=$1 and seq=4000000001", [id]);
    let reads = 0;
    const get = transport.get;
    transport.get = async (key: string) => { reads++; return get(key); };
    transport.head = async () => ({
        size: bytes.length, mediaType: 'text/html'
    });
    await t.prepareBatch(actor, id);
    expect(reads).toBe(1);
    const proof = (await pool.query('select data from private.recovery_snapshot_records where snapshot_id=$1 and seq=4000000001', [id])).rows[0].data;
    expect(proof.sha1).toBe(createHash('sha1').update(bytes).digest('hex'));
    expect(proof.mediaType).toBe('text/html');
}));
it('keeps old archive headers restorable while expired capabilities and pins never revive', () => transferCase(1, async (c) => {
    const { pool, t, actor, id, backup, header } = c, now = Date.now();
    const row = (await pool.query('select created_at,max_expires_at from private.recovery_transfers where id=$1', [id])).rows[0];
    expect(new Date(row.created_at).getTime()).toBeGreaterThan(now - 60000);
    expect(new Date(row.max_expires_at).getTime()).toBeGreaterThan(now + 23 * 3600000);
    await pool.query("insert into private.payload_pins values($1,'artifact',$2,clock_timestamp()-interval '1 second')", [id, randomUUID()]);
    await pool.query("update private.recovery_snapshots set expires_at=clock_timestamp()+interval '20 minutes' where id=$1", [id]);
    await t.renew(actor, id);
    expect((await pool.query('select expires_at<clock_timestamp() expired from private.payload_pins where id=$1', [id])).rows[0].expired).toBe(true);
    await pool.query("update private.recovery_snapshots set expires_at=clock_timestamp()-interval '1 second' where id=$1", [id]);
    await expect(t.renew(actor, id)).rejects.toMatchObject({
        code: 'NOT_FOUND'
    });
    const fresh = await backup.beginRestore(actor, header, [], 1);
    await expect(new PostgresRecoveryTransfer(backup).renew(actor, fresh.id)).resolves.toHaveProperty('phase', 'staging');
    await t.cancel(actor, id);
    await t.cancel(actor, id);
}));
it('rejects changed replay, gaps and another verified session without changing acknowledged bytes', () => transferCase(1, async (c) => {
    const { t, actor, id, binding, header, pool, backup } = c, batch = envelope(binding, 'metadata', [metadataPart(header, 0)]);
    await expect(t.stageBatch(actor, id, envelope(binding, 'metadata', [{
            ...metadataPart(header, 0), offset: 1
        }]))).rejects.toMatchObject({
        code: 'INVALID_INPUT'
    });
    await t.stageBatch(actor, id, batch);
    const before = (await pool.query('select data from private.recovery_snapshots where id=$1', [id])).rows[0].data.metadataBytes;
    await expect(t.stageBatch(actor, id, envelope(binding, 'metadata', [metadataPart({
            ...header, createdAt: 2
        }, 0)]))).rejects.toMatchObject({
        code: 'CONFLICT'
    });
    await expect(new PostgresRecoveryTransfer(backup, 'other-session').renew(actor, id)).rejects.toMatchObject({
        code: 'NOT_FOUND'
    });
    await t.stageBatch(actor, id, batch);
    expect((await pool.query('select data from private.recovery_snapshots where id=$1', [id])).rows[0].data.metadataBytes).toBe(before);
}));
it('binds partial metadata size/hash and rejects a changed continuation before activation', () => transferCase(2, async (c) => {
    const { t, actor, id, binding, header, pool } = c, bytes = Buffer.from(JSON.stringify({
        type: 'row', table: 'private.audit', row: {
            id: 1, actor_id: actor.userId, action: 'x'.repeat(50000), target_id: randomUUID(), created_at: new Date(1).toISOString()
        }
    })), part = {
        seq: 1, offset: 0, size: bytes.length, sha256: digest(bytes), base64: bytes.subarray(0, 24000).toString('base64'), complete: false
    };
    await t.stageBatch(actor, id, envelope(binding, 'metadata', [metadataPart(header, 0), part]));
    const last = {
        ...part, offset: 24000, base64: bytes.subarray(24000).toString('base64'), complete: true
    };
    await expect(t.stageBatch(actor, id, envelope(binding, 'metadata', [{
            ...last, sha256: 'f'.repeat(64)
        }]))).rejects.toMatchObject({
        code: 'INVALID_INPUT'
    });
    expect((await pool.query('select count(*) n from private.recovery_snapshot_records where snapshot_id=$1', [id])).rows[0].n).toBe('1');
    await t.stageBatch(actor, id, envelope(binding, 'metadata', [last]));
    expect((await pool.query('select count(*) n from private.recovery_transfer_parts where id=$1', [id])).rows[0].n).toBe('0');
}));
it('checks admin and snapshot scope before reading an oversized batch body', () => transferCase(1, async (c) => {
    const { pool, actor, id, backup, repo, store } = c;
    let verified = true;
    const app = createApp({
        repository: repo, store, backup, auth: {
            verifyUser: async () => {
                if (!verified)
                    throw new AppError('UNAUTHENTICATED', 'expired');
                return actor;
            }, verifyWorker: async () => { throw new Error('unused'); }
        }
    });
    const request = () => new Request(`https://control.test/admin/recovery/restores/${id}/batch`, {
        method: 'POST', headers: {
            authorization: 'Bearer fixture', 'content-type': 'application/json', 'content-length': String(2 * 1024 ** 2 + 1)
        }, body: 'x'.repeat(2 * 1024 ** 2 + 1)
    });
    verified = false;
    expect((await app(request())).status).toBe(401);
    verified = true;
    await pool.query("update public.memberships set role='user' where user_id=$1", [actor.userId]);
    expect((await app(request())).status).toBe(403);
    await pool.query("update public.memberships set role='admin' where user_id=$1", [actor.userId]);
    expect((await app(request())).status).toBe(400);
    const other = request();
    other.headers.set('authorization', 'Bearer other-session');
    expect((await app(other)).status).toBe(404);
    expect((await pool.query('select count(*) n from public.sites')).rows[0].n).toBe('0');
}));
it('keeps a missing typed foreign reference out of READY and out of the live registry', () => transferCase(2, async (c) => {
    const { t, actor, id, binding, header, pool } = c, row = {
        type: 'row', table: 'public.revisions', row: {
            id: randomUUID(), site_id: randomUUID(), parent_id: null, manifest_id: randomUUID(), kind: 'published', created_at: 1
        }
    };
    await t.stageBatch(actor, id, envelope(binding, 'metadata', [metadataPart(header, 0), metadataPart(row, 1)]));
    let rejected = false;
    for (let n = 0; n < 40; n++) {
        try {
            const p = await t.prepareBatch(actor, id);
            expect(p.phase).not.toBe('ready');
        }
        catch (error) {
            expect(error).toMatchObject({
                code: 'INVALID_INPUT'
            });
            rejected = true;
            break;
        }
    }
    expect(rejected).toBe(true);
    await expect(t.commitPrepared(actor, id)).rejects.toMatchObject({
        code: 'CONFLICT'
    });
    expect((await pool.query('select count(*) n from public.sites')).rows[0].n).toBe('0');
}));
it('cancels during owned object IO, drains its claim, and cleans a late immutable PUT without acknowledgement', () => transferCase(2, async (c) => {
    const { t, actor, id, binding, header, pool, transport, objects } = c, bytes = Buffer.from('late body'), file = {
        type: 'file', root: 'object', path: `private/artifacts/${randomUUID()}/${randomUUID()}/files/0`, payload: 'payloads/1.bin', size: bytes.length, sha256: digest(bytes), mediaType: 'text/html'
    };
    await t.stageBatch(actor, id, envelope(binding, 'metadata', [metadataPart(header, 0), metadataPart(file, 1)]));
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(r => entered = r), held = new Promise<void>(r => release = r);
    transport.put = async (k: string, b: Uint8Array) => { objects.set(k, b); entered(); await held; };
    const work = t.stageBatch(actor, id, envelope(binding, 'resources', [{
            seq: 1, offset: 0, size: bytes.length, sha256: digest(bytes), base64: bytes.toString('base64'), complete: true
        }]));
    const outcome = work.then(() => null, (error: unknown) => error);
    await started;
    await t.cancel(actor, id);
    expect(objects.size).toBe(1);
    release();
    expect(await outcome).toBeInstanceOf(AppError);
    await t.sweep();
    expect(objects.size).toBe(0);
    expect((await pool.query('select count(*) n from public.sites')).rows[0].n).toBe('0');
    expect((await pool.query('select count(*) n from private.recovery_transfer_parts')).rows[0].n).toBe('0');
}));
it('durably stages a metadata batch and prepares without activating live rows', async () => {
    const pool = await database();
    await seedUsers(pool);
    try {
        const actor = {
            userId: identities.admin, role: 'admin' as const
        }, repo = new SupabaseRepository(pool), store = new R2Store(repo, {
            get: async () => new Uint8Array(), put: async () => { }, signPut: async () => '', head: async () => ({
                size: 0, mediaType: ''
            })
        });
        const backup = new PostgresBackup(repo, store, async (id) => (await pool.query('select id,email from public.users where id=$1', [id])).rows[0]);
        const header = {
            type: 'header' as const, adapter: 'managed' as const, version: 1 as const, schema: 8 as const, sourceId: randomUUID(), createdAt: 1
        };
        const begun = await backup.beginRestore(actor, header, [], 1), t = new PostgresRecoveryTransfer(backup), initial = await t.renew(actor, begun.id), bytes = Buffer.from(JSON.stringify(header));
        const b = {
            binding: initial.binding, cursor: transferCursor(initial.binding, 'metadata', 0), kind: 'metadata' as const, items: [{
                    seq: 0, offset: 0, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64'), complete: true
                }]
        };
        const batch = {
            ...b, digest: createHash('sha256').update(batchContent(b)).digest('hex')
        };
        await t.stageBatch(actor, begun.id, batch);
        await t.stageBatch(actor, begun.id, batch);
        expect((await pool.query('select count(*) n from private.recovery_snapshot_records where snapshot_id=$1', [begun.id])).rows[0].n).toBe('1');
        await expect(t.prepareBatch(actor, begun.id)).resolves.toHaveProperty('phase', 'preparing');
        expect((await pool.query('select count(*) n from public.sites')).rows[0].n).toBe('0');
    }
    finally {
        await pool.end();
    }
});
it('acknowledges a small physical batch exactly once after verifying its immutable digest', async () => {
    const pool = await database();
    await seedUsers(pool);
    try {
        const actor = {
            userId: identities.admin, role: 'admin' as const
        }, repo = new SupabaseRepository(pool), objects = new Map<string, Uint8Array>();
        let puts = 0;
        const store = new R2Store(repo, {
            get: async (k) => objects.get(k)!, put: async (k, b) => { puts++; objects.set(k, b); }, signPut: async () => '', head: async () => ({
                size: 0, mediaType: ''
            })
        });
        const backup = new PostgresBackup(repo, store, async (id) => ({
            id, email: 'verified@example.test'
        })), header = {
            type: 'header' as const, adapter: 'managed' as const, version: 1 as const, schema: 8 as const, sourceId: randomUUID(), createdAt: 1
        };
        const bytes = Buffer.from('original'), hash = createHash('sha256').update(bytes).digest('hex'), file = {
            type: 'file', root: 'object', path: `private/artifacts/${randomUUID()}/${randomUUID()}/files/0`, payload: 'payloads/1.bin', size: bytes.length, sha256: hash, mediaType: 'text/html'
        };
        const begun = await backup.beginRestore(actor, header, [], 2), t = new PostgresRecoveryTransfer(backup), { binding } = await t.renew(actor, begun.id);
        const send = async (kind: 'metadata' | 'resources', items: any[]) => {
            const b = {
                binding, kind, cursor: transferCursor(binding, kind, items[0].seq), items
            };
            return t.stageBatch(actor, begun.id, {
                ...b, digest: createHash('sha256').update(batchContent(b)).digest('hex')
            });
        };
        await send('metadata', [header, file].map((r, seq) => {
            const b = Buffer.from(JSON.stringify(r));
            return {
                seq, offset: 0, size: b.length, sha256: createHash('sha256').update(b).digest('hex'), base64: b.toString('base64'), complete: true
            };
        }));
        const items = [{
                seq: 1, offset: 0, size: bytes.length, sha256: hash, base64: bytes.toString('base64'), complete: true
            }];
        await send('resources', items);
        await send('resources', items);
        expect(puts).toBe(1);
        expect((await pool.query('select count(*) n from private.recovery_transfer_parts')).rows[0].n).toBe('0');
    }
    finally {
        await pool.end();
    }
});
it('serves an authorized frozen metadata batch through actual control and SQL', async () => {
    const pool = await database();
    await seedUsers(pool);
    try {
        const actor = {
            userId: identities.admin, role: 'admin' as const
        }, repo = new SupabaseRepository(pool);
        const store = new R2Store(repo, {
            get: async () => { throw new Error('no bodies'); }, signPut: async () => '', put: async () => { }, head: async () => ({
                size: 0, mediaType: ''
            })
        });
        const backup = new PostgresBackup(repo, store), snapshot = await backup.beginSnapshot(actor, digest('fixture'));
        const app = createApp({
            repository: repo, store, backup, auth: {
                verifyUser: async () => actor, verifyWorker: async () => { throw new Error('unused'); }
            }
        });
        const response = await app(new Request(`https://control.test/admin/recovery/snapshots/${snapshot.id}/batch?cursor=start`, {
            headers: {
                authorization: 'Bearer fixture'
            }
        }));
        expect(response.status).toBe(200);
        const page = await response.json();
        expect(page.binding.id).toBe(snapshot.id);
        expect(page.items.length).toBeGreaterThan(1);
        expect(page.nextCursor).toBeNull();
    }
    finally {
        await pool.end();
    }
});
async function transportVolume(sites: number, reuseProofs = false, boundedFacts = false) {
    const prototype = PostgresRestorePreparation.prototype as any, originalQuery = prototype.query;
    let typedQueries = 0, maxTypedQueries = 0, hadPage = false;
    if (boundedFacts)
        prototype.query = async function (text: string, values: any[]) {
            if (text.startsWith("with sizes as"))
                hadPage = true;
            if (text.includes("data#>>'{row,id}'"))
                typedQueries++;
            return originalQuery.call(this, text, values);
        };
    let pool = await database();
    await seedUsers(pool);
    const dir = await directory(), spool = new RecoveryTransferSpool(join(dir, 'transport.sqlite')), counts: Record<string, number> = {};
    let app: ReturnType<typeof createApp>, phase = 'backup', inflight = 0, maxInflight = 0, maxRequest = 0, maxResponse = 0, sourceGone = false, commitMs = 0, beforeCommit = false;
    const actor = {
        userId: identities.admin, role: 'admin' as const
    };
    let currentActor = actor;
    const started = performance.now();
    await writeFile('.local-state/task15-progress-' + sites + '.json', JSON.stringify({
        phase: 'seed/capture', counts, elapsedMs: 0
    }));
    let progressDetails: Record<string, unknown> = {}, progressWrite: Promise<void> | undefined;
    const progress = () => writeFile('.local-state/task15-progress-' + sites + '.json', JSON.stringify({
        ...progressDetails, phase, counts: {
            ...counts
        }, elapsedMs: performance.now() - started
    }));
    const progressTimer = setInterval(() => {
        if (!progressWrite)
            progressWrite = progress().catch(error => { console.error('Owned progress write failed', error); }).finally(() => { progressWrite = undefined; });
    }, 5000);
    const native = new NativeArchives({
        native: true, root: dir, baseRoot: dir, sourceRoot: resolve('.'), fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(String(input)), cursor = url.searchParams.get('cursor') ?? '', lane = url.pathname.endsWith('/batch') ? (init?.method === 'POST' ? JSON.parse(String(init.body)).kind : cursor.includes(':r:') ? 'resources' : 'metadata') : url.pathname.endsWith('/prepare') ? 'prepare' : url.pathname.endsWith('/commit') ? 'commit' : url.pathname === '/session' ? 'session' : 'other';
            if (phase === 'restore')
                progressDetails = {
                    ...progressDetails, lane
                };
            counts[phase + '.' + lane] = (counts[phase + '.' + lane] ?? 0) + 1;
            maxRequest = Math.max(maxRequest, Buffer.byteLength(String(init?.body ?? '')));
            inflight++;
            maxInflight = Math.max(maxInflight, inflight);
            try {
                if (sourceGone && url.origin === 'https://source.test')
                    throw new Error('source installation is unavailable');
                if (lane === 'commit') {
                    expect((await pool.query('select count(*) n from public.sites')).rows[0].n).toBe('0');
                    expect((await pool.query("select phase from private.recovery_transfers where phase='ready'")).rowCount).toBe(1);
                    beforeCommit = true;
                }
                if (lane === 'prepare') {
                    typedQueries = 0;
                    hadPage = false;
                }
                const t = performance.now(), response = await app(new Request(url, init));
                if (lane === 'prepare' && hadPage)
                    maxTypedQueries = Math.max(maxTypedQueries, typedQueries);
                if (phase === 'restore' && ['metadata', 'resources', 'prepare', 'commit'].includes(lane)) {
                    const projection = await response.clone().json();
                    progressDetails = {
                        lane, phaseState: projection.phase, prepared: projection.prepared, total: projection.total, metadata: lane === 'metadata' ? (projection.cursor?.split(':')[2] === 'r' ? projection.total : projection.cursor?.split(':')[3]) : progressDetails.metadata, resource: lane === 'resources' ? projection.cursor?.split(':')[3] : progressDetails.resource
                    };
                }
                if (lane === 'commit')
                    commitMs = performance.now() - t;
                if (phase === 'restore' && lane === 'resources')
                    spool.flush();
                maxResponse = Math.max(maxResponse, (await response.clone().arrayBuffer()).byteLength);
                return response;
            }
            finally {
                inflight--;
            }
        }
    } as unknown as NativeArchiveDeps);
    const owned = async (remote: {
        origin: string;
        accessToken: string;
    }, action: (op: any) => Promise<unknown>) => {
        const context = await (native as any).context(remote), made = (native as any).start(context, action), op = (native as any).operations.get(made.id);
        let polling: Promise<unknown> | undefined;
        const timer = setInterval(() => {
            if (!polling)
                polling = native.request({
                    action: 'status', id: made.id, remote
                }).catch(() => { }).finally(() => { polling = undefined; });
        }, 1000);
        try {
            await op.work;
            if (op.state !== 'ready')
                throw new Error(op.error ?? 'owned transfer failed');
            return op.result;
        }
        finally {
            clearInterval(timer);
            await polling;
        }
    };
    try {
        const seed = await seedSmallBodyRecoveryVolume(pool, sites), repo = new SupabaseRepository(pool);
        const sourceTransport = {
            signPut: async () => '', put: async () => { }, head: async () => ({
                size: 0, mediaType: ''
            }), get: async (key: string) => {
                if (sourceGone)
                    throw new Error('source gone');
                const r = (await pool.query('select bytes from private.fixture_objects where key=$1', [key])).rows[0];
                if (!r)
                    throw new Error('fixture body missing');
                return r.bytes as Uint8Array;
            }, range: async (key: string, offset: number, length: number) => {
                if (sourceGone)
                    throw new Error('source gone');
                const r = (await pool.query('select substring(bytes from $2 for $3) bytes from private.fixture_objects where key=$1', [key, offset + 1, length])).rows[0];
                if (!r)
                    throw new Error('fixture range missing');
                return r.bytes as Uint8Array;
            }
        };
        const sourceStore = new R2Store(repo, sourceTransport), backup = new PostgresBackup(repo, sourceStore);
        app = createApp({
            repository: repo, store: sourceStore, backup, auth: {
                verifyUser: async () => currentActor, verifyWorker: async () => { throw new Error('unused'); }
            }
        });
        let captured = 0, snapshotId = '';
        await owned({
            origin: 'https://source.test', accessToken: 'source-token'
        }, async (op) => {
            const snapshot = await (native as any).operationCall(op, '/admin/recovery/snapshots', {});
            snapshotId = snapshot.id;
            captured = snapshot.records;
            const transfer = (native as any).transfer(op, dir);
            for await (const value of transfer.records(snapshot.id, snapshot.records)) {
                spool.putRecord(value.seq, value.bytes, value.record);
                if (value.record.type === 'file')
                    spool.putPayload(value.seq, await value.read());
                progressDetails = {
                    metadata: value.seq + 1, total: snapshot.records
                };
            }
            spool.flush();
            await (native as any).operationCall(op, `/admin/recovery/snapshots/${snapshot.id}/cancel`, {});
            return {
                captured
            };
        });
        expect(captured).toBe(sites * 180 + 9);
        expect(seed.bodyCount).toBe(sites * 54);
        expect((await pool.query('select count(*) n from private.payload_pins where id=$1', [snapshotId])).rows[0].n).toBe('0');
        const extras: any[] = [], payloads = new Map<number, Uint8Array>();
        await appendInstalledCatalog(extras, payloads);
        for (const [i, record] of extras.entries()) {
            const seq = spool.records;
            if (record.type === 'file')
                record.payload = 'payloads/' + seq + '.bin';
            const bytes = Buffer.from(JSON.stringify(record));
            spool.putRecord(seq, bytes, record);
            if (record.type === 'file')
                spool.putPayload(seq, payloads.get(i)!);
        }
        const stream = spool.stream(), smallMetadataBytes = Number(spool.db.prepare('select sum(length(bytes)) n from records').get()!.n), copiedBodyBytes = Number(spool.db.prepare('select sum(length(bytes)) n from payloads').get()!.n);
        sourceGone = true;
        await pool.end();
        pool = await database();
        await seedUsers(pool);
        const destination = randomUUID();
        await pool.query('insert into auth.users values($1)', [destination]);
        await pool.query("insert into public.users values($1,'restored-admin@example.test')", [destination]);
        await pool.query("insert into public.memberships values($1,'admin',true)", [destination]);
        currentActor = {
            userId: destination, role: 'admin'
        };
        const diskTransport = spool.transport(), targetTransport = {
            ...diskTransport, get: async (key: string) => {
                if (reuseProofs && !beforeCommit && key.includes('/checkpoints/') && key.includes('/files/'))
                    throw new Error('Checkpoint file already has an immutable verified digest proof');
                return diskTransport.get(key);
            }
        };
        const targetRepo = new SupabaseRepository(pool), targetStore = new R2Store(targetRepo, targetTransport), target = new PostgresBackup(targetRepo, targetStore, async (id) => (await pool.query('select id,email from public.users where id=$1', [id])).rows[0]);
        app = createApp({
            repository: targetRepo, store: targetStore, backup: target, auth: {
                verifyUser: async () => currentActor, verifyWorker: async () => { throw new Error('unused'); }
            }
        });
        phase = 'restore';
        const report = await owned({
            origin: 'https://target.test', accessToken: 'target-token'
        }, async (op) => (native as any).transfer(op, dir).restoreStream(stream, [{
                sourceId: identities.admin, destinationId: destination
            }, {
                sourceId: identities.user, destinationId: identities.user
            }, {
                sourceId: identities.spec, destinationId: identities.spec
            }], {}, (id: string) => { op.transferId = id; })) as any;
        expect(report).toMatchObject({
            restoredSites: sites, restoredRevisions: sites * 6, quarantined: true
        });
        if (boundedFacts)
            expect(maxTypedQueries).toBeLessThanOrEqual(4);
        expect(beforeCommit).toBe(true);
        expect((await pool.query('select count(*) n from public.sites where owner_id=$1', [destination])).rows[0].n).toBe(String(sites));
        expect((await pool.query("select count(*) n from private.jobs where data->>'state'='completed'")).rows[0].n).toBe(String(sites * 6));
        expect((await pool.query('select count(*) n from private.checkpoint_evidence')).rows[0].n).toBe(String(sites * 6));
        expect((await pool.query('select count(*) n from private.payload_edges')).rows[0].n).toBe(String(sites * 48 + extras[0].row.data.versions.length));
        const checkpoint = (await pool.query('select id,metadata from private.checkpoints limit 1')).rows[0];
        expect(Buffer.from((await targetStore.load(checkpoint.id)).files[0]!.bytes).toString('utf8')).toContain('Saved source');
        expect(checkpoint.metadata.manifest.files[0].objectKey).toContain('restore-' + report.targetId);
        expect((await pool.query("select data from private.recovery_state where key='installation'")).rows[0].data.authMapping[identities.admin]).toBe(destination);
        expect(maxInflight).toBeLessThanOrEqual(4);
        expect(maxRequest).toBeLessThanOrEqual(2 * 1024 ** 2);
        expect(maxResponse).toBeLessThanOrEqual(2 * 1024 ** 2);
        await native.shutdown();
        const backupMetadataCalls = Object.entries(counts).filter(([key]) => key.startsWith('backup.') && key !== 'backup.resources').reduce((n, [, v]) => n + v, 0), restoreCalls = Object.entries(counts).filter(([key]) => key.startsWith('restore.')).reduce((n, [, v]) => n + v, 0);
        expect(backupMetadataCalls).toBeLessThanOrEqual(5000);
        expect(restoreCalls).toBeLessThanOrEqual(20000);
        await writeFile('.local-state/task15-transfer-' + sites + '.json', JSON.stringify({
            boundary: 'trusted disk-paged records AFTER encrypted extraction; same NativeArchives-owned production transfer runner/control/SQL', sites, capturedMetadata: captured, physicalDescriptors: seed.bodyCount, originalTask12MetadataBytes: 532154933, projectedFullBodyBytes: 13500000000, smallMetadataBytes, smallBodyBytes: copiedBodyBytes, inventoryDigest: stream.inventoryDigest, counts, ...(boundedFacts ? {
                maxTypedQueries
            } : {}), backupMetadataCalls, restoreCalls, maxInflight, maxRequest, maxResponse, commitMs, observedMs: performance.now() - started
        }, null, 2));
    }
    catch (error) {
        console.error('Task15 primary failure', phase, error, counts);
        throw error;
    }
    finally {
        clearInterval(progressTimer);
        await progressWrite;
        await progress();
        if (boundedFacts)
            prototype.query = originalQuery;
        await native.shutdown();
        spool.close();
        await pool.end();
        await new Promise(setImmediate);
        await cleanDirectories();
    }
}
it('proofreuse: prepares checkpoint evidence from verified file digests without re-downloading its files', () => transportVolume(1, true), 120000);
it('smoke: installs valid disk-paged transport records through the NativeArchives-owned production runner', () => transportVolume(2), 120000);
it('measures actual900009 metadata and270000 small-body descriptors through the production transport and atomic SQL installation', () => transportVolume(5000), 1800000);
it('cohortfacts: batches typed availability, source and producer lookups within each production preparation page', () => transportVolume(3, false, true), 120000);
it.each([false, true])('handles a stale receipt read followed by an already acknowledged concurrent replay (changed=%s)', (changed) => transferCase(1, async (c) => {
    const { pool, t, actor, id, binding, header } = c, query = pool.query.bind(pool);
    let entered!: () => void, release!: () => void, once = true;
    const reached = new Promise<void>(r => entered = r), hold = new Promise<void>(r => release = r);
    pool.query = async (text: any, values: any[]) => {
        const result = await query(text, values);
        if (once && text === 'select * from private.recovery_transfer_receipts where id=$1 and cursor=$2') {
            once = false;
            entered();
            await hold;
        }
        return result;
    };
    const delayed = t.stageBatch(actor, id, envelope(binding, 'metadata', [metadataPart(changed ? {
            ...header, createdAt: 2
        } : header, 0)])).then((value: any) => ({
        value
    }), (error: any) => ({
        error
    }));
    try {
        await reached;
        await t.stageBatch(actor, id, envelope(binding, 'metadata', [metadataPart(header, 0)]));
        release();
        const result = await delayed;
        if (changed)
            expect(result).toMatchObject({
                error: {
                    code: 'CONFLICT'
                }
            });
        else
            expect(result).toHaveProperty('value.phase', 'staging');
        expect((await query('select count(*) n from private.recovery_snapshot_records where snapshot_id=$1', [id])).rows[0].n).toBe('1');
    }
    finally {
        release();
        await delayed;
        pool.query = query;
    }
}));
it('bounds exact bulk dependency facts by scope, indexed lookups and1MiB before hydration', () => transferCase(1, async (c) => {
    const { pool, id } = c, site = randomUUID(), job = randomUUID();
    await pool.query("insert into private.recovery_snapshot_records select $1,n,jsonb_build_object('type','row','table','private.artifacts','row',jsonb_build_object('id',md5(n::text)::uuid,'site_id',$2::text,'manifest',jsonb_build_object('files','[]'::jsonb))) from generate_series(1,10000) n", [id, site]);
    await pool.query("insert into private.recovery_snapshot_records values($1,10001,jsonb_build_object('type','row','table','private.jobs','row',jsonb_build_object('id',$2::text,'site_id',$3::text)))", [id, job, site]);
    const asked = [{
            seq: 0, table_name: 'private.payload_inventory', kind: 'artifact', available: true, row_id: createHash('md5').update('10000').digest('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
        }, {
            seq: 1, table_name: 'private.payload_inventory', kind: 'screenshot', available: true, job_id: job
        }];
    const facts = (await pool.query(recoveryDependencyFactsQuery, [id, JSON.stringify(asked)])).rows;
    expect(facts).toHaveLength(2);
    expect(facts[0].data.source.site_id).toBe(site);
    expect(facts[1].data.job).toBe(site);
    const plan = (await pool.query('explain(analyze,buffers,format json) ' + recoveryDependencyFactsQuery, [id, JSON.stringify(asked)])).rows[0]['QUERY PLAN'][0];
    await writeFile('.local-state/task15-bulk-facts-plan.json', JSON.stringify(plan, null, 2));
    const nodes: any[] = [];
    const walk = (n: any) => { nodes.push(n); (n.Plans ?? []).forEach(walk); };
    walk(plan.Plan);
    expect(nodes.some(n => n['Index Name'] === 'recovery_snapshot_table_id')).toBe(true);
    expect(plan.Plan['Shared Hit Blocks']).toBeLessThan(200);
    expect(nodes.filter(n => n['Relation Name']).every(n => Number(n['Actual Rows']) <= 1)).toBe(true);
    await pool.query("update private.recovery_snapshot_records set data=jsonb_set(data,'{row,manifest,extra}',to_jsonb(repeat('x',800000))) where snapshot_id=$1 and seq=10000", [id]);
    const bounded = (await pool.query(recoveryDependencyFactsQuery, [id, JSON.stringify([asked[0], {
                ...asked[0], seq: 1
            }])])).rows;
    expect(bounded).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(1024 ** 2);
    expect((await pool.query(recoveryDependencyFactsQuery, [randomUUID(), JSON.stringify(asked)])).rows.every((r: any) => r.data.source === null && r.data.job === null)).toBe(true);
}));
it('retains normal proof upgrade progress across multiple cohorts, new adapters and replayed preparation', () => transferCase(300, async (c) => {
    const { pool, actor, backup } = c, header = {
        ...c.header, pinnedCatalogs: [], storedCatalogs: [], hasInstalledCatalog: false
    }, made = await backup.beginRestore(actor, header, [{
            sourceId: actor.userId, destinationId: actor.userId
        }], 300), id = made.id, t = new PostgresRecoveryTransfer(backup, digest('fixture')), binding = (await t.renew(actor, id)).binding;
    const bytes = Buffer.from('normal verified proof'), file = {
        type: 'file', root: 'object', path: 'private/artifacts/' + randomUUID() + '/' + randomUUID() + '/files/0', payload: 'payloads/299.bin', size: bytes.length, sha256: digest(bytes), mediaType: 'text/html'
    }, rows: any[] = [header, ...Array.from({
            length: 297
        }, (_, n) => ({
            type: 'row', table: 'private.audit', row: {
                id: n + 1, actor_id: actor.userId, action: 'cohort', target_id: actor.userId, created_at: new Date(1).toISOString()
            }
        })), {
            type: 'row', table: 'private.recovery_state', row: {
                key: 'installed-catalog', data: {
                    versions: []
                }
            }
        }, file];
    await t.stageBatch(actor, id, envelope(binding, 'metadata', rows.slice(0, 256).map(metadataPart)));
    await t.stageBatch(actor, id, envelope(binding, 'metadata', rows.slice(256).map((r, n) => metadataPart(r, n + 256))));
    await t.stageBatch(actor, id, envelope(binding, 'resources', [{
            seq: 299, offset: 0, size: bytes.length, sha256: digest(bytes), base64: bytes.toString('base64'), complete: true
        }]));
    const prototype = PostgresRestorePreparation.prototype, upgrade = prototype.upgradeProofs;
    let scans = 0;
    prototype.upgradeProofs = async function (...args) { scans++; return upgrade.apply(this, args); };
    try {
        let ready = false;
        for (let n = 0; n < 60; n++) {
            const restarted = new PostgresRecoveryTransfer(backup, digest('fixture')), progress = await restarted.prepareBatch(actor, id);
            if (progress.phase === 'ready') {
                ready = true;
                break;
            }
        }
        expect(ready).toBe(true);
        expect(scans).toBe(1);
        const restarted = new PostgresRecoveryTransfer(backup, digest('fixture'));
        expect((await restarted.prepareBatch(actor, id)).phase).toBe('ready');
        const report = await restarted.commitPrepared(actor, id);
        expect(await restarted.commitPrepared(actor, id)).toEqual(report);
        expect((await pool.query('select count(*) n from private.audit')).rows[0].n).toBe('297');
    }
    finally {
        prototype.upgradeProofs = upgrade;
    }
}));
it('activates a validated READY catalog version list with one setwise edge insert and conflict-safe results', () => transferCase(1, async (c) => {
    const { pool, backup, actor, id, transport } = c, versions = ['fixture-one@1.0.0', 'fixture-two@2.0.0', 'fixture-one@1.0.0'], state = {
        after: 0, sites: 0, revisions: 0, fileCount: 0, final: {
            catalog: [{
                    path: 'manifest.json', key: 'private/catalog/restored/' + id + '/manifest.json', size: 0, sha256: digest('')
                }], catalogVersions: versions
        }
    };
    // Isolate the trusted READY activation port; real archive/catalog validation is covered by native roundtrips.
    await pool.query("update private.recovery_transfers set phase='ready',data=jsonb_build_object('preparation',$2::jsonb,'mappingDigest',$3::text) where id=$1", [id, state, digest('{}')]);
    transport.get = async () => { throw Error('READY activation must not read bodies'); };
    const engine: any = new PostgresRestorePreparation(backup), activate = engine.activate.bind(engine);
    let inserts = 0;
    engine.activate = (action: any) => activate((tx: any) => action({
        query: async (text: string, values?: any[]) => {
            if (text.startsWith('insert into private.payload_edges') && !text.includes('jsonb_populate_record'))
                inserts++;
            return tx.query(text, values);
        }
    }));
    await engine.commit(actor, id, state);
    expect((await pool.query("select owner_id from private.payload_edges where target_kind='catalog' and target_id=$1 order by owner_id", ['restore-' + id])).rows.map((r: any) => r.owner_id)).toEqual(['fixture-one@1.0.0', 'fixture-two@2.0.0']);
    expect(inserts).toBe(1);
}));
it.each([['metadata', false], ['resources', false], ['metadata', true], ['resources', true]] as const)('fixI1: keeps a delayed %s acknowledgement behind a newer batch (demoted=%s)', (kind, demoted) => transferCase(3, async (c) => {
    const { pool, t, actor, id, binding, header, objects } = c, bytes = Buffer.alloc(48000, 7), later = Buffer.from('second object'), file = (n: number, b: Buffer) => ({
        type: 'file', root: 'object', path: 'private/artifacts/' + randomUUID() + '/' + randomUUID() + '/files/' + n, payload: 'payloads/' + n + '.bin', size: b.length, sha256: digest(b), mediaType: 'text/html'
    }), files = [file(1, bytes), file(2, later)];
    if (kind === 'resources')
        await t.stageBatch(actor, id, envelope(binding, 'metadata', [header, ...files].map(metadataPart)));
    const audit = (n: number) => ({
        type: 'row', table: 'private.audit', row: {
            id: n, actor_id: actor.userId, action: 'late ACK', target_id: actor.userId, created_at: new Date(1).toISOString()
        }
    }), part = (offset: number, b: Buffer, complete: boolean) => ({
        seq: 1, offset, size: bytes.length, sha256: digest(bytes), base64: b.toString('base64'), complete
    });
    const a = kind === 'metadata' ? envelope(binding, kind, [metadataPart(header, 0)]) : envelope(binding, kind, [part(0, bytes.subarray(0, 24000), false)]), b = kind === 'metadata' ? envelope(binding, kind, [metadataPart(audit(1), 1)]) : envelope(binding, kind, [part(24000, bytes.subarray(24000), true)]), query = pool.query.bind(pool);
    let entered!: () => void, release!: () => void, once = true;
    const reached = new Promise<void>(r => entered = r), hold = new Promise<void>(r => release = r);
    pool.query = async (text: any, values: any[]) => { const result = await query(text, values); if (once && text === 'select * from private.recovery_transfer_receipts where id=$1 and cursor=$2' && values[1] === a.cursor && result.rows[0]?.complete === false) {
        once = false;
        entered();
        await hold;
    } return result; };
    let puts = 0;
    const put = c.transport.put;
    c.transport.put = async (...args: any[]) => { puts++; return put(...args); };
    const delayed = t.stageBatch(actor, id, a).then((value: any) => ({
        value
    }), (error: any) => ({
        error
    }));
    try {
        await reached;
        await t.stageBatch(actor, id, a);
        const newer = await t.stageBatch(actor, id, b);
        if (demoted)
            await query("update public.memberships set role='user' where user_id=$1", [actor.userId]);
        release();
        const result = await delayed;
        if (demoted)
            expect(result).toHaveProperty('error.code', 'FORBIDDEN');
        else
            expect(result).toHaveProperty('value.cursor', newer.cursor);
        if (demoted)
            await query("update public.memberships set role='admin' where user_id=$1", [actor.userId]);
        const state = (await query('select metadata_seq,resource_seq,resource_offset from private.recovery_transfers where id=$1', [id])).rows[0];
        if (kind === 'metadata') {
            expect(state.metadata_seq).toBe('2');
            expect(Number((await query("select data->>'metadataBytes' n from private.recovery_snapshots where id=$1", [id])).rows[0].n)).toBe(Buffer.byteLength(JSON.stringify(header)) + Buffer.byteLength(JSON.stringify(audit(1))));
            expect((await query('select count(*) n from private.recovery_transfer_metadata where id=$1', [id])).rows[0].n).toBe('2');
            await t.stageBatch(actor, id, envelope(binding, kind, [metadataPart(audit(2), 2)]));
        }
        else {
            expect(state.resource_seq).toBe('2');
            expect(state.resource_offset).toBe(0);
            expect(objects.size).toBe(1);
            expect(puts).toBe(1);
            expect(Number((await query("select data->>'objectStagingBytes' n from private.recovery_snapshots where id=$1", [id])).rows[0].n)).toBe(0);
            expect((await query('select count(*) n from private.recovery_transfer_parts where id=$1', [id])).rows[0].n).toBe('0');
            await t.stageBatch(actor, id, envelope(binding, kind, [{
                    seq: 2, offset: 0, size: later.length, sha256: digest(later), base64: later.toString('base64'), complete: true
                }]));
            expect(objects.size).toBe(2);
            expect(puts).toBe(2);
        }
    }
    finally {
        release();
        await delayed;
        pool.query = query;
    }
}));
it('fixI2: freezes legacy HTTP Auth mappings at first preparation and preserves them through READY and commit', () => transferCase(1, async (c) => {
    const { pool, repo, store, backup, actor } = c, source = randomUUID(), destination = identities.user, other = identities.spec, header = {
        ...c.header, pinnedCatalogs: [], storedCatalogs: [], hasInstalledCatalog: false
    }, app = createApp({
        repository: repo, store, backup, auth: {
            verifyUser: async () => actor, verifyWorker: async () => { throw Error('unused'); }
        }
    });
    const post = (path: string, body: unknown = {}) => app(new Request('https://control.test/admin/recovery/' + path, {
        method: 'POST', headers: {
            authorization: 'Bearer fixture', 'content-type': 'application/json'
        }, body: JSON.stringify(body)
    }));
    const begun = await post('restores', {
        header, mappings: [{
                sourceId: source, destinationId: destination
            }], records: 300
    });
    expect(begun.status).toBe(200);
    const { id } = await begun.json(), path = 'restores/' + id + '/', rows = [header, ...Array.from({
            length: 298
        }, (_, n) => ({
            type: 'row', table: 'private.audit', row: {
                id: n + 1, actor_id: source, action: 'legacy map', target_id: source, created_at: new Date(1).toISOString()
            }
        })), {
            type: 'row', table: 'private.recovery_state', row: {
                key: 'installed-catalog', data: {
                    versions: []
                }
            }
        }];
    for (const [seq, row] of rows.entries()) {
        expect((await post(path + 'record-part', {
            seq, index: 0, base64: Buffer.from(JSON.stringify(row)).toString('base64')
        })).status).toBe(200);
        expect((await post(path + 'record-complete', {
            seq
        })).status).toBe(200);
    }
    const mappings = (id: string) => post(path + 'mappings', {
        mappings: [{
                sourceId: source, destinationId: id
            }]
    }), prototype = PostgresRestorePreparation.prototype, upgrade = prototype.upgradeProofs;
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(r => entered = r), hold = new Promise<void>(r => release = r);
    prototype.upgradeProofs = async function (...args) { entered(); await hold; return upgrade.apply(this, args); };
    const preparing = post(path + 'prepare');
    try {
        await reached;
        expect((await mappings(other)).status).toBe(409);
        expect((await mappings(destination)).status).toBe(200);
        expect((await post(path + 'prepare')).status).toBe(503);
    }
    finally {
        release();
        await preparing;
        prototype.upgradeProofs = upgrade;
    }
    const page = prototype.preparePage;
    let cohortEntered!: () => void, cohortRelease!: () => void;
    const cohortReached = new Promise<void>(r => cohortEntered = r), cohortHold = new Promise<void>(r => cohortRelease = r);
    prototype.preparePage = async function (...args) { const result = await page.apply(this, args); cohortEntered(); await cohortHold; return result; };
    const cohort = post(path + 'prepare');
    try {
        await cohortReached;
        expect((await mappings(other)).status).toBe(409);
        expect((await mappings(destination)).status).toBe(200);
        expect((await post(path + 'prepare')).status).toBe(503);
    }
    finally {
        cohortRelease();
        expect((await cohort).status).toBe(200);
        prototype.preparePage = page;
    }
    let ready = false;
    for (let n = 0; n < 60; n++) {
        const response = await post(path + 'prepare');
        expect(response.status).toBe(200);
        if ((await response.json()).phase === 'ready') {
            ready = true;
            break;
        }
    }
    expect(ready).toBe(true);
    expect((await mappings(other)).status).toBe(409);
    expect((await mappings(destination)).status).toBe(200);
    const frozen = (await pool.query("select data->'verified' verified from private.recovery_snapshots where id=$1", [id])).rows[0].verified, changed = {
        ...frozen, [source]: {
            id: other, email: (await pool.query('select email from public.users where id=$1', [other])).rows[0].email
        }
    };
    await pool.query("update private.recovery_snapshots set data=jsonb_set(data,'{verified}',$2::jsonb) where id=$1", [id, changed]);
    expect((await post(path + 'prepare')).status).toBe(409);
    expect((await post(path + 'commit')).status).toBe(409);
    expect((await pool.query('select count(*) n from private.audit')).rows[0].n).toBe('0');
    await pool.query("update private.recovery_snapshots set data=jsonb_set(data,'{verified}',$2::jsonb) where id=$1", [id, frozen]);
    const privatePrototype = prototype as any, activate = privatePrototype.activate;
    let commitEntered!: () => void, commitRelease!: () => void;
    const commitReached = new Promise<void>(r => commitEntered = r), commitHold = new Promise<void>(r => commitRelease = r);
    privatePrototype.activate = async function (action: any) { commitEntered(); await commitHold; return activate.call(this, action); };
    const pendingCommit = post(path + 'commit');
    try {
        await commitReached;
        await pool.query("update private.recovery_snapshots set data=jsonb_set(data,'{verified}',$2::jsonb) where id=$1", [id, changed]);
        commitRelease();
        expect((await pendingCommit).status).toBe(409);
        expect((await pool.query('select count(*) n from private.audit')).rows[0].n).toBe('0');
    }
    finally {
        commitRelease();
        await pendingCommit;
        privatePrototype.activate = activate;
        await pool.query("update private.recovery_snapshots set data=jsonb_set(data,'{verified}',$2::jsonb) where id=$1", [id, frozen]);
    }
    const installed = await post(path + 'commit');
    expect(installed.status).toBe(200);
    expect((await pool.query('select distinct actor_id from private.audit')).rows).toEqual([{
            actor_id: destination
        }]);
    expect((await pool.query("select data#>>'{authMapping," + source + "}' destination from private.recovery_state where key='installation'")).rows[0].destination).toBe(destination);
    expect((await pool.query('select count(*) n from private.audit')).rows[0].n).toBe('298');
}));
