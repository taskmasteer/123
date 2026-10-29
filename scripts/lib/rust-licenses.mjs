import {spawnSync} from 'node:child_process';
import {readFile,writeFile,readdir,mkdir,copyFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {homedir} from 'node:os';
import {launcherEnvironment} from './launcher.mjs';
export function cargoEnvironment(extra={}){return {...launcherEnvironment(),CARGO_TARGET_DIR:resolve('.local-state/cargo-target'),SITE_FACTORY_TEST_NODE:process.execPath,CARGO_INCREMENTAL:'0',CARGO_PROFILE_DEV_DEBUG:'0',CARGO_PROFILE_TEST_DEBUG:'0',CARGO_PROFILE_RELEASE_DEBUG:'0',CARGO_BUILD_JOBS:'1',...extra};}
export function cargoPath(){return process.env.SITE_FACTORY_CARGO??join(homedir(),'.cargo/bin',process.platform==='win32'?'cargo.exe':'cargo');}
export function cargo(args,extra={}){const result=spawnSync(cargoPath(),args,{stdio:'inherit',windowsHide:true,env:cargoEnvironment(extra)});if(result.error)throw result.error;if(result.status!==0)throw new Error('Cargo failed: '+result.status);}
export async function rustLicenses(runtime,target){
 const manifests=['apps/desktop/src-tauri/Cargo.toml',...(target.includes('apple-darwin')?['apps/desktop/runtime-guard/Cargo.toml']:[])],packages=new Map();
 for(const manifest of manifests){
  const result=spawnSync(cargoPath(),['metadata','--offline','--locked','--format-version','1','--filter-platform',target,'--manifest-path',manifest],{encoding:'utf8',maxBuffer:32*1024**2,windowsHide:true,env:cargoEnvironment()});
  if(result.error)throw result.error;if(result.status!==0)throw new Error('Cannot collect locked Rust license metadata: '+result.stderr);
  const meta=JSON.parse(result.stdout),nodes=new Map(meta.resolve.nodes.map(n=>[n.id,n])),ids=new Set();
  function visit(id){if(ids.has(id))return;ids.add(id);for(const dep of nodes.get(id)?.deps??[])visit(dep.pkg);}visit(meta.resolve.root);
  for(const pkg of meta.packages.filter(p=>ids.has(p.id)))packages.set(pkg.name+'@'+pkg.version,pkg);
 }
 const inventory=[];
 for(const pkg of [...packages.values()].sort((a,b)=>(a.name+'@'+a.version).localeCompare(b.name+'@'+b.version))){
  const notices=(await readdir(dirname(pkg.manifest_path))).filter(n=>/^(LICENSE|COPYING|NOTICE|AUTHORS)(\.|-|$)/i.test(n));
  const dest=join(runtime,'licenses/rust',pkg.name+'-'+pkg.version);await mkdir(dest,{recursive:true});
  for(const notice of notices){const source=join(dirname(pkg.manifest_path),notice);try{await copyFile(source,join(dest,notice));}catch(e){if(e.code!=='EISDIR')throw e;}}
  if(!pkg.license&&!pkg.license_file&&pkg.source)throw new Error('Rust dependency lacks license metadata: '+pkg.name);
  inventory.push({name:pkg.name,version:pkg.version,license:pkg.license??(pkg.source?'SEE LICENSE FILE':'Private application'),source:pkg.source??'workspace',notices});
 }
 await writeFile(join(runtime,'licenses/rust-dependencies.json'),JSON.stringify(inventory,null,2));return inventory.length;
}
