-- Operational capabilities/progress are not portable logical installation records (schema8).
create table private.recovery_transfers(
 id uuid primary key references private.recovery_snapshots(id),
 session_scope text,
 binding jsonb not null,
 created_at timestamptz not null default clock_timestamp(),
 max_expires_at timestamptz not null default clock_timestamp()+interval '24 hours',
 phase text not null default 'staging' check(phase in ('staging','preparing','validating','ready','committed','cancelled','failed')),
 metadata_seq bigint not null default 0,
 resource_seq bigint not null default 0,
 resource_offset integer not null default 0,
 data jsonb not null default '{}',
 claim uuid,
 claim_expires timestamptz
);
create index recovery_transfers_expiry on private.recovery_transfers(max_expires_at) where phase<>'committed';
create table private.recovery_transfer_receipts(
 id uuid not null references private.recovery_transfers(id),cursor text not null,digest text not null,
 kind text not null check(kind in ('metadata','resources')),data jsonb not null,complete boolean not null default false,
 primary key(id,cursor)
);
create table private.recovery_transfer_parts(
 id uuid not null references private.recovery_transfers(id),kind text not null check(kind in ('metadata','resources')),
 seq bigint not null,offset_bytes integer not null,bytes bytea not null,primary key(id,kind,seq,offset_bytes)
);
create index recovery_original_file on private.recovery_snapshot_records(snapshot_id,seq) where seq<1000000 and data->>'type'='file';
create index recovery_prepared_table on private.recovery_snapshot_records(snapshot_id,(data->>'table'),seq) where seq>=6000000000;
create index recovery_verified_digest on private.recovery_snapshot_records(snapshot_id,(data->>'sha256')) where data->>'type'='verified';
create index recovery_verified_png_digest on private.recovery_snapshot_records(snapshot_id,(data->>'sha256')) where seq>=4000000000 and seq<5000000000 and data->>'type'='verified' and data->'pngVerified'='true'::jsonb;
create table private.recovery_transfer_metadata(id uuid references private.recovery_transfers(id),seq bigint,size integer not null,sha256 text not null,primary key(id,seq));
create table private.recovery_transfer_inventory(id uuid references private.recovery_transfers(id),page bigint,digest text not null,primary key(id,page));
create table private.recovery_transfer_catalog(id uuid references private.recovery_transfers(id),version text,primary key(id,version));
create table private.recovery_transfer_objects(id uuid references private.recovery_transfers(id),seq bigint,key text not null,size integer not null,sha256 text not null,primary key(id,seq));
revoke all on private.recovery_transfers,private.recovery_transfer_receipts,private.recovery_transfer_parts from public,anon,authenticated;
revoke all on private.recovery_transfer_metadata,private.recovery_transfer_inventory from public,anon,authenticated;
revoke all on private.recovery_transfer_catalog,private.recovery_transfer_objects from public,anon,authenticated;
