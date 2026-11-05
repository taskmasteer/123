import { randomBytes, createHash } from 'node:crypto';
import { readFile, mkdir, stat, lstat, unlink, open, link } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ObjectTransport } from '../../../packages/adapters/src/r2-store.js';
import { AppError } from '../../../packages/contracts/src/model.js';
import { safeFile, privateDirectory } from '../../../packages/adapters/src/safe-files.js';

const magic=Buffer.from('SFOBJ001');
const missing=(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT';
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
type Descriptor={file:string;offset:number;size:number;mediaType:string;sha256?:string};

/** The signed-upload transport is only reachable inside the server process. */
export class FileObjectTransport implements ObjectTransport {
  private uploads = new Map<string,{key:string;type:string;expires:number}>();
  constructor(private root: string) {}
  private async path(key:string) {
    if(!/^private\/[a-zA-Z0-9_/-]+$/.test(key)||key.split('/').some(p=>!p||p==='..'))throw new AppError('INVALID_INPUT','Неверный ключ файла.');
    return safeFile(await privateDirectory(this.root),key,true);
  }
  async signPut(key:string,mediaType:string) {
    for(const [id,item] of this.uploads) if(item.expires<Date.now())this.uploads.delete(id);
    if(this.uploads.size>10000)throw new AppError('UNAVAILABLE','Очередь загрузок заполнена.');
    const id=randomBytes(32).toString('hex');this.uploads.set(id,{key,type:mediaType,expires:Date.now()+600000});
    return 'https://storage.factory.invalid/'+id;
  }
  async upload(request:Request) {
    const id=new URL(request.url).pathname.slice(1),item=this.uploads.get(id);
    if(!item||item.expires<Date.now()||request.method!=='PUT'||request.headers.get('content-type')!==item.type)return new Response(null,{status:403});
    const bytes=new Uint8Array(await request.arrayBuffer());if(bytes.length>8000000)return new Response(null,{status:413});
    await this.put(item.key,bytes,item.type);this.uploads.delete(id);return new Response(null,{status:200});
  }
  async put(key:string,bytes:Uint8Array,mediaType:string) {
    const path=await this.path(key);await mkdir(dirname(path),{recursive:true});
    const same=async()=>{const info=await this.descriptor(path);if(info.mediaType!==mediaType||info.size!==bytes.length||!Buffer.from(await this.get(key,bytes.length)).equals(bytes))throw new AppError('CONFLICT','Файл уже существует с другим содержимым.');};
    try{await stat(path+'.object');await same();return;}catch(error){if(!missing(error))throw error;}
    // Old two-file objects remain readable. A retry can repair a missing MIME
    // sidecar, but must never overwrite different, possibly referenced bytes.
    try{
      const old=await readFile(path);if(!old.equals(bytes))throw new AppError('CONFLICT','Файл уже существует с другим содержимым.');
      try{if(await readFile(path+'.mime','utf8')!==mediaType)throw new AppError('CONFLICT','Тип файла изменился.');}catch(error){if(!missing(error))throw error;}
    }catch(error){if(!missing(error))throw error;}
    const metadata=Buffer.from(JSON.stringify({size:bytes.length,mediaType,sha256:digest(bytes)}));
    if(metadata.length>16384)throw new AppError('INVALID_INPUT','Слишком длинные метаданные файла.');
    const header=Buffer.alloc(12);magic.copy(header);header.writeUInt32BE(metadata.length,8);
    const pending=path+'.pending-'+randomBytes(16).toString('hex');
    try{
      const file=await open(pending,'wx',0o600);
      try{await file.writeFile(Buffer.concat([header,metadata,bytes]));await file.sync();}finally{await file.close();}
      // Atomic no-overwrite publication on NTFS/POSIX. Interrupted writes stay
      // unreachable; payload and metadata become visible together.
      try{await link(pending,path+'.object');}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;await same();}
    }finally{await unlink(pending).catch(error=>{if(!missing(error))throw error;});}
  }
  private async descriptor(path:string):Promise<Descriptor>{
    let file;try{const info=await lstat(path+'.object');if(info.isSymbolicLink()||!info.isFile())throw new Error('Unsafe object file');file=await open(path+'.object','r');}catch(error){if(!missing(error))throw error;return {file:path,offset:0,size:(await stat(path)).size,mediaType:await readFile(path+'.mime','utf8')};}
    try{
      const prefix=Buffer.alloc(12);if((await file.read(prefix,0,12,0)).bytesRead!==12||!prefix.subarray(0,8).equals(magic))throw new Error('Invalid object header');
      const length=prefix.readUInt32BE(8);if(length<1||length>16384)throw new Error('Invalid object metadata');
      const bytes=Buffer.alloc(length);if((await file.read(bytes,0,length,12)).bytesRead!==length)throw new Error('Truncated object metadata');
      const value=JSON.parse(bytes.toString());if(!Number.isSafeInteger(value.size)||value.size<0||typeof value.mediaType!=='string'||!/^([a-f0-9]{64})$/.test(value.sha256)||12+length+value.size!==(await file.stat()).size)throw new Error('Invalid object metadata');
      return {file:path+'.object',offset:12+length,size:value.size,mediaType:value.mediaType,sha256:value.sha256};
    }finally{await file.close();}
  }
  async head(key:string){const info=await this.descriptor(await this.path(key));return {size:info.size,mediaType:info.mediaType};}
  async get(key:string,maxBytes:number){const info=await this.descriptor(await this.path(key));if(info.size>maxBytes)throw new AppError('INVALID_INPUT','Превышен размер файла.');const bytes=(await readFile(info.file)).subarray(info.offset);if(info.sha256&&digest(bytes)!==info.sha256)throw new Error('Corrupt object payload');return new Uint8Array(bytes);}
  async range(key:string,offset:number,length:number){const info=await this.descriptor(await this.path(key));if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<0||offset+length>info.size)throw new Error('Invalid range');const f=await open(info.file,'r');try{const bytes=Buffer.alloc(length);const r=await f.read(bytes,0,length,info.offset+offset);if(r.bytesRead!==length)throw new Error('Truncated range');return bytes;}finally{await f.close();}}
  async delete(key:string){const p=await this.path(key);for(const file of [p+'.object',p,p+'.mime'])try{await unlink(file);}catch(e){if(!missing(e))throw e;}}
}
