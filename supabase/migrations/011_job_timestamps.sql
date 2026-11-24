alter table private.jobs add column if not exists created_at timestamptz not null default clock_timestamp();
create index if not exists jobs_created_order on private.jobs(created_at desc,id desc);
create index if not exists jobs_site_created_order on private.jobs(site_id,created_at desc,id desc);
