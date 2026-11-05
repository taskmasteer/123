import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';

/** Installation key stays outside archives. Backups export secrets under the recovery key. */
export function linuxSecretCodec(path:string){
 return async(value:string,decrypt=false):Promise<string>=>{
  const file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));let key:Buffer;
  try{const info=await file.stat();if(!info.isFile()||info.size!==32||process.platform!=='win32'&&((info.mode&0o077)!==0||info.uid!==process.getuid?.()))throw Error('Installation key permissions are unsafe');key=await file.readFile();}finally{await file.close();}
  const aad=Buffer.from('site-factory-linux-secrets-v1');
  try{
   if(!decrypt){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad);return 'sf-linux-v1:'+Buffer.concat([iv,cipher.update(value,'utf8'),cipher.final(),cipher.getAuthTag()]).toString('base64');}
   if(!value.startsWith('sf-linux-v1:'))throw Error('Restore a portable backup to migrate secrets');
   const bytes=Buffer.from(value.slice(12),'base64');if(bytes.length<28)throw Error('Invalid secret');
   const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAAD(aad);decipher.setAuthTag(bytes.subarray(-16));return Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]).toString('utf8');
  }finally{key!.fill(0);}
 };
}
