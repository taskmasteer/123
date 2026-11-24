import {readFile,mkdir,copyFile,rename,rm,open,stat} from 'node:fs/promises';
import {resolve,join,sep,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';

async function digest(path:string){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
/** Replicate only the authenticated encrypted archive; keys stay on the API. */
export async function replicateBackup(data:string,file:string,id:string){
 let config:{directory:string};
 try{config=JSON.parse(await readFile(join(data,'backup-replica.json'),'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {configured:false};throw e;}
 if(!isAbsolute(config.directory)||!/^[-a-f0-9]{36}$/.test(id))throw Error('Invalid backup destination');
 const destination=resolve(config.directory);
 if(destination===resolve(data)||destination.startsWith(resolve(data)+sep))throw Error('Backup destination must be separate from application data');
 await mkdir(destination,{recursive:true,mode:0o700});
 const final=join(destination,'site-factory-'+id+'.sfbak'),temporary=final+'.'+randomUUID()+'.partial';
 try{
  await copyFile(file,temporary);const handle=await open(temporary,'r+');try{await handle.sync();}finally{await handle.close();}
  if((await stat(file)).size!==(await stat(temporary)).size||await digest(file)!==await digest(temporary))throw Error('Backup replica verification failed');
  await rename(temporary,final);return {configured:true,verified:true};
 }finally{await rm(temporary,{force:true});}
}
