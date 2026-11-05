import {readFile,mkdir,copyFile,writeFile,rename} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..'),directory=resolve(root,'.local-state/client-updates');
const archive=resolve(root,'.local-state/releases/SiteFactory-Windows-x64.zip'),bytes=await readFile(archive),sha256=createHash('sha256').update(bytes).digest('hex');
if(bytes.subarray(0,2).toString()!=='PK')throw Error('Invalid client ZIP');
const {version}=JSON.parse(await readFile(resolve(root,'apps/client/package.json'),'utf8'));
await mkdir(directory,{recursive:true});const temporary=resolve(directory,randomUUID()+'.tmp');await copyFile(archive,temporary);await rename(temporary,resolve(directory,sha256+'.zip'));
const manifest={available:true,version,protocol:1,size:bytes.length,sha256,publishedAt:new Date().toISOString()};const pending=resolve(directory,randomUUID()+'.json');await writeFile(pending,JSON.stringify(manifest));await rename(pending,resolve(directory,'current.json'));console.log(JSON.stringify(manifest));
