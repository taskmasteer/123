-- Durable read-only observations and one compact partial-duration aggregate per job.
create table private.job_activity(job_id uuid primary key references private.jobs(id),data jsonb not null);
create table private.health_observations(site_id uuid primary key references public.sites(id),next_due_at bigint not null default 0,generation bigint not null default 0,token uuid,worker_id uuid references private.workers(id),expires_at bigint,expectation jsonb);
create index health_worker_claims on private.health_observations(worker_id,expires_at) where token is not null;
alter table public.health add column data jsonb;
alter table private.provider_publications add column diagnostic jsonb;
revoke all on private.job_activity,private.health_observations from public,anon,authenticated;
create trigger recovery_activity_guard before insert or update or delete on private.job_activity for each row execute function private.guard_recovery_write();
create trigger recovery_health_guard before insert or update or delete on private.health_observations for each row execute function private.guard_recovery_write();
