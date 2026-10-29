import { it, expect } from 'vitest';
import { database, seedUsers } from './database.js';
import { seedRecoveryTransferVolume } from './recovery-transfer-fixture.js';
import { PostgresHealth } from '../../packages/adapters/src/postgres-monitoring.js';
import { SupabaseRepository } from '../../packages/adapters/src/supabase-repository.js';
import { manifestHash, publisherPolicyVersion, publisherConfiguration, digest } from '../../packages/core/src/publication.js';
import { healthIntervalMs } from '../../packages/contracts/src/monitoring.js';
import { PostgresQueue } from '../../packages/adapters/src/postgres-queue.js';
import { postgresUsage } from '../../packages/adapters/src/postgres-monitoring.js';
import { identities } from './database.js';
const worker = '44444444-4444-4444-8444-444444444444';
it('leases read-only health once for six hours, fences changed outcomes/revocation and leaves jobs untouched', async () => {
    const pool = await database();
    try {
        await seedUsers(pool);
        await seedRecoveryTransferVolume(pool, 1);
        const repo = new SupabaseRepository(pool);
        let now = Date.now();
        const health = new PostgresHealth(repo, () => now);
        for (const row of (await pool.query('select p.id,p.data,a.manifest from private.provider_publications p join private.artifacts a on a.id=p.manifest_id')).rows) {
            const hash = manifestHash(row.manifest), file = row.manifest.files.find((f: any) => f.path === 'index.html');
            await pool.query('update private.provider_publications set manifest_hash=$2,data=data||$3::jsonb,evidence=$4 where id=$1', [row.id, hash, { policyVersion: publisherPolicyVersion, policyHash: digest(publisherConfiguration.bytes) }, { hostname: row.data.domain, manifestHash: hash, indexSha256: file.sha256,policyHash:digest(publisherConfiguration.bytes) }]);
        }
        const before = (await pool.query('select data from private.jobs order by id')).rows;
        const claims = await Promise.all([health.claim(worker), health.claim(worker)]);
        expect(claims.filter(c => c.claim)).toHaveLength(1);
        const claim = claims.find(c => c.claim)!.claim!;
        expect(claim.expiresAt - now).toBe(120000);
        expect(await health.complete(worker, { ...claim, code: 'ok' })).toEqual({ accepted: true });
        expect((await health.claim(worker)).claim).toBeNull();
        expect((await health.read(claim.siteId)).checkedAt).toBe(now);
        now += healthIntervalMs;
        expect((await health.read(claim.siteId)).checkedAt).toBeLessThanOrEqual(now - healthIntervalMs);
        const altered=(await health.claim(worker)).claim!;await pool.query("update private.health_observations set expectation=jsonb_set(expectation,'{file,sha256}',to_jsonb($2::text)) where site_id=$1",[altered.siteId,'0'.repeat(64)]);expect(await health.complete(worker,{...altered,code:'ok'})).toEqual({accepted:false});
        const next = (await health.claim(worker)).claim!;
        expect(next).not.toBeNull();
        await pool.query('update private.workers set revoked_at=clock_timestamp() where id=$1', [worker]);
        expect(await health.complete(worker, { ...next, code: 'ok' })).toEqual({ accepted: false });
        await pool.query('update private.workers set revoked_at=null where id=$1', [worker]);
        now += 120001;
        const replacement = (await health.claim(worker)).claim!;
        await pool.query('update public.sites set published_id=(select revision_id from private.provider_publications where site_id=$1 and revision_id<>$2 limit 1) where id=$1', [claim.siteId, claim.revisionId]);
        expect(await health.complete(worker, { ...replacement, code: 'ok' })).toEqual({ accepted: false });
        expect((await pool.query('select data from private.jobs order by id')).rows).toEqual(before);
        const dbClock=await new PostgresHealth(repo).claim(worker);expect(dbClock.claim).not.toBeNull();expect(dbClock.claim!.expiresAt-dbClock.serverNow).toBe(120000);expect(Math.abs(dbClock.serverNow-Number((await pool.query('select floor(extract(epoch from clock_timestamp())*1000)::text ms')).rows[0].ms))).toBeLessThan(5000);
    }
    finally {
        await pool.end();
    }
});
it('stores one activity aggregate under current lease and scopes installation/site usage with fresh membership', async () => {
    const pool = await database();
    try {
        await seedUsers(pool);
        const repo = new SupabaseRepository(pool), queue = new PostgresQueue(repo), admin = { userId: identities.admin, role: 'admin' as const };
        await pool.query("insert into private.workers(id,name,token_hash) values($1,'no model key',$2)", [worker, 'a'.repeat(64)]);
        const site = await repo.create({ domain: 'activity.example' }, admin), claim = (await queue.claim(worker))!;
        await queue.recordActivity(claim.lease, { sequence: 1, durationMs: 100 });
        await queue.recordActivity(claim.lease, { sequence: 1, durationMs: 100 });
        await expect(queue.recordActivity(claim.lease, { sequence: 1, durationMs: 200 })).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(await postgresUsage(repo, admin)).toMatchObject({ jobs: 1, durationMs: 100, missingJobs: 1, estimatedCostUsd: null });
        await expect(postgresUsage(repo, { userId: identities.user, role: 'admin' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(postgresUsage(repo, { userId: identities.user, role: 'user' }, site.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(await queue.pauseAtBoundary(claim.lease,{sequence:2,durationMs:10})).toBe(false);expect(await queue.pauseAtBoundary(claim.lease,{sequence:2,durationMs:20})).toBe(false);
        await queue.finish(claim.lease, 'paused',{sequence:2,durationMs:40});
        await expect(queue.recordActivity(claim.lease, { sequence: 2, durationMs: 100 })).rejects.toMatchObject({ code: 'STALE_LEASE' });
        await queue.retry(claim.job.id);
        const resumed = (await queue.claim(worker))!;
        await queue.recordActivity(resumed.lease, { sequence: 1, durationMs: 20 });
        expect((await pool.query('select count(*) n from private.job_activity')).rows[0].n).toBe('1');
        expect(await postgresUsage(repo, admin, site.id)).toMatchObject({ durationMs: 160 });
    }
    finally {
        await pool.end();
    }
});
