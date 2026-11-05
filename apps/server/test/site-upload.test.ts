import {test,expect} from 'vitest';
import {zipSync,strToU8} from 'fflate';
import {readSiteZip,createSiteUpload} from '../src/site-upload.js';
test('ZIP accepts complete static site and rejects missing root, collisions, executable files and oversized expansion',async()=>{
 const zip=(files:Record<string,Uint8Array>)=>Buffer.from(zipSync(files));
 const files=await readSiteZip(zip({'index.html':strToU8('<h1>New version</h1>'),'assets/main.css':strToU8('body{}')}));
 expect(files.map(f=>f.path)).toEqual(['index.html','assets/main.css']);
 for(const bad of [{'folder/index.html':strToU8('x')},{'index.html':strToU8('x'),'INDEX.html':strToU8('y')},{'index.html':strToU8('x'),'app.php':strToU8('x')},{'index.html':new Uint8Array(2000001)},{'../index.html':strToU8('x')}])await expect(readSiteZip(zip(bad))).rejects.toThrow();
});
test('upload is owner-bound, rejects offsets and stale versions before saving artifacts',async()=>{
 let revision=1,puts=0;const site={domain:'fixture.example',revision:1};
 const runtime:any={repository:{scoped:async()=>({...site,revision}),acquire:async()=>({}),release:async()=>{}},store:{put:async()=>{puts++;}}};
 const call=createSiteUpload(runtime),actor:any={userId:'owner'},bytes=Buffer.from(zipSync({'index.html':strToU8('<h1>Version</h1>')}));
 const begin=await call(actor,'site',{action:'begin',size:bytes.length});if(!('id' in begin))throw new Error('Missing upload id');
 await expect(call({userId:'other'} as any,'site',{action:'chunk',id:begin.id,offset:0,base64:bytes.toString('base64')})).rejects.toThrow();
 await expect(call(actor,'site',{action:'chunk',id:begin.id,offset:1,base64:bytes.toString('base64')})).rejects.toThrow();
 await call(actor,'site',{action:'chunk',id:begin.id,offset:0,base64:bytes.toString('base64')});revision++;
 await expect(call(actor,'site',{action:'commit',id:begin.id})).rejects.toThrow(/изменилась/);expect(puts).toBe(0);
});
