import {publicationIssues} from '../../worker/src/validation/static.js';
import {randomUUID} from 'node:crypto';
import {fromBuffer} from 'yauzl';
import {AppError,type ArtifactFile,type Principal} from '../../../packages/contracts/src/model.js';
import {artifactPath,artifactMediaType,checkArtifacts,artifactLimits} from '../../../packages/core/src/artifacts.js';
import {publicationDomain} from './hosting-policy.js';
import type {ServerRuntime} from './runtime.js';

const invalid=(message='Нужен ZIP со статическими файлами и index.html в корне.'):never=>{throw new AppError('INVALID_INPUT',message);};
export async function readSiteZip(bytes:Buffer):Promise<ArtifactFile[]>{
 const files:ArtifactFile[]=[];let total=0,entries=0;
 await new Promise<void>((resolve,reject)=>fromBuffer(bytes,{lazyEntries:true,strictFileNames:true,validateEntrySizes:true},(error,zip)=>{
  if(error||!zip){reject(new AppError('INVALID_INPUT','Не удалось прочитать ZIP.'));return;}
  const fail=(e:unknown)=>{zip.close();reject(e);};zip.on('error',fail);zip.on('end',resolve);
  zip.on('entry',entry=>{void(async()=>{
   if(++entries>200||entry.generalPurposeBitFlag&1||((entry.externalFileAttributes>>>16)&0xf000)===0xa000)invalid('Архив содержит недопустимые записи.');
   if(entry.fileName.endsWith('/')){if(/(^\/|\\|(^|\/)\.\.(\/|$))/.test(entry.fileName))invalid();zip.readEntry();return;}
   const path=artifactPath(entry.fileName);if(entry.uncompressedSize>artifactLimits.fileBytes||files.length>=artifactLimits.files)invalid('Слишком много файлов или файл больше 2 МБ.');
   const stream=await new Promise<import('node:stream').Readable>((yes,no)=>zip.openReadStream(entry,(e,s)=>e||!s?no(e):yes(s)));
   const chunks:Buffer[]=[];let size=0;
   for await(const chunk of stream){size+=chunk.length;total+=chunk.length;if(size>artifactLimits.fileBytes||total>artifactLimits.totalBytes){stream.destroy();invalid('Общий размер файлов превышает 10 МБ.');}chunks.push(Buffer.from(chunk));}
   files.push({path,bytes:Buffer.concat(chunks),mediaType:artifactMediaType(path)});zip.readEntry();
  })().catch(fail);});zip.readEntry();
 }));
 checkArtifacts(files);if(!files.some(f=>f.path==='index.html'))invalid();
 const issues=publicationIssues(files);
 if(issues.length)invalid('Архив содержит ошибку: '+issues.slice(0,3).map(i=>(i.path??'')+' — '+i.message).join('; '));
 if(!files.find(f=>f.path==='index.html')!.bytes.length)invalid('index.html пуст.');return files;
}

/** Bounded, actor/site-bound transfer. A lost process expires the transfer, never a live version. */
export function createSiteUpload(runtime:ServerRuntime){
 type Transfer={owner:string;site:string;revision:number;size:number;bytes:Buffer;offset:number;expires:number;busy:boolean;result?:{revisionId:string}};
 const transfers=new Map<string,Transfer>();
 return async(actor:Principal,siteId:string,body:any)=>{
  if(!body||typeof body!=='object'||Array.isArray(body))invalid();
  for(const [id,t] of transfers)if(t.expires<Date.now()&&!t.busy)transfers.delete(id);
  const site=await runtime.repository.scoped(actor,siteId,'site:edit');publicationDomain(site.domain);
  if(body.action==='begin'){
   if(!Number.isSafeInteger(body.size)||body.size<1||body.size>11000000)invalid('ZIP должен быть не больше 11 МБ.');
   const active=[...transfers.values()].filter(t=>!t.result);
   if(active.length>=4||active.reduce((n,t)=>n+t.size,0)+body.size>33000000)throw new AppError('CONFLICT','Другие архивы ещё загружаются. Повторите позже.');
   // Completed receipts support lost commit responses without consuming upload slots.
   if(transfers.size>=256){const receipt=[...transfers].find(([,t])=>t.result);if(receipt)transfers.delete(receipt[0]);}
   const id=randomUUID();transfers.set(id,{owner:actor.userId,site:siteId,revision:site.revision,size:body.size,bytes:Buffer.alloc(body.size),offset:0,expires:Date.now()+600000,busy:false});return {id};
  }
  const t=transfers.get(body.id);if(!t||t.owner!==actor.userId||t.site!==siteId)throw new AppError('NOT_FOUND','Загрузка истекла. Выберите ZIP заново.');
  if(t.busy)throw new AppError('CONFLICT','Архив уже обрабатывается.');
  if(body.action==='abort'){transfers.delete(body.id);return {offset:0};}
  if(body.action==='chunk'){
   if(t.result||typeof body.base64!=='string'||body.base64.length>44000||!Number.isSafeInteger(body.offset))invalid();
   const chunk=Buffer.from(body.base64,'base64');if(!chunk.length||chunk.toString('base64')!==body.base64||body.offset<0||body.offset+chunk.length>t.size)invalid('Порядок частей архива нарушен.');
   if(body.offset<t.offset&&body.offset+chunk.length<=t.offset&&t.bytes.subarray(body.offset,body.offset+chunk.length).equals(chunk))return {offset:t.offset};
   if(body.offset!==t.offset)invalid('Порядок частей архива нарушен.');
   chunk.copy(t.bytes,t.offset);t.offset+=chunk.length;return {offset:t.offset};
  }
  if(body.action!=='commit')invalid();if(t.result)return t.result;
  if(t.offset!==t.size)invalid('Архив загружен не полностью.');t.busy=true;
  try{
   const files=await readSiteZip(t.bytes),admission=await runtime.repository.acquire(actor,siteId);
   try{
    const current=await runtime.repository.scoped(actor,siteId,'site:edit');if(current.revision!==t.revision)throw new AppError('CONFLICT','Версия сайта изменилась. Загрузите архив заново.');
    const manifest=await runtime.store.put(siteId,files,'user-zip-v1'),revisionId=randomUUID();
    await runtime.repository.transaction(async tx=>{
     await runtime.repository.guard(tx,admission);
     const latest=await runtime.repository.get(siteId,tx);if(latest?.revision!==t.revision)throw new AppError('CONFLICT','Версия сайта изменилась.');
     await tx.query('insert into public.revisions values($1,$2,$3,$4,$5,$6)',[revisionId,siteId,current.draftId,manifest.id,'draft',Date.now()]);
     await tx.query('update public.sites set revision=revision+1,draft_id=$2 where id=$1',[siteId,revisionId]);
    });
    t.result={revisionId};t.bytes=Buffer.alloc(0);t.size=0;return t.result;
   }finally{await runtime.repository.release(admission);}
  }finally{t.busy=false;}
 };
}
