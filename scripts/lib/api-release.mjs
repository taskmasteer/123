import {createHash,verify} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {stat,readFile} from 'node:fs/promises';

export function apiReleasePayload(manifest){
 if(manifest.kind!=='site-factory-api'||manifest.protocol!==1||!['windows','linux'].includes(manifest.target)||!/^\d+\.\d+\.\d+$/.test(manifest.version)||!/^[a-f0-9]{64}$/.test(manifest.sha256)||!Number.isSafeInteger(manifest.size)||manifest.size<1||!Number.isFinite(Date.parse(manifest.publishedAt)))throw Error('Invalid API release metadata');
 return Buffer.from(JSON.stringify([manifest.kind,manifest.protocol,manifest.target,manifest.version,manifest.size,manifest.sha256,manifest.publishedAt]));
}
export async function archiveDigest(path){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
export async function verifyApiArchive(path,key){
 const manifest=JSON.parse(await readFile(path+'.json','utf8'));
 if(typeof manifest.signature!=='string'||!verify(null,apiReleasePayload(manifest),key,Buffer.from(manifest.signature,'base64')))throw Error('API package signature not verified');
 if((await stat(path)).size!==manifest.size||await archiveDigest(path)!==manifest.sha256)throw Error('API package content does not match its signed manifest');
 return manifest;
}
