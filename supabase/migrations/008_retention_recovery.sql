-- First transaction lock is the installation shared/exclusive retention fence.
alter table private.upload_preparations drop constraint upload_preparations_purpose_check;
alter table private.upload_preparations add check(purpose in ('artifact','checkpoint','validation'));
create sequence private.publication_settled_sequence;
alter table private.provider_publications add column settled_seq bigint,add column settled_at bigint;
create function private.stamp_publication_settlement() returns trigger language plpgsql set search_path='' as $$ begin
 if current_setting('site_factory.restore_import',true)='1' then return new;end if;
 if new.settlement='settled' and new.verified_at is not null and new.settled_seq is null and (tg_op='INSERT' or old.settlement is distinct from 'settled' or old.verified_at is null) then new.settled_seq=nextval('private.publication_settled_sequence');new.settled_at=floor(extract(epoch from clock_timestamp())*1000);end if;return new;end $$;
create trigger stamp_publication_settlement before insert or update on private.provider_publications for each row execute function private.stamp_publication_settlement();
revoke all on sequence private.publication_settled_sequence from public,anon,authenticated;
revoke all on function private.stamp_publication_settlement() from public,anon,authenticated;
create table private.payload_inventory(kind text not null,id text not null,site_id uuid,data jsonb not null,state text not null check(state in ('staging','available','claimed','deleted')),first_orphan_at bigint,claim_token uuid,primary key(kind,id));
create table private.payload_edges(owner_kind text not null,owner_id text not null,purpose text not null check(purpose in ('execution','retained')),target_kind text not null,target_id text not null,primary key(owner_kind,owner_id,purpose,target_kind,target_id));
create index payload_edges_target on private.payload_edges(target_kind,target_id);
create table private.checkpoint_evidence(id uuid primary key references private.checkpoints(id),job_id uuid not null references private.jobs(id),data jsonb not null);
create trigger immutable_checkpoint_evidence before update or delete on private.checkpoint_evidence for each row execute function private.immutable_record();
create table private.job_usage(job_id uuid primary key references private.jobs(id),checkpoint_id uuid not null references private.checkpoints(id),data jsonb not null);
create table private.payload_pins(id uuid not null,kind text not null,payload_id text not null,expires_at timestamptz not null,primary key(id,kind,payload_id));
create index payload_pins_target on private.payload_pins(kind,payload_id,expires_at);
create table private.recovery_state(key text primary key,data jsonb not null);
create table private.recovery_snapshots(id uuid primary key,actor_id uuid not null,expires_at timestamptz not null,data jsonb not null);
create table private.recovery_snapshot_records(snapshot_id uuid not null references private.recovery_snapshots(id),seq bigint not null,data jsonb not null,primary key(snapshot_id,seq));
create index recovery_snapshot_table_id on private.recovery_snapshot_records(snapshot_id,(data->>'table'),(data#>>'{row,id}'));
revoke all on private.payload_inventory,private.payload_edges,private.checkpoint_evidence,private.job_usage,private.payload_pins,private.recovery_state,private.recovery_snapshots,private.recovery_snapshot_records from public,anon,authenticated;
create function private.assert_payload(p_kind text,p_id text) returns void language plpgsql set search_path='' as $$
begin
 if p_id is not null and exists(select 1 from private.payload_inventory where kind=p_kind and id=p_id and state in ('claimed','deleted')) then raise exception 'PAYLOAD_PRUNED'; end if;
end $$;
create function private.guard_recovery_write() returns trigger language plpgsql set search_path='' as $$
declare d jsonb; r record;
begin
 if exists(select 1 from private.recovery_state where key='quarantine') and current_setting('site_factory.restore',true) is distinct from '1' then raise exception 'RECOVERY_QUARANTINED'; end if;
 if tg_op='DELETE' then return old; end if;
 d=to_jsonb(new);
 if tg_table_name='sites' then
  for r in select manifest_id from public.revisions where id in ((d->>'draft_id')::uuid,(d->>'published_id')::uuid) loop perform private.assert_payload('artifact',r.manifest_id::text); end loop;
  perform private.assert_payload('resource',d#>>'{input,logoAssetId}');
 elsif tg_table_name='revisions' then perform private.assert_payload('artifact',d->>'manifest_id');
 elsif tg_table_name='jobs' and d#>>'{data,state}' not in ('completed','cancelled') then
  perform private.assert_payload('checkpoint',d->>'checkpoint_id');perform private.assert_payload('artifact',d#>>'{data,edit,baseManifestId}');perform private.assert_payload('checkpoint',d#>>'{data,providerRecovery,checkpointId}');
 elsif tg_table_name='publication_reservations' then
  perform private.assert_payload('artifact',d#>>'{binding,manifestId}');perform private.assert_payload('checkpoint',d#>>'{binding,checkpointId}');
 elsif tg_table_name='provider_publications' then perform private.assert_payload('artifact',d->>'manifest_id');
 elsif tg_table_name='batch_rows' then perform private.assert_payload('resource',d#>>'{data,input,logoAssetId}');
 elsif tg_table_name='import_chunks' then perform private.assert_payload('resource',d->>'resource_id');
 elsif tg_table_name in ('edit_requests','deployments') and (d#>>'{data,state}'='pending' or d#>>'{data,status}' in ('queued','running','checking','ready')) then perform private.assert_payload('artifact',d#>>'{data,manifestId}');
 end if;
 return new;
end $$;
do $$ declare t text; begin
 foreach t in array array['public.sites','public.revisions','private.jobs','private.edit_requests','private.deployments','private.site_operations','private.publication_reservations','private.provider_publications','private.provider_accounts','private.batches','private.batch_rows','private.import_resources','private.import_chunks','private.catalog','private.upload_preparations'] loop
  execute format('create trigger recovery_payload_guard before insert or update or delete on %s for each row execute function private.guard_recovery_write()',t);
 end loop;
end $$;
revoke all on function private.assert_payload(text,text),private.guard_recovery_write() from public,anon,authenticated;

-- Staged physical lookup stays bounded when a backup has hundreds of thousands of objects.
create index recovery_verified_source on private.recovery_snapshot_records(snapshot_id,(data->>'source')) where data->>'type'='verified';

create function private.guard_payload_identity() returns trigger language plpgsql set search_path='' as $$ begin
 if new.kind<>old.kind or new.id<>old.id or new.data->'objects' is distinct from old.data->'objects' or (old.state in ('claimed','deleted') and new.state not in ('claimed','deleted')) then raise exception 'PAYLOAD_PRUNED';end if;return new;end $$;
create trigger immutable_payload_identity before update on private.payload_inventory for each row execute function private.guard_payload_identity();
revoke all on function private.guard_payload_identity() from public,anon,authenticated;
