-- Durable send intent: an unknown POST result must never trigger another email automatically.
-- user_id/evidence are recorded only from privileged provider responses, never user_metadata.
create table private.invitation_attempts (
 operation_id uuid primary key references private.invitations(id),
 user_id uuid,
 evidence text check(evidence in ('invite','existing')),
 attempted_at timestamptz not null default clock_timestamp(),
 check ((user_id is null and evidence is null) or (user_id is not null and evidence is not null))
);
revoke all on private.invitation_attempts from public,anon,authenticated;
