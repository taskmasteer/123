import { seedRecoveryTransferVolume,seedMonitoringVolume } from './recovery-transfer-fixture.js';
import { SupabaseRepository } from '../../packages/adapters/src/supabase-repository.js';
import { PostgresQueue } from '../../packages/adapters/src/postgres-queue.js';
import { PostgresBackup } from '../../packages/adapters/src/postgres-backup.js';
import { PostgresRetention } from '../../packages/adapters/src/postgres-retention.js';
import { R2Store } from '../../packages/adapters/src/r2-store.js';
import { it, expect } from 'vitest';
import { database, seedUsers, identities } from './database.js';
import { writeFile } from 'node:fs/promises';
import { managedRecoveryTables } from '../../packages/adapters/src/recovery-records.js';
it('measures actual5000×6 normalized history/private evidence and270000 physical descriptors before bounded snapshot capture', async () => {
    const pool = await database();
    await seedUsers(pool);
    try {
        await seedRecoveryTransferVolume(pool);await seedMonitoringVolume(pool);
        let logical = 0, bytes = 0;
        const tableCounts: Record<string, number> = {};
        for (const table of managedRecoveryTables) {
            const r = (await pool.query("select count(*) n,coalesce(sum(octet_length(jsonb_build_object('type','row','table',$1::text,'row',to_jsonb(t))::text)),0) bytes from " + table + ' t', [table])).rows[0];
            tableCounts[table] = Number(r.n);
            logical += Number(r.n);
            bytes += Number(r.bytes);
        }
        const physical = (await pool.query("select count(*) n,coalesce(sum(octet_length(jsonb_build_object('type','file','root','object','path',f->>'key','payload','payloads/999999.bin','size',f->'size','sha256',f->'sha256','mediaType',f->'mediaType')::text)),0) bytes,coalesce(sum((f->>'size')::bigint),0) bodies from private.payload_inventory cross join lateral jsonb_array_elements(data->'objects') f")).rows[0];
        const measurement = { sites: 5000, states: 30000, logicalRows: logical, fileRecords: Number(physical.n), metadataRecords: logical + Number(physical.n) + 1, zipEntriesBeforeIndex: logical + 2 * Number(physical.n) + 1, logicalBytes: bytes, fileRecordBytes: Number(physical.bytes), totalMetadataBytes: bytes + Number(physical.bytes), projectedBodyBytes: Number(physical.bodies), tableCounts };
        await writeFile('.local-state/task13-full-volume.json', JSON.stringify(measurement, null, 2));
        expect(measurement.fileRecords).toBe(270000);
        expect(measurement.states).toBe(30000);
        const before = process.memoryUsage(), repo = new SupabaseRepository(pool), queue = new PostgresQueue(repo);
        const exclusiveFenceMs: number[] = [], transaction = repo.transaction.bind(repo), capture = repo.captureSnapshot.bind(repo);
        let captureHelperElapsedMs = 0;
        repo.transaction = (async (action: any, fence: any = 'shared') => transaction(async (tx) => { const t = performance.now(); try {
            return await action(tx);
        }
        finally {
            if (fence === 'exclusive')
                exclusiveFenceMs.push(performance.now() - t);
        } }, fence)) as typeof repo.transaction;
        repo.captureSnapshot = (async (action: any, fresh: any) => { const t = performance.now(); try {
            return await capture(action, fresh);
        }
        finally {
            captureHelperElapsedMs = performance.now() - t;
        } }) as typeof repo.captureSnapshot;
        let io = 0;
        const transport = { get: async () => { io++; throw new Error('Metadata-only representative never reads projected bodies'); }, signPut: async () => '', put: async () => { }, head: async () => { io++; throw new Error('No body heads'); }, delete: async () => { } };
        const store = new R2Store(repo, transport, queue), backup = new PostgresBackup(repo, store), start = performance.now(), snapshot = await backup.beginSnapshot({ userId: identities.admin, role: 'admin' });
        const captureMs = performance.now() - start;
        let capturedMetadataBytes=0,indexBytes = 0, indexChunks = 0, chunkBytes = 0, zipMembers = 0, after = -1;
        for (;;) {
            const page = (await pool.query("select seq,octet_length(data::text) serialized,data->>'type' type,data->>'root' root,data->>'path' path,data->>'mediaType' media,data->>'payload' payload,data->>'size' size from private.recovery_snapshot_records where snapshot_id=$1 and seq>$2 order by seq limit 256", [snapshot.id, after])).rows;
            if (!page.length)
                break;
            for (const r of page) {
                after = Number(r.seq);capturedMetadataBytes+=Number(r.serialized);
                const value = r.type === 'file' ? { name: r.payload, size: Number(r.size), sha256: 'a'.repeat(64), fileDescriptorV1: { recordName: 'records/' + r.seq + '.json', root: r.root, path: r.path, mediaType: r.media } } : { name: 'records/' + r.seq + '.json', size: Number(r.serialized), sha256: 'a'.repeat(64) };
                const length = Buffer.byteLength(JSON.stringify(value) + '\n');
                if (chunkBytes + length > 1024 ** 2) {
                    indexChunks++;
                    chunkBytes = 0;
                }
                chunkBytes += length;
                indexBytes += length;
                zipMembers++;
            }
        }
        if (chunkBytes)
            indexChunks++;
        expect(capturedMetadataBytes).toBeLessThanOrEqual(768*1024**2);
        expect(indexBytes).toBeLessThanOrEqual(192 * 1024 ** 2);
        expect(zipMembers + indexChunks).toBeLessThanOrEqual(1000000);
        expect(snapshot.records).toBe(measurement.metadataRecords);
        expect(io).toBe(0);
        let rootCount = 0;
        await repo.transaction(async (tx) => { const retention = new PostgresRetention(repo, transport); await retention.closure(tx, Date.now()); rootCount = Number((await tx.query('select count(*) n from retention_protected')).rows[0].n); expect((await tx.query("select count(*) n from retention_protected where kind='artifact'")).rows[0].n).toBe('30000'); expect((await tx.query("select count(*) n from retention_protected where kind='screenshot'")).rows[0].n).toBe('60000'); }, 'exclusive');
        const end = process.memoryUsage();
        await writeFile('.local-state/task13-full-volume.json', JSON.stringify({ ...measurement, snapshotRecords: snapshot.records,capturedMetadataBytes, captureMs, compactIndexBytes: indexBytes, indexChunks, countedPlannedZipMembers: zipMembers + indexChunks, captureHelperElapsedMs, rootCount, heapGrowth: end.heapUsed - before.heapUsed, rssGrowth: end.rss - before.rss }, null, 2));
        await backup.close({ userId: identities.admin, role: 'admin' }, snapshot.id);
        const collector = new PostgresRetention(repo, transport), planStart = performance.now();
        expect((await collector.planCleanup(Date.now() + 32 * 86400000)).deletableManifestIds).toEqual([]);
        expect((await collector.planCleanup(Date.now() + 33 * 86400000 + 1)).deletableManifestIds).toEqual([]);
        await collector.collect(Date.now() + 33 * 86400000 + 2);
        expect((await pool.query("select count(*) n from private.payload_inventory where kind='checkpoint' and state='deleted'")).rows[0].n).toBe('30000');
        expect((await pool.query("select count(*) n from private.payload_inventory where kind in ('artifact','screenshot') and state='available'")).rows[0].n).toBe('90000');
        await writeFile('.local-state/task13-closure-measured.json', JSON.stringify({ rootCount, planAndCollectMs: performance.now() - planStart, maxExclusiveFenceMs: Math.max(...exclusiveFenceMs), exclusiveFenceMs, heapGrowth: process.memoryUsage().heapUsed - before.heapUsed }));
        const excess = 1000001 - measurement.logicalRows;
        await pool.query("insert into private.audit(actor_id,action,target_id) select $1,'capacity event',$2 from generate_series(1,$3::int)", [identities.admin, '00000000-0000-4000-8000-000000000001', excess]);
        await expect(backup.beginSnapshot({ userId: identities.admin, role: 'admin' })).rejects.toMatchObject({ code: 'NEEDS_ATTENTION' });
        expect((await pool.query('select count(*) n from private.recovery_snapshots')).rows[0].n).toBe('0');
        expect((await pool.query('select count(*) n from private.payload_pins')).rows[0].n).toBe('0');
    }
    finally {
        await pool.end();
    }
}, 240000);
