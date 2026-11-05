import {readFile,writeFile,rename,rm,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {validateConnection,createConnection} from './connection.mjs';

export async function readConnectionFile(path){
 const {size}=await (await import('node:fs/promises')).stat(path);if(size>32768)throw Error('Файл подключения слишком большой.');
 return validateConnection(JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,'')));
}
export async function probeConnection(config){
 const candidate=createConnection(config);
 try{const response=await candidate.request('/auth/status');const body=JSON.parse(response.bytes);if(response.status!==200||!Object.hasOwn(body,'user')||typeof body.bootstrap!=='boolean')throw Error('По этому адресу не найден API Site Factory.');}finally{candidate.clear();}
}
export async function saveConnectionFile(path,config){
 const valid=validateConnection(config),temporary=path+'.'+randomUUID()+'.tmp';await mkdir(dirname(path),{recursive:true});
 try{await writeFile(temporary,JSON.stringify(valid,null,2),{flag:'wx',mode:0o600});await rename(temporary,path);}finally{await rm(temporary,{force:true});}
}
