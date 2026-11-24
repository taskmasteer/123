import type {Pool} from 'pg';
import {randomBytes,createHash} from 'node:crypto';
import {protectSecret} from './secrets.js';

/** Application SQL cannot create roles/databases or read server files. RLS is
 * enforced by the standalone API, which scopes every operation itself. */
export async function runtimeDatabaseRole(admin:Pool){
 const tx=await admin.connect();
 try{
  await tx.query('begin');await tx.query('select pg_advisory_xact_lock(78424528)');
  const database=(await tx.query('select current_database() name')).rows[0].name;
  const role='factory_api_'+createHash('sha256').update(database).digest('hex').slice(0,12);
  const row=(await tx.query("select value from factory.settings where key='database_runtime_password'")).rows[0];
  const password=row?await protectSecret(row.value,true):randomBytes(32).toString('base64url');
  if(!/^[A-Za-z0-9_-]{43}$/.test(password))throw Error('Invalid application database credential');
  if(!(await tx.query('select 1 from pg_roles where rolname=$1',[role])).rowCount)await tx.query(`create role ${role} login`);
  await tx.query(`alter role ${role} nosuperuser nocreatedb nocreaterole noreplication bypassrls password '${password}'`);
  for(const schema of ['auth','public','private','factory']){
   await tx.query(`grant usage on schema ${schema} to ${role}`);
   await tx.query(`grant select,insert,update,delete on all tables in schema ${schema} to ${role}`);
   await tx.query(`grant usage,select,update on all sequences in schema ${schema} to ${role}`);
   await tx.query(`grant execute on all functions in schema ${schema} to ${role}`);
  }
  await tx.query("insert into factory.settings values('database_runtime_password',$1) on conflict(key) do update set value=$1",[await protectSecret(password)]);
  await tx.query('commit');return {user:role,password};
 }catch(e){await tx.query('rollback');throw e;}finally{tx.release();}
}
