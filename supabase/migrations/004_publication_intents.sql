-- Normalized provider ledger is separate from private.deployments (editing journal).
-- Lock order: sites -> workers (sorted) -> jobs -> site_operations -> reservation
-- -> provider_publications -> provider_accounts. Never hold SQL locks over HTTP/R2.
create table private.provider_accounts(
 id text primary key,
 active_intent uuid references private.publication_reservations(id),
 step_token uuid,
 step_expires timestamptz,
 request_window timestamptz not null default clock_timestamp(),
 request_count integer not null default 0,
 blocked_until timestamptz
);
create table private.provider_publications(
 id uuid primary key references private.publication_reservations(id),
 site_id uuid not null references public.sites(id),
 revision_id uuid not null,
 manifest_id uuid not null references private.artifacts(id),
 manifest_hash text not null,
 account_id text not null references private.provider_accounts(id),
 editing_intent_id uuid references private.deployments(id),
 deployment_id text,
 phase text not null default 'pending' check(phase in ('pending','uploading','creating','checking','promoting','reconciling','waiting_quota','awaiting_dns','published','needs_attention')),
 settlement text not null default 'pending' check(settlement in ('pending','settled','cancelled','conflict')),
 cancel_requested boolean not null default false,
 verified_at bigint,
 evidence jsonb,
 data jsonb not null,
 step_token uuid,
 step_expires timestamptz,
 retry_at timestamptz,
 created_at timestamptz not null default clock_timestamp()
);
create index publication_due on private.provider_publications(retry_at,created_at) where settlement='pending';
create index publication_history on private.provider_publications(site_id,verified_at desc) where verified_at is not null;
create table private.publication_attempts(
 id uuid primary key, intent_id uuid not null references private.provider_publications(id),
 account_id text not null references private.provider_accounts(id),
 action text not null, dispatched_at timestamptz not null default clock_timestamp(), result text
);
create index publication_deployment_quota on private.publication_attempts(account_id,dispatched_at) where action='create';
revoke all on private.provider_accounts,private.provider_publications,private.publication_attempts from public,anon,authenticated;
