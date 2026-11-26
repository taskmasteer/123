import {spawnSync} from 'node:child_process';
import {mkdir,cp,readFile,writeFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {packager} from '@electron/packager';
import {runNode} from './lib/launcher.mjs';
const root=resolve(import.meta.dirname,'..'),stage=resolve(root,'.local-state/client-stage');
runNode(resolve(root,'node_modules/vite/bin/vite.js'),['build','--config','vite.web.config.ts'],{cwd:resolve(root,'apps/desktop')});
await mkdir(stage,{recursive:true});
for(const file of ['main.mjs','release-signature.mjs','release-key.pem','preload.cjs','connection.mjs','connection-file.mjs','package.json'])await cp(resolve(root,'apps/client',file),resolve(stage,file));
await cp(resolve(root,'apps/desktop/dist-web'),resolve(stage,'ui'),{recursive:true});
await rm(resolve(stage,'connection.json'),{force:true});
try{await cp(resolve(root,'.local-state/client-connection.json'),resolve(stage,'connection.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
const metadata=JSON.parse(await readFile(resolve(root,'node_modules/electron/package.json'),'utf8'));
const outputs=await packager({dir:stage,out:resolve(root,'.local-state/releases'),name:'Site Factory',platform:'win32',arch:'x64',electronVersion:metadata.version,asar:true,overwrite:true,prune:false,win32metadata:{CompanyName:'Site Factory',FileDescription:'Site Factory desktop client',ProductName:'Site Factory'}});
if(process.env.SITE_FACTORY_SIGN_CERT_SHA1){const thumb=process.env.SITE_FACTORY_SIGN_CERT_SHA1;if(!/^[A-Fa-f0-9]{40}$/.test(thumb))throw Error('Invalid signing certificate thumbprint');for(const output of outputs){const result=spawnSync('signtool',['sign','/sha1',thumb,'/fd','SHA256','/tr','https://timestamp.digicert.com','/td','SHA256',resolve(output,'Site Factory.exe')],{stdio:'inherit',windowsHide:true});if(result.status!==0)throw Error('Authenticode signing failed');}}
await writeFile(resolve(root,'.local-state/client-build.json'),JSON.stringify({outputs,electron:metadata.version},null,2));
console.log('Desktop client built: '+outputs.join(', '));
