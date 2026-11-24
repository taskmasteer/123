import {apiReleasePayload,archiveDigest} from './lib/api-release.mjs';
import {sign} from 'node:crypto';
import {homedir} from 'node:os';
import {stat} from 'node:fs/promises';
import {mkdir,cp,readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=resolve(import.meta.dirname,'..'),target=process.argv.includes('--linux')?'linux':'windows',version=JSON.parse(await readFile(join(root,'apps/client/package.json'))).version,out=resolve(root,'.local-state/api-package-'+target+'-'+Date.now());await mkdir(out,{recursive:true});
for(const path of ['dist','templates','references','supabase/migrations','scripts','package.json','package-lock.json'])await cp(join(root,path),join(out,path),{recursive:true});
for(const family of ['apps','packages'])for(const name of await readdir(join(root,family))){try{const source=join(root,family,name,'package.json');await readFile(source);await mkdir(join(out,family,name),{recursive:true});await cp(source,join(out,family,name,'package.json'));}catch(e){if(!['ENOENT','ENOTDIR'].includes(e.code))throw e;}}
if(target==='windows')for(const part of ['bin','lib','share','server_license.txt','commandlinetools_3rd_party_licenses.txt'])await cp(join(root,'.local-state/tools/pgsql',part),join(out,'.local-state/tools/pgsql',part),{recursive:true});
await cp(join(root,'apps/client/release-key.pem'),join(out,'apps/client/release-key.pem'));
await cp(join(root,'docs/operations/api-portability.md'),join(out,'START-HERE.md'));
await writeFile(join(out,'api-package.json'),JSON.stringify({version,target,nodeMinimum:'24.21.0',postgresMajor:18,createdAt:new Date().toISOString()},null,2));
await mkdir(join(root,'.local-state/releases'),{recursive:true});
const archive=join(root,'.local-state/releases',`SiteFactory-API-${target}-x64-${version}.${target==='linux'?'tar.gz':'zip'}`),result=spawnSync('tar',[...(target==='linux'?['-czf']:['-a','-cf']),archive,'-C',out,'.'],{stdio:'inherit',windowsHide:true});if(result.status!==0)throw Error('Packaging failed');console.log(archive);

const manifest={kind:'site-factory-api',protocol:1,target,version,size:(await stat(archive)).size,sha256:await archiveDigest(archive),publishedAt:new Date().toISOString()};
try{manifest.signature=sign(null,apiReleasePayload(manifest),await readFile(process.env.SITE_FACTORY_RELEASE_KEY??join(homedir(),'.site-factory-signing/release.pem'))).toString('base64');}catch(e){if(e.code!=='ENOENT')throw e;console.warn('Unsigned development package: no release signing key available. Do not distribute as a verified release.');}
await writeFile(archive+'.json',JSON.stringify(manifest,null,2));
