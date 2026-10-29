import {argumentsFor,prepareRuntime,prepareBrowsers} from './lib/package-stage.mjs';
import {targetInfo,checkRuntime,binaryHeader,checkArchitecture,hashFile} from './lib/package-runtime.mjs';
import {requireSpace} from './lib/package-download.mjs';
import {finalizeRuntime} from './finalize-runtime.mjs';
import {cargo,cargoEnvironment} from './lib/rust-licenses.mjs';
import {runNode} from './lib/launcher.mjs';
import {tauriPackageConfiguration} from './lib/package-native.mjs';
import {mkdir,writeFile,readFile,copyFile,realpath,stat} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
try {
 const options=argumentsFor(),info=targetInfo(options.target);if(process.platform!==info.os||process.arch!==info.arch)throw new Error('Native packaging requires the matching OS/architecture host; cross-target source/architecture checks remain separate.');
 await mkdir('.local-state',{recursive:true});
 runNode('node_modules/typescript/bin/tsc',['-p','tsconfig.build.json']);
 runNode('node_modules/vite/bin/vite.js',['build'],{cwd:new URL('../apps/desktop',import.meta.url)});
 await prepareRuntime(options);await prepareBrowsers(options);
 const runtime=resolve('.local-state/package',options.target,'runtime');
 if(info.os==='darwin'){
  cargo(['build','--offline','--locked','--release','--target',info.triple,'--manifest-path','apps/desktop/runtime-guard/Cargo.toml']);
  await mkdir(join(runtime,'helpers'),{recursive:true});await copyFile(resolve('.local-state/cargo-target',info.triple,'release/site-factory-runtime-guard'),join(runtime,'helpers/site-factory-runtime-guard'));
  const signed=spawnSync('/usr/bin/codesign',['--force','--sign','-','--options','runtime',join(runtime,'helpers/site-factory-runtime-guard')],{stdio:'inherit'});if(signed.error)throw signed.error;if(signed.status!==0)throw Error('Local ad-hoc helper finalization failed before manifest creation.');
 }
 const receipt=await finalizeRuntime(options.target),base=resolve('.local-state/package',options.target),configuration=join(base,'tauri-package.json');
 let resourceSource=runtime;
 if(info.os==='win32'){
  const script=`(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${runtime.replaceAll("'","''")}').ShortPath`;
  const short=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true});
  if(short.status!==0)throw new Error('Cannot obtain read-only NSIS short source path');resourceSource=short.stdout.trim();
  if((await realpath(resourceSource)).toLowerCase()!==(await realpath(runtime)).toLowerCase())throw new Error('NSIS source alias does not resolve to the verified runtime tree');
  await checkRuntime(resourceSource,receipt.manifestSha256,{target:options.target});
  const manifest=JSON.parse(await readFile(receipt.manifest));if(manifest.files.some(file=>resourceSource.length+file.path.length+1>=260))throw new Error('NSIS source still exceeds MAX_PATH; choose a shorter authorized build path. Resource layout cannot be flattened.');
 }
 // Generic walked resources use fs::copy, dereferencing framework links. The
 // supported macOS directory mapping uses copy_dir and preserves those links.
 await writeFile(configuration,JSON.stringify(tauriPackageConfiguration(runtime,options.target,resourceSource),null,2));
 const executable=resolve('.local-state/cargo-target',info.triple,'release',info.os==='win32'?'site-factory-desktop.exe':'site-factory-desktop');
 // A warm rebuild retains all existing binaries. Reserve its measured incremental
 // envelope, rather than assuming the entire cold-build cap must coexist again.
 const warm=await stat(executable).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
 await requireSpace('.local-state',warm?512*1024**2:3*1024**3);
 const buildEnvironment=cargoEnvironment({SITE_FACTORY_PACKAGE_MANIFEST:receipt.manifest});
 // This command produces explicitly unsigned/ad-hoc local artifacts. Do not
 // discover/import signing or notarization credentials from ambient CI state.
 if(info.os==='darwin')for(const key of Object.keys(buildEnvironment))if(key.startsWith('APPLE_'))delete buildEnvironment[key];
 runNode('node_modules/@tauri-apps/cli/tauri.js',['build','--no-bundle','--target',info.triple,'--config',configuration],{cwd:resolve('apps/desktop'),env:buildEnvironment});
 checkArchitecture(await binaryHeader(executable),options.target);
 // Tauri already copied the intact runtime beside the Windows executable. Check
 // that actual portable layout; a second identical 875MB copy adds no evidence.
 const app=dirname(executable);
 if(info.os==='win32'){
  await checkRuntime(join(app,'runtime'),receipt.manifestSha256,{target:options.target});
  const smoke=spawnSync(join(app,'site-factory-desktop.exe'),['--package-smoke'],{encoding:'utf8',windowsHide:true,timeout:120000,env:{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,TEMP:process.env.TEMP,TMP:process.env.TMP}});
  await writeFile(join(base,'native-smoke.json'),JSON.stringify({status:smoke.status,stdout:smoke.stdout,stderr:smoke.stderr,error:smoke.error?.message},null,2));if(smoke.status!==0)throw new Error('Non-GUI native package smoke failed: '+smoke.stderr);
  await checkRuntime(join(app,'runtime'),receipt.manifestSha256,{target:options.target});
  runNode('scripts/smoke-runtime-browsers.mjs',['--root',join(app,'runtime'),'--expected-manifest-sha256',receipt.manifestSha256]);
 }
 await requireSpace('.local-state',1536*1024**2);
 runNode('node_modules/@tauri-apps/cli/tauri.js',['bundle','--target',info.triple,'--config',configuration],{cwd:resolve('apps/desktop'),env:buildEnvironment});
 if(info.os==='darwin'){
  const bundle=resolve('.local-state/cargo-target',info.triple,'release/bundle/macos/Site Factory.app'),resources=join(bundle,'Contents/Resources/runtime');
  await checkRuntime(resources,receipt.manifestSha256,{target:options.target});
  const smoke=spawnSync(join(bundle,'Contents/MacOS/site-factory-desktop'),['--package-smoke'],{encoding:'utf8',timeout:120000,env:{HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,LANG:process.env.LANG}});
  await writeFile(join(base,'native-smoke.json'),JSON.stringify({status:smoke.status,stdout:smoke.stdout,stderr:smoke.stderr,error:smoke.error?.message},null,2));if(smoke.status!==0)throw Error('Non-GUI Mac package smoke failed: '+smoke.stderr);
 }
 await writeFile(join(base,'package-result.json'),JSON.stringify({target:options.target,signature:'unsigned-local',executableSha256:await hashFile(executable),manifestSha256:receipt.manifestSha256,artifactDirectory:app,platformAcceptance:false},null,2));
 console.log(JSON.stringify({target:options.target,signature:'unsigned-local',artifactDirectory:app,manifestSha256:receipt.manifestSha256,platformAcceptance:false}));
}catch(error){console.error(error.stack??error.message);process.exitCode=1;}
