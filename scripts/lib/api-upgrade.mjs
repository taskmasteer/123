import {mkdir,readFile,writeFile,rename,stat} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';

const files=['dist','scripts','templates','references','supabase','apps','packages','package.json','package-lock.json','api-package.json','node_modules'];
const exists=path=>stat(path).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
async function save(path,value){const temp=path+'.tmp';await writeFile(temp,JSON.stringify(value),{mode:0o600});await rename(temp,path);}
function safeChild(root,path){const rel=relative(resolve(root),resolve(path));if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('Unsafe upgrade path');return resolve(path);}

/** Data, connection profiles, signing keys and PostgreSQL are never moved. */
export async function rollbackRelease(root){
 const pointer=join(root,'.local-state/upgrade.json'),journal=JSON.parse(await readFile(pointer,'utf8'));
 const backup=safeChild(join(root,'.local-state/upgrades'),journal.backup),failed=join(backup,'failed');await mkdir(failed,{recursive:true});
 if(journal.state==='rolled-back')return;
 for(const entry of [...journal.entries].reverse()){
  if(!files.includes(entry.name))throw Error('Invalid upgrade journal');
  const current=join(root,entry.name),old=join(backup,entry.name);
  if(await exists(old)){
   if(await exists(current))await rename(current,join(failed,entry.name));
   await rename(old,current);
  }else if(!entry.hadOld&&await exists(current))await rename(current,join(failed,entry.name));
 }
 journal.state='rolled-back';await save(pointer,journal);
}
export async function installRelease(root,prepared,afterStep=async()=>{}){
 for(const name of files)if(!await exists(join(prepared,name)))throw Error('Incomplete prepared release: '+name);
 const pointer=join(root,'.local-state/upgrade.json'),backup=join(root,'.local-state/upgrades',randomUUID());await mkdir(backup,{recursive:true});
 const journal={state:'installing',backup,entries:[]};await save(pointer,journal);
 try{
  for(const name of files){
   const current=join(root,name),hadOld=await exists(current);journal.entries.push({name,hadOld});await save(pointer,journal);
   if(hadOld)await rename(current,join(backup,name));
   await rename(join(prepared,name),current);await afterStep(name);
  }
  journal.state='applied';await save(pointer,journal);return {backup};
 }catch(error){await rollbackRelease(root);throw error;}
}
