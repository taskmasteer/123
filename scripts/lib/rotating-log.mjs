import {Writable} from 'node:stream';
import {appendFile,rename,rm,stat} from 'node:fs/promises';
export function rotatingLog(file,maxBytes=10*1024*1024,keep=5){
 let size;
 return new Writable({write(chunk,_encoding,done){
  (async()=>{
   size??=await stat(file).then(s=>s.size,()=>0);
   if(size+chunk.length>maxBytes){
    await rm(file+'.'+keep,{force:true});
    for(let i=keep-1;i>=0;i--)await rename(i?file+'.'+i:file,file+'.'+(i+1)).catch(e=>{if(e.code!=='ENOENT')throw e;});
    size=0;
   }
   await appendFile(file,chunk,{mode:0o600});size+=chunk.length;
  })().then(()=>done(),done);
 }});
}
