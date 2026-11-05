import { createHash, randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from '../../../packages/contracts/src/model.js';
import { uuid } from '../../../packages/contracts/src/http.js';
import { artifactPath } from '../../../packages/core/src/artifacts.js';
import { writeZip } from '../../../packages/adapters/src/backup-archive.js';
import { privateDirectory } from '../../../packages/adapters/src/safe-files.js';
import type { ServerRuntime } from './runtime.js';

export async function downloadSource(runtime:ServerRuntime,raw:string,siteId:string,url:URL){
  const actor=await runtime.auth.verifyUser(raw);
  await runtime.repository.scoped(actor,uuid(siteId),'site:export');
  const revision=await runtime.repository.revision(uuid(url.searchParams.get('revisionId')));
  if(!revision||revision.siteId!==siteId)throw new AppError('NOT_FOUND','Версия не найдена.');
  const files=await runtime.store.read(revision.manifestId);
  if(files.reduce((sum,file)=>sum+file.bytes.length,0)>64*1024*1024)throw new AppError('INVALID_INPUT','Архив превышает 64 МБ.');
  const path=url.searchParams.get('path');
  let bytes:Uint8Array,name:string;
  if(path!==null){
    artifactPath(path);const file=files.find(file=>file.path===path);
    if(!file)throw new AppError('NOT_FOUND','Файл не найден.');
    bytes=file.bytes;name=path.split('/').at(-1)!;
  }else{
    const temporary=join(await privateDirectory(join(runtime.dataRoot,'exports')),randomUUID()+'.zip');
    try{
      await writeZip(temporary,(async function*(){for(const file of files)yield {name:file.path,size:file.bytes.length,sha256:createHash('sha256').update(file.bytes).digest('hex'),read:async()=>file.bytes};})());
      bytes=await readFile(temporary);name='site-'+siteId+'.zip';
    }finally{await unlink(temporary).catch(()=>{});}
  }
  await runtime.repository.scoped(await runtime.auth.verifyUser(raw),siteId,'site:export');
  return new Response(Buffer.from(bytes),{headers:{'content-type':'application/octet-stream','content-disposition':`attachment; filename*=UTF-8''${encodeURIComponent(name)}`,'cache-control':'no-store','content-security-policy':"default-src 'none'; sandbox"}});
}
