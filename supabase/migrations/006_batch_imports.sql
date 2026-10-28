alter table private.batches add column state text not null default 'active' check(state in ('uploading','preview','active','paused','cancelled'));
alter table private.batches add column data jsonb not null default '{}';
alter table private.batches add column request_key text;
alter table private.batches add column payload_hash text;
create unique index batch_request_identity on private.batches(owner_id,request_key) where request_key is not null;
create table private.batch_rows(batch_id uuid not null references private.batches(id),row_number integer not null check(row_number between 2 and 5001),data jsonb not null,site_id uuid references public.sites(id),primary key(batch_id,row_number),unique(site_id));
create index batch_rows_site on private.batch_rows(site_id);
create table private.batch_assignments(batch_id uuid references private.batches(id),user_id uuid references public.users(id),primary key(batch_id,user_id));
create table private.import_resources(id uuid primary key,owner_id uuid not null references public.users(id),data jsonb not null);
create table private.import_chunks(resource_id uuid references private.import_resources(id),part integer not null check(part between 0 and 699),bytes bytea not null check(octet_length(bytes) between 1 and 24000),primary key(resource_id,part));
revoke all on private.batch_rows,private.batch_assignments,private.import_resources,private.import_chunks from public,anon,authenticated;
create function private.has_batch_assignment(target uuid,actor uuid) returns boolean language sql stable security definer set search_path='' as $$ select exists(select 1 from private.batch_rows r join private.batch_assignments a on a.batch_id=r.batch_id where r.site_id=target and a.user_id=actor) $$;
revoke all on function private.has_batch_assignment(uuid,uuid) from public,anon,authenticated;
create or replace function private.can_read_site(target uuid) returns boolean language sql stable security definer set search_path='' as $$ select private.current_role() is not null and exists(select 1 from public.sites s where s.id=target and (private.current_role()='admin' or s.owner_id=auth.uid() or exists(select 1 from public.assignments a where a.site_id=s.id and a.user_id=auth.uid()) or private.has_batch_assignment(s.id,auth.uid()))) $$;
create index sites_status_page on public.sites(generation_status,id);

alter table private.batches add column admission_selected_at timestamptz;

create index batch_rows_pending on private.batch_rows(batch_id,row_number) where site_id is null;

-- Bound the PL/pgSQL cursor before worker capacity serialization. Otherwise its
-- prefetch locks unrelated candidate sites and concurrent workers see no work.
create or replace function private.claim_job(device uuid) returns jsonb
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
  ) order by s.id limit 1 for update of s skip locked
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
