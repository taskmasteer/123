import { it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { database, seedUsers, identities } from './database.js';
import { SupabaseRepository, configureSnapshotConnection } from '../../packages/adapters/src/supabase-repository.js';
import { PostgresQueue } from '../../packages/adapters/src/postgres-queue.js';
import { R2Store, type ObjectTransport } from '../../packages/adapters/src/r2-store.js';
import { PostgresBackup } from '../../packages/adapters/src/postgres-backup.js';
import { PostgresRetention } from '../../packages/adapters/src/postgres-retention.js';
const actor = { userId: identities.admin, role: 'admin' as const };
async function fixture() { const pool = await database(); await seedUsers(pool); const repo = new SupabaseRepository(pool), queue = new PostgresQueue(repo), files = new Map<string, Uint8Array>(), transport: ObjectTransport = { signPut: async () => '', put: async (key, bytes) => { files.set(key, bytes); }, head: async (key) => ({ size: files.get(key)!.length, mediaType: 'text/html' }), get: async (key) => files.get(key)!, delete: async (key) => { files.delete(key); } }, store = new R2Store(repo, transport, queue), site = await repo.create({ domain: 'snapshot-fence.example' }, actor), manifest = await store.put(site.id, [{ path: 'index.html', mediaType: 'text/html', bytes: Buffer.from('<h1>stable bytes</h1>') }], '1.0.0'); return { pool, repo, queue, store, manifest, site, transport }; }
function barrier() { let release!: () => void; const wait = new Promise<void>(r => release = r); return { wait, release }; }
it.each(['unknown', 'transaction'])('denies%s snapshot capability before a session lock and keeps ordinary export usable', async (mode) => { const f = await fixture(); let sessionLocks = 0; const proxy = { query: f.pool.query.bind(f.pool), connect: async () => { const client = await f.pool.connect(), query = client.query.bind(client); client.query = ((text: any, ...args: any[]) => { if (String(text).includes('pg_advisory_lock_shared('))
        sessionLocks++; return (query as any)(text, ...args); }) as typeof client.query; return client; } } as unknown as Pool; configureSnapshotConnection(proxy, mode); const repo = new SupabaseRepository(proxy), backup = new PostgresBackup(repo, f.store); try {
    await expect(backup.beginSnapshot(actor)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(sessionLocks).toBe(0);
    const revision = randomUUID();
    await repo.transaction(tx => tx.query("insert into public.revisions values($1,$2,null,$3,'published',1)", [revision, f.site.id, f.manifest.id]));
    const source = await backup.exportSite(actor, f.site.id, revision);
    expect(source.records).toBe(1);
    await backup.close(actor, source.id);
    expect(sessionLocks).toBe(0);
}
finally {
    await f.pool.end();
} });
it('takes the MVCC snapshot after a preceding collector commits its claim', async () => { const f = await fixture(), held = barrier(), entered = barrier(); let capturing: Promise<string> | undefined; try {
    const collecting = f.repo.transaction(async (tx) => { await tx.query("update private.payload_inventory set state='claimed',claim_token=gen_random_uuid() where kind='artifact' and id=$1", [f.manifest.id]); entered.release(); await held.wait; }, 'exclusive');
    await entered.wait;
    capturing = f.repo.captureSnapshot(async (tx) => (await tx.query("select state from private.payload_inventory where kind='artifact' and id=$1", [f.manifest.id])).rows[0].state, async (tx) => { await f.repo.fresh(tx, actor); });
    await expect.poll(async () => !!(await f.pool.query("select 1 from pg_locks where locktype='advisory' and classid=73212 and objid=1 and mode='ShareLock' and not granted")).rowCount).toBe(true);
    held.release();
    await collecting;
    expect(await capturing).toBe('claimed');
}
finally {
    held.release();
    await capturing?.catch(() => { });
    await f.pool.end();
} });
it('permits an unrelated writer during capture and commits pins before the queued exclusive collector and fresh RC return', async () => { const f = await fixture(), entered = barrier(), held = barrier(), id = randomUUID(); let capture: Promise<string> | undefined, collector: Promise<void> | undefined; try {
    capture = f.repo.captureSnapshot(async (tx) => { await f.repo.fresh(tx, actor); await tx.query("insert into private.recovery_snapshots values($1,$2,clock_timestamp()+interval '1 hour','{}')", [id, actor.userId]); await tx.query("insert into private.payload_pins values($1,'artifact',$2,clock_timestamp()+interval '100 days')", [id, f.manifest.id]); entered.release(); await held.wait; return 'done'; }, async (tx) => { expect((await f.repo.fresh(tx, actor)).role).toBe('admin'); });
    await entered.wait;
    const other = await f.repo.create({ domain: 'writer-during-capture.example' }, actor);
    expect(other.domain).toBe('writer-during-capture.example');
    let ran = false;
    collector = f.repo.transaction(async (tx) => { ran = true; expect((await tx.query('select 1 from private.payload_pins where id=$1', [id])).rowCount).toBe(1); }, 'exclusive');
    await expect.poll(async () => !!(await f.pool.query("select 1 from pg_locks where locktype='advisory' and classid=73212 and objid=1 and mode='ExclusiveLock' and not granted")).rowCount).toBe(true);
    expect(ran).toBe(false);
    held.release();
    expect(await capture).toBe('done');
    await collector;
    expect((await new PostgresRetention(f.repo, f.transport).planCleanup(Date.now() + 32 * 86400000)).deletableManifestIds).toEqual([]);
    await new PostgresBackup(f.repo, f.store).close(actor, id);
}
finally {
    held.release();
    await capture?.catch(() => { });
    await collector?.catch(() => { });
    await f.pool.end();
} });
it.each(['throw', 'timeout'])('rolls back%s capture with zero owned pins/snapshots/session locks', async (mode) => { const f = await fixture(), id = randomUUID(); let pid = 0; try {
    await expect(f.repo.captureSnapshot(async (tx) => { pid = (await tx.query('select pg_backend_pid() pid')).rows[0].pid; await tx.query("insert into private.recovery_snapshots values($1,$2,clock_timestamp()+interval '1 hour','{}')", [id, actor.userId]); await tx.query("insert into private.payload_pins values($1,'artifact',$2,clock_timestamp()+interval '1 hour')", [id, f.manifest.id]); if (mode === 'timeout') {
        await tx.query("set local statement_timeout='1ms'");
        await tx.query('select pg_sleep(0.05)');
    } throw new Error('controlled capture failure'); }, async () => { })).rejects.toThrow();
    expect((await f.pool.query('select count(*) n from private.recovery_snapshots')).rows[0].n).toBe('0');
    expect((await f.pool.query('select count(*) n from private.payload_pins')).rows[0].n).toBe('0');
    expect((await f.pool.query("select count(*) n from pg_locks where pid=$1 and locktype='advisory'", [pid])).rows[0].n).toBe('0');
}
finally {
    await f.pool.end();
} });
it('destroys an uncertain unlock session and cleans committed snapshot capabilities', async () => { const f = await fixture(); let destroyed = false, pid = 0, failed = false; const proxy = { query: f.pool.query.bind(f.pool), connect: async () => { const client = await f.pool.connect(), query = client.query.bind(client), release = client.release.bind(client); client.query = (async (text: any, ...args: any[]) => { if (String(text).includes('pg_advisory_lock_shared('))
        pid = (await query('select pg_backend_pid() pid')).rows[0].pid; if (!failed && String(text).includes('pg_advisory_unlock_shared(')) {
        failed = true;
        throw new Error('controlled unlock uncertainty');
    } return (query as any)(text, ...args); }) as typeof client.query; client.release = (error?: Error | boolean) => { destroyed ||= !!error; release(error); }; return client; } } as unknown as Pool; configureSnapshotConnection(proxy, 'direct'); try {
    await expect(new PostgresBackup(new SupabaseRepository(proxy), f.store).beginSnapshot(actor)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(destroyed).toBe(true);
    expect((await f.pool.query('select count(*) n from private.recovery_snapshots')).rows[0].n).toBe('0');
    expect((await f.pool.query('select count(*) n from private.payload_pins')).rows[0].n).toBe('0');
    await expect.poll(async () => Number((await f.pool.query("select count(*) n from pg_locks where pid=$1 and locktype='advisory'", [pid])).rows[0].n)).toBe(0);
}
finally {
    await f.pool.end();
} });
it('rechecks authority after commit on the same session while a collector is queued and removes failed issuance', async () => { const f = await fixture(), entered = barrier(), held = barrier(), capture = f.repo.captureSnapshot.bind(f.repo); f.repo.captureSnapshot = (async (action: any, fresh: any) => capture(async (tx) => { const result = await action(tx); entered.release(); await held.wait; return result; }, fresh)) as typeof f.repo.captureSnapshot; let pending: Promise<unknown> | undefined, revoked: Promise<unknown> | undefined, collector: Promise<unknown> | undefined; try {
    pending = new PostgresBackup(f.repo, f.store).beginSnapshot(actor);
    const observed = pending.catch(e => e);
    await entered.wait;
    revoked = f.pool.query("update public.memberships set role='user' where user_id=$1", [actor.userId]);
    await expect.poll(async () => !!(await f.pool.query("select 1 from pg_stat_activity where wait_event_type='Lock' and query like 'update public.memberships%' ")).rowCount).toBe(true);
    collector = f.repo.transaction(async () => { }, 'exclusive');
    await expect.poll(async () => !!(await f.pool.query("select 1 from pg_locks where locktype='advisory' and classid=73212 and objid=1 and mode='ExclusiveLock' and not granted")).rowCount).toBe(true);
    held.release();
    expect((await observed as any).code).toBe('FORBIDDEN');
    await revoked;
    await collector;
    expect((await f.pool.query('select count(*) n from private.recovery_snapshots')).rows[0].n).toBe('0');
    expect((await f.pool.query('select count(*) n from private.payload_pins')).rows[0].n).toBe('0');
}
finally {
    held.release();
    await pending?.catch(() => { });
    await revoked;
    await collector;
    await f.pool.end();
} });
it('rolls back a capture whose cumulative SQL budget expired before another statement', async () => { const f = await fixture(), id = randomUUID(), clock = vi.spyOn(performance, 'now'); let now = 100; clock.mockImplementation(() => now); try {
    await expect(f.repo.captureSnapshot(async (tx) => { await tx.query("insert into private.recovery_snapshots values($1,$2,clock_timestamp()+interval '1 hour','{}')", [id, actor.userId]); now += 120001; await tx.query('select 1'); }, async () => { })).rejects.toMatchObject({ code: 'NEEDS_ATTENTION' });
    expect((await f.pool.query('select count(*) n from private.recovery_snapshots')).rows[0].n).toBe('0');
}
finally {
    clock.mockRestore();
    await f.pool.end();
} });
