// Explicit deployment bootstrap; never called during signup or API requests.
import {Pool} from 'pg';
import {readFile} from 'node:fs/promises';
import {SupabaseRepository} from '../dist/packages/adapters/src/supabase-repository.js';
import {bootstrapAdmin} from '../dist/apps/control/src/routes/admin.js';
const id=process.argv[2];
if(!id||!process.env.DATABASE_URL||!process.env.SUPABASE_URL||!process.env.SUPABASE_SERVICE_ROLE_KEY)throw new Error('Explicit verified user ID and deployment environment required.');
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:1});
try{
 await bootstrapAdmin(new SupabaseRepository(pool),id,async userId=>{
  const response=await fetch(new URL('/auth/v1/admin/users/'+encodeURIComponent(userId),process.env.SUPABASE_URL),{headers:{apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,authorization:'Bearer '+process.env.SUPABASE_SERVICE_ROLE_KEY},redirect:'error'});
  if(!response.ok)throw new Error('Auth user verification failed.');const user=await response.json();if(user.id!==userId||typeof user.email!=='string')throw new Error('Verified user identity missing.');return {id:user.id,email:user.email};
 });
 const styles=JSON.parse(await readFile(new URL('../templates/catalog.json',import.meta.url),'utf8')),references=JSON.parse(await readFile(new URL('../references/catalog.json',import.meta.url),'utf8'));
 for(const {files,...style} of styles)await pool.query("insert into private.catalog values('style',$1,$2) on conflict do nothing",[style.id,style]);
 for(const reference of references)await pool.query("insert into private.catalog values('reference',$1,$2) on conflict do nothing",[reference.id,reference]);
 process.stdout.write('Verified deployment administrator and catalogue initialized.\n');
}finally{await pool.end();}
