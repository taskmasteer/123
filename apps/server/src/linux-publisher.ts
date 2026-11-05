import { Client } from 'ssh2';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { protectSecret } from './secrets.js';
import { AppError } from '../../../packages/contracts/src/model.js';
import type { ArtifactFile } from '../../../packages/contracts/src/model.js';
import { checkArtifacts } from '../../../packages/core/src/artifacts.js';
import { publicationDomain } from './hosting-policy.js';

export type LinuxHost={host:string;port:number;username:string;hostFingerprint:string;privateKeyEncrypted:string};
export type DeployTarget={siteId:string;revisionId:string;domain:string;ips:string[];order:string};
export async function linuxMaintain(host:LinuxHost,target:DeployTarget,action:'bindings'|'remove'|'prune',keep:string[]=[]){
  publicationDomain(target.domain);
  const helper=await readFile(join(process.env.SITE_FACTORY_SOURCE_ROOT??process.cwd(),'scripts/linux/publish.py'));
  const command=(host.username==='root'?'':'sudo -n ')+"python3 -c \"import base64;exec(base64.b64decode('"+helper.toString('base64')+"'))\"";
  const result=JSON.parse(await sshExecute(host,command,JSON.stringify({...target,action,keep})));
  if(!result.ok)throw new AppError('UNAVAILABLE','Linux не подтвердил обслуживание сайта.');return result;
}
export async function sshExecute(host:LinuxHost,command:string,input:string,timeout=300000,bootstrap?:{password?:string;privateKey?:string;passphrase?:string}){
  if(!/^SHA256:[A-Za-z0-9+/]{43}$/.test(host.hostFingerprint))throw new Error('Missing SSH host pin');
  const auth=bootstrap??{privateKey:await protectSecret(host.privateKeyEncrypted,true)};
  return new Promise<string>((resolve,reject)=>{
    const client=new Client();let result='',error='';
    const timer=setTimeout(()=>{client.destroy();reject(new AppError('UNAVAILABLE','Превышено время операции SSH. Повтор безопасен.'));},timeout);
    const fail=()=>{clearTimeout(timer);client.destroy();reject(new AppError('UNAVAILABLE','SSH-подключение не выполнено. Проверьте сервер и ключ.'));};
    client.on('error',fail).on('ready',()=>client.exec(command,(err,stream)=>{
      if(err)return fail();stream.on('data',(chunk:Buffer)=>{result+=chunk.toString();if(result.length>2000000)fail();});
      stream.stderr.on('data',(chunk:Buffer)=>{error+=chunk.toString();if(error.length>2000000)fail();});
      stream.on('close',(code:number)=>{clearTimeout(timer);client.end();if(code!==0){let message='Linux не подтвердил операцию.';try{const parsed=JSON.parse(result);if(typeof parsed.error==='string')message=parsed.error.slice(0,1800);}catch{}reject(new AppError('UNAVAILABLE',message));}else resolve(result);});stream.end(input);
    })).connect({host:host.host,port:host.port,username:host.username,...auth,readyTimeout:20000,keepaliveInterval:15000,hostVerifier:(key:Buffer)=>'SHA256:'+createHash('sha256').update(key).digest('base64').replace(/=+$/,'')===host.hostFingerprint});
  });
}
export async function linuxPublish(hostFile:string|LinuxHost,target:DeployTarget,files?:ArtifactFile[]){
  publicationDomain(target.domain);if(files)checkArtifacts(files);
  const host:LinuxHost=typeof hostFile==='string'?JSON.parse(await readFile(hostFile,'utf8')):hostFile;
  const input={...target,action:files?'deploy':'certificate',...(files?{files:files.map(file=>({path:file.path,data:Buffer.from(file.bytes).toString('base64'),sha256:createHash('sha256').update(file.bytes).digest('hex')}))}:{})};
  const result=JSON.parse(await sshExecute(host,(host.username==='root'?'':'sudo -n ')+'python3 /usr/local/lib/site-factory/publish.py',JSON.stringify(input)));
  if(!result.ok||result.revisionId!==target.revisionId)throw new AppError('UNAVAILABLE','Linux вернул неподтверждённую версию.');
  return result;
}
