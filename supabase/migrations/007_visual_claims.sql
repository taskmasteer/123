-- Optional deterministic-only claims; original one-argument contract remains a wrapper.
create or replace function private.claim_job(device uuid, visual_only boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 candidate record;
 worker private.workers;
 job private.jobs;
 admission private.site_operations;
 sampled timestamptz;
begin
 if not exists(select 1 from private.workers where id=device and revoked_at is null) then raise exception 'STALE_LEASE'; end if;
 -- Site locks are skipped before taking device capacity. The job row itself is
 -- also SKIP LOCKED so unrelated work proceeds during other short mutations.
 for candidate in
  select s.id from public.sites s where exists (
   select 1 from private.jobs j where j.site_id=s.id and not j.pause_requested and (not visual_only or (j.data->>'kind'='edit' and j.data#>>'{edit,producer,kind}'='visual'))
    and (j.data->>'state'='queued' or (j.data->>'state'='running' and j.expires_at<=clock_timestamp()))
    and not exists(select 1 from private.site_operations o where o.site_id=s.id and (o.kind<>'job' or o.operation_id<>j.id))
  ) order by s.id limit 1 for update of s skip locked
 loop
  select * into worker from private.workers where id=device for update;
  if not found or worker.revoked_at is not null then raise exception 'STALE_LEASE'; end if;
  sampled := clock_timestamp();
  update private.workers set last_heartbeat=sampled where id=device;
  if worker.paused then return null; end if;
  if (select count(*) from private.jobs where worker_id=device and data->>'state'='running' and expires_at>sampled)>=2 then return null; end if;
  select * into job from private.jobs where site_id=candidate.id and not pause_requested and (not visual_only or (data->>'kind'='edit' and data#>>'{edit,producer,kind}'='visual'))
   and (data->>'state'='queued' or (data->>'state'='running' and expires_at<=sampled))
   order by id for update skip locked limit 1;
  if not found then return null; end if;
  select * into admission from private.site_operations where site_id=candidate.id for update;
  if found and (admission.kind<>'job' or admission.operation_id<>job.id) then return null; end if;
  sampled := clock_timestamp();
  job.generation := job.generation+1;
  job.data := jsonb_set(job.data,'{state}','"running"');
  job.expires_at := sampled+interval '120 seconds';
  update private.jobs set worker_id=device,last_worker_id=device,generation=job.generation,data=job.data,
   claimed_at=sampled,expires_at=job.expires_at where id=job.id;
  insert into private.site_operations(site_id,operation_id,kind,generation)
   values(job.site_id,job.id,'job',job.generation)
   on conflict(site_id) do update set operation_id=excluded.operation_id,kind='job',generation=excluded.generation,expires_at=null;
  return jsonb_build_object('job',job.data,'lease',jsonb_build_object(
   'jobId',job.id,'workerId',device,'generation',job.generation,
   'expiresAt',floor(extract(epoch from job.expires_at)*1000)));
 end loop;
 update private.workers set last_heartbeat=clock_timestamp() where id=device and revoked_at is null;
 return null;
end $$;
revoke all on function private.claim_job(uuid,boolean) from public,anon,authenticated;
create or replace function private.claim_job(device uuid) returns jsonb language sql security definer set search_path='' as $$ select private.claim_job(device,false) $$;
revoke all on function private.claim_job(uuid) from public,anon,authenticated;
