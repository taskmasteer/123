import {Pool} from 'pg';
import {readFile} from 'node:fs/promises';
export async function database(){
 if(!process.env.SITE_FACTORY_TEST_DB)throw new Error('Run npm run test:integration (dedicated PostgreSQL required).');
 const pool=new Pool(JSON.parse(process.env.SITE_FACTORY_TEST_DB));
 await pool.query(`drop schema if exists private cascade; drop schema public cascade; create schema public; drop schema if exists auth cascade; create schema auth;
 do $$ begin if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin nosuperuser nobypassrls; create role anon nologin nosuperuser nobypassrls; end if; end $$;
 create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema public,auth to authenticated,anon; grant execute on function auth.uid() to authenticated,anon;`);
 await pool.query(await readFile('supabase/migrations/001_registry_auth_artifacts.sql','utf8'));
 return pool;
}
export const identities={user:'11111111-1111-4111-8111-111111111111',spec:'22222222-2222-4222-8222-222222222222',admin:'33333333-3333-4333-8333-333333333333'};
export async function seedUsers(pool:Pool){ for(const [key,id] of Object.entries(identities)) {await pool.query('insert into auth.users values($1)',[id]);await pool.query('insert into public.users values($1,$2)',[id,key+'@example.test']);await pool.query('insert into public.memberships values($1,$2,true)',[id,key==='spec'?'spec-user':key]);} }
