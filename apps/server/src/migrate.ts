import {operationsSchema} from './operations-schema.js';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';

/** Dedicated installation only; never adopts an existing unmanaged schema. */
export async function migrate(pool: Pool, root: string) {
  const tx = await pool.connect();
  try {
    await tx.query('select pg_advisory_lock(78424519)');
    await tx.query(`create schema if not exists factory;
      create table if not exists factory.migrations(name text primary key, applied_at timestamptz default now());`);
    const initialized = (await tx.query("select 1 from factory.migrations where name='bootstrap'")).rowCount;
    if (!initialized) {
      if ((await tx.query("select to_regclass('public.sites') existing")).rows[0].existing) throw new Error('Use a dedicated empty database for the Windows server.');
      await tx.query(`begin;
        create schema auth; create table auth.users(id uuid primary key);
        create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
        do $$begin if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
        if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if; end$$;
        insert into factory.migrations(name) values('bootstrap'); commit;`);
    }
    for (const name of (await readdir(join(root,'supabase/migrations'))).filter(n=>n.endsWith('.sql')).sort()) {
      if ((await tx.query('select 1 from factory.migrations where name=$1',[name])).rowCount) continue;
      await tx.query('begin');
      try { await tx.query(await readFile(join(root,'supabase/migrations',name),'utf8')); await tx.query('insert into factory.migrations(name) values($1)',[name]); await tx.query('commit'); }
      catch(error) {await tx.query('rollback');throw error;}
    }
    await tx.query(`create table if not exists factory.accounts(id uuid primary key references public.users(id), password_hash text not null, created_at timestamptz default now());
      create table if not exists factory.sessions(hash text primary key, user_id uuid not null references factory.accounts(id), csrf text not null, expires_at timestamptz not null);
      create table if not exists factory.invites(hash text primary key, login text, expires_at timestamptz not null, used_at timestamptz, created_by uuid references factory.accounts(id));
      create table if not exists factory.audit(id bigint generated always as identity primary key, actor uuid, action text not null, created_at timestamptz default now());
      create table if not exists factory.settings(key text primary key, value text not null);
      create table if not exists factory.attempts(key text primary key, count int not null, until_at timestamptz not null);
      update public.memberships set role='admin' where role<>'admin';`);
    // The standalone host uses usernames. Keep the legacy cloud column nullable;
    // never invent email addresses or require one for a local account.
    await tx.query(`begin;
      alter table public.users alter column email drop not null;
      alter table factory.accounts add column if not exists login text;
      update factory.accounts set login='user_'||left(replace(id::text,'-',''),26) where login is null;
      alter table factory.accounts alter column login set not null;
      create unique index if not exists factory_accounts_login on factory.accounts(lower(login));
      alter table factory.invites add column if not exists login text;
      do $$begin if exists(select 1 from information_schema.columns where table_schema='factory' and table_name='invites' and column_name='email') then
        update factory.invites set used_at=now() where used_at is null;
        alter table factory.invites drop column email;
      end if;end$$;
      commit;`);
    if(!(await tx.query("select 1 from factory.migrations where name='registration-keys-20-minutes'")).rowCount){
      await tx.query(`begin;
        update factory.invites set used_at=now() where used_at is null;
        insert into factory.migrations(name) values('registration-keys-20-minutes');
        commit;`);
    }
    for (const [kind,path] of [['style','templates/catalog.json'],['reference','references/catalog.json']] as const) {
      for (const {files:_files,...entry} of JSON.parse(await readFile(join(root,path),'utf8'))) await tx.query('insert into private.catalog values($1,$2,$3) on conflict do nothing',[kind,entry.id,entry]);
    }
    await tx.query(`
      create table if not exists factory.hosting_hosts(id text primary key,name text not null,host inet not null,port int not null,username text not null,host_fingerprint text,credential text not null,bootstrap text,config jsonb not null default '{}',status text not null default 'queued',phase text not null default 'connect',error text,report jsonb,created_at timestamptz default now(),updated_at timestamptz default now(),unique(host,port));
      create table if not exists factory.hosting_addresses(address inet primary key, host_id text not null, site_id uuid references public.sites(id), priority int not null default 0);
      create table if not exists factory.hosting_sites(site_id uuid primary key references public.sites(id), address inet not null unique references factory.hosting_addresses(address), revision_id uuid references public.revisions(id), updated_at timestamptz default now());
      create table if not exists factory.hosting_jobs(id bigint generated always as identity primary key, site_id uuid not null references public.sites(id), revision_id uuid not null references public.revisions(id), address inet not null references factory.hosting_addresses(address), action text not null, status text not null default 'queued', phase text not null default 'upload', error text, dns_before jsonb, dns_after jsonb, actor uuid not null references public.users(id), created_at timestamptz default now(), updated_at timestamptz default now(), next_attempt timestamptz default now());
      create unique index if not exists hosting_one_active_job on factory.hosting_jobs(site_id) where status in ('queued','running','waiting');
      create index if not exists hosting_jobs_due on factory.hosting_jobs(status,next_attempt,id);
      alter table factory.hosting_jobs add column if not exists dns_provider text not null default 'namecheap';
      create table if not exists factory.hosting_domains(domain text primary key,provider text not null check(provider in ('namecheap','godaddy')));
    `);
    await operationsSchema(tx);
    await tx.query('alter table factory.hosting_jobs add column if not exists retry_count integer not null default 0');
    await tx.query(`create table if not exists factory.auto_publications(site_id uuid primary key references public.sites(id),actor uuid not null references public.users(id),status text not null default 'waiting',error text,created_at timestamptz not null default now());`);
  } finally { await tx.query('select pg_advisory_unlock(78424519)');tx.release(); }
}
