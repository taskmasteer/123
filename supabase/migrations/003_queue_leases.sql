-- All queue writers lock sites -> workers -> jobs -> site_operations.
-- The server owns execution; authenticated and anon cannot execute these functions.
alter table private.workers add column paused boolean not null default false;
alter table private.workers add column last_heartbeat timestamptz;
alter table private.workers add column enrollment_actor uuid references public.users(id);
alter table private.workers add column control_origin text;
alter table private.jobs add column claimed_at timestamptz;
alter table private.jobs add column last_worker_id uuid references private.workers(id);
alter table private.jobs add column batch_id uuid references private.batches(id);
alter table private.jobs add column pause_requested boolean not null default false;
create index jobs_batch on private.jobs(batch_id) where batch_id is not null;
create index jobs_claimable on private.jobs((data->>'state'),site_id,id);
create index jobs_worker_capacity on private.jobs(worker_id,expires_at) where worker_id is not null;
create table private.publication_reservations(
 id uuid primary key,
 site_id uuid not null references public.sites(id),
 request_key text not null unique,
 binding jsonb not null,
 origin_job_id uuid references private.jobs(id),
 origin_controller_id uuid,
 resolution text check(resolution in ('settled','cancelled')),
 created_at timestamptz not null default clock_timestamp(),
 resolved_at timestamptz,
 check((origin_job_id is null)<>(origin_controller_id is null))
);
create unique index publication_unresolved_site on private.publication_reservations(site_id) where resolution is null;
revoke all on private.publication_reservations from public,anon,authenticated;

create function private.claim_job(device uuid) returns jsonb
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
   select 1 from private.jobs j where j.site_id=s.id and not j.pause_requested
    and (j.data->>'state'='queued' or (j.data->>'state'='running' and j.expires_at<=clock_timestamp()))
    and not exists(select 1 from private.site_operations o where o.site_id=s.id and (o.kind<>'job' or o.operation_id<>j.id))
  ) order by s.id for update of s skip locked
 loop
  select * into worker from private.workers where id=device for update;
  if not found or worker.revoked_at is not null then raise exception 'STALE_LEASE'; end if;
  sampled := clock_timestamp();
  update private.workers set last_heartbeat=sampled where id=device;
  if worker.paused then return null; end if;
  if (select count(*) from private.jobs where worker_id=device and data->>'state'='running' and expires_at>sampled)>=2 then return null; end if;
  select * into job from private.jobs where site_id=candidate.id and not pause_requested
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
revoke all on function private.claim_job(uuid) from public,anon,authenticated;

create function private.require_lease(device uuid,job_id uuid,lease_generation bigint,allow_handoff boolean default false) returns uuid
language plpgsql security definer set search_path='' as $$
declare
 target uuid;
 worker private.workers;
 job private.jobs;
 admission private.site_operations;
begin
 select site_id into target from private.jobs where id=job_id;
 if not found then raise exception 'STALE_LEASE'; end if;
 perform id from public.sites where id=target for update;
 select * into worker from private.workers where id=device for update;
 select * into job from private.jobs where id=job_id for update;
 select * into admission from private.site_operations where site_id=target for update;
 if worker.id is null or worker.revoked_at is not null or job.worker_id is distinct from device
  or job.data->>'state'<>'running' or job.generation<>lease_generation
  or job.expires_at is null or job.expires_at<=clock_timestamp()
  or not coalesce((
   (admission.kind='job' and admission.operation_id=job.id and admission.generation=lease_generation)
   or (allow_handoff and exists(select 1 from private.publication_reservations r where r.origin_job_id=job.id
    and ((r.resolution is null and admission.kind='publication' and admission.operation_id=r.id) or r.resolution='settled')))
  ),false)
 then raise exception 'STALE_LEASE'; end if;
 return target;
end $$;
revoke all on function private.require_lease(uuid,uuid,bigint,boolean) from public,anon,authenticated;
