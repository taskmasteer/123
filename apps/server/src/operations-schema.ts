import type {PoolClient} from 'pg';
export async function operationsSchema(tx:PoolClient){
  await tx.query(`
    create table if not exists factory.system_state(key text primary key,value jsonb not null);
    create table if not exists factory.backups(id uuid primary key,status text not null,path text,error text,bytes bigint,created_at timestamptz not null default now(),completed_at timestamptz);
    alter table factory.backups add column if not exists download_until timestamptz;
    alter table factory.hosting_hosts add column if not exists operation jsonb;
    alter table factory.hosting_hosts add column if not exists checked_at timestamptz;
    alter table factory.hosting_addresses add column if not exists state text not null default 'free';
    alter table factory.hosting_addresses add column if not exists release_after timestamptz;
    alter table factory.hosting_jobs add column if not exists retained boolean not null default true;
    create table if not exists factory.hosting_health(site_id uuid primary key references public.sites(id),revision_id uuid not null,address inet not null,status text not null,checks jsonb not null,checked_at timestamptz not null default now(),next_check timestamptz not null default now());
    create index if not exists hosting_health_due on factory.hosting_health(next_check);
  `);
  if(!(await tx.query("select 1 from factory.migrations where name='operations-v1'")).rowCount){
    await tx.query(`begin;
      update factory.hosting_addresses a set state=case when site_id is null then 'free' when exists(select 1 from factory.hosting_sites s where s.site_id=a.site_id and s.address=a.address) then 'active' else 'reserved' end;
      update factory.hosting_addresses a set state='draining',release_after=now()+interval '48 hours' where site_id is not null and state='reserved' and exists(select 1 from factory.hosting_sites s where s.site_id=a.site_id);
      update factory.hosting_addresses set release_after=coalesce(release_after,now()+interval '48 hours') where site_id is not null and state<>'active';
      insert into factory.migrations(name) values('operations-v1');commit;`);
  }
}
