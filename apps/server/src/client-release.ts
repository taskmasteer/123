import {readFile,open,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {AppError} from '../../../packages/contracts/src/model.js';
export async function clientRelease(root:string,hash?:string,offset?:number){
 const directory=resolve(root,'.local-state/client-updates');
 if(!hash){try{return JSON.parse(await readFile(resolve(directory,'current.json'),'utf8'));}catch{return {available:false,protocol:1};}}
 if(!/^[a-f0-9]{64}$/.test(hash))throw new AppError('INVALID_INPUT','Неверный идентификатор обновления.');
 const file=resolve(directory,hash+'.zip');let size:number;try{size=(await stat(file)).size;}catch{throw new AppError('NOT_FOUND','Пакет обновления не найден.');}
 if(!Number.isSafeInteger(offset)||offset!<0||offset!>=size)throw new AppError('INVALID_INPUT','Неверная позиция загрузки.');
 const handle=await open(file,'r');try{const bytes=Buffer.alloc(Math.min(1024*1024,size-offset!));if((await handle.read(bytes,0,bytes.length,offset)).bytesRead!==bytes.length)throw Error('Truncated update');return bytes;}finally{await handle.close();}
}
