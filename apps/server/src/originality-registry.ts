import { assertAllowedHost } from '../../../packages/contracts/src/domain-policy.js';
import { AppError, type ArtifactStore } from '../../../packages/contracts/src/model.js';
import type { PostgresQueue } from '../../../packages/adapters/src/postgres-queue.js';
import { evaluatePeers, renderProfile, type OriginalityGate, type PageProfile } from '../../worker/src/originality.js';

export function createOriginalityRegistry(queue:PostgresQueue, store:Pick<ArtifactStore,'read'>):OriginalityGate {
  const db=queue.repository;
  let indexing:Promise<void>|undefined;
  async function indexExisting() {
    // Read only locally retained, currently relevant revisions, including manual ZIP updates.
    const missing = await db.pool.query(`select distinct s.id,s.domain,r.manifest_id
      from public.sites s left join factory.hosting_sites h on h.site_id=s.id
      join public.revisions r on r.site_id=s.id and r.id in (s.draft_id,s.published_id,h.revision_id)
      where not exists(select 1 from factory.originality_profiles p where p.site_id=s.id and p.source='manifest:'||r.manifest_id::text)`);
    for (const row of missing.rows) {
      try {assertAllowedHost(row.domain);} catch (error) {if(error instanceof AppError && error.code==='FORBIDDEN')continue;throw error;}
      const profile = await renderProfile(await store.read(row.manifest_id));
      await db.pool.query('insert into factory.originality_profiles(site_id,source,profile) values($1,$2,$3) on conflict do nothing',[row.id,'manifest:'+row.manifest_id,profile]);
    }
  }
  return {
    profile:renderProfile,
    async reserve(job,lease,profile,approved) {
      indexing ??= indexExisting().finally(()=>{indexing=undefined;});
      await indexing;
      return db.transaction(async tx=>{
        await tx.query('select pg_advisory_xact_lock(78424537)');
        const current=await queue.assertCurrent(tx,lease.workerId,lease);
        if(current.siteId!==job.siteId || lease.jobId!==job.id)throw new AppError('STALE_LEASE','Задание изменилось.');
        const records=await tx.query('select profile from factory.originality_profiles where site_id<>$1',[job.siteId]);
        const result=evaluatePeers(profile,records.rows.map(row=>row.profile as PageProfile),approved);
        if(result.kind==='accepted') {
          const {articleExcerpt: _article, ...peerProfile}=profile;
          await tx.query(`insert into factory.originality_profiles(site_id,source,profile) values($1,$2,$3)
            on conflict(site_id,source) do update set profile=excluded.profile`,[job.siteId,'job:'+job.id,peerProfile]);
        }
        return result;
      });
    }
  };
}
