// Read the installer as an archive. Never execute it or initialize Tauri/OS stores.
import {spawnSync} from 'node:child_process';
import {readFile,writeFile,mkdir,rename,stat} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {hashFile,sha256,safeRelative,checkRuntime,targetInfo} from './lib/package-runtime.mjs';
import {requireSpace} from './lib/package-download.mjs';
import {expectedNsisMain} from './lib/package-native.mjs';
function run(exe,args,options={}){const value=spawnSync(exe,args,{encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:8*1024**2,...options});if(value.error)throw value.error;return value;}
try{
 if(process.platform!=='win32')throw Error('Windows installer inspection requires the Windows component host.');
 const at=process.argv.indexOf('--installer');if(at<0||!process.argv[at+1])throw Error('Provide --installer for the generated NSIS artifact.');
 const installer=resolve(process.argv[at+1]),lock=JSON.parse(await readFile('scripts/package-tools.lock.json'));
 const inspector=resolve(lock.localBuild.path);if(await hashFile(inspector)!==lock.localBuild.sha256)throw Error('Inspector differs from reviewed official-source build digest.');
 const receipt=JSON.parse(await readFile('.local-state/build-receipts/win32-x64.json')),build=JSON.parse(await readFile('.local-state/package/win32-x64/package-result.json'));
 const listing=run(inspector,['l','-slt','-ba',installer]);if(listing.status!==0||!listing.stdout.includes('Path = runtime'))throw Error('Cannot read generated NSIS resource inventory: '+listing.stderr);
 let total=0,count=0;for(const block of listing.stdout.split(/\r?\n\r?\n/)){const path=/^Path = (.+)$/m.exec(block)?.[1];if(!path)continue;safeRelative(path.replaceAll('\\','/'));if(++count>100000)throw Error('Installer entry count exceeds bound');total+=Number(/^Size = (\d+)$/m.exec(block)?.[1]??0);}
 if(total>1536*1024**2)throw Error('Installer extraction exceeds phase cap');
 const installerSha256=await hashFile(installer),destination=resolve('.local-state/installer-inspection','win32-x64-'+installerSha256.slice(0,16));
 await mkdir(dirname(destination),{recursive:true});
 try{await stat(destination);}catch(error){if(error.code!=='ENOENT')throw error;await requireSpace(dirname(destination),total);await mkdir(destination);const extraction=run(inspector,['x','-y','-o'+destination,installer]);if(extraction.status!==0)throw Error('Read-only NSIS extraction failed: '+extraction.stderr);}
 await requireSpace(dirname(destination),64*1024**2);
 const runtime=join(destination,'runtime'),native=join(destination,'site-factory-desktop.exe');
 const portable=join(build.artifactDirectory,'site-factory-desktop.exe');if(await hashFile(portable)!==build.executableSha256)throw Error('Portable main differs from the verified build.');
 const transformation=expectedNsisMain(await readFile(portable));
 if(await hashFile(native)!==transformation.sha256)throw Error('Installer native executable differs from the exact expected Tauri NSIS build transformation.');
 const checked=await checkRuntime(runtime,receipt.manifestSha256,{target:'win32-x64'});
 const environment={SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,TEMP:process.env.TEMP,TMP:process.env.TMP};
 const info=run(native,['--package-info'],{env:environment});if(info.status!==0||JSON.parse(info.stdout).manifestSha256!==receipt.manifestSha256)throw Error('Extracted main has a different compiled anchor.');
 const smoke=()=>run(native,['--package-smoke'],{env:environment});const first=smoke();if(first.status!==0)throw Error('Extracted native smoke failed: '+first.stderr);
 const manifestPath=join(runtime,'manifest.json'),manifestBytes=await readFile(manifestPath),worker=join(runtime,'apps/worker/src/stdio.js'),workerBytes=await readFile(worker);let replacement;
 try{
  const changed=Buffer.concat([workerBytes,Buffer.from('\n// fixture corruption\n')]);await writeFile(worker,changed);
  const manifest=JSON.parse(manifestBytes),record=manifest.files.find(file=>file.path==='apps/worker/src/stdio.js');record.size=changed.length;record.sha256=sha256(changed);await writeFile(manifestPath,JSON.stringify(manifest));
  replacement=smoke();if(replacement.status===0||!replacement.stderr.includes('Восстановите'))throw Error('Native accepted resource plus adjacent manifest replacement or lost recovery guidance.');
 }finally{await writeFile(worker,workerBytes);await writeFile(manifestPath,manifestBytes);}
 const chrome=join(runtime,'browsers/chromium-1248',targetInfo('win32-x64').chrome),held=chrome+'.inspection-held';let missing;
 await rename(chrome,held);try{missing=smoke();if(missing.status===0||!missing.stderr.includes('Восстановите'))throw Error('Missing browser did not fail clearly.');}finally{await rename(held,chrome);}
 const recovered=smoke();if(recovered.status!==0)throw Error('Package did not recover after exact resource repair: '+recovered.stderr);
 await checkRuntime(runtime,receipt.manifestSha256,{target:'win32-x64'});
 const evidence={...checked,installer,installerSha256,installerBytes:(await stat(installer)).size,extractedBytes:total,destination,inspectorSha256:lock.localBuild.sha256,portableMainSha256:build.executableSha256,installedMain:transformation,nativeSmoke:JSON.parse(first.stdout),resourceAndManifestReplacementRejected:true,missingBrowserRejected:true,recovered:JSON.parse(recovered.stdout),installerExecuted:false,gui:false,cleanWin11Acceptance:false};
 await writeFile('.local-state/package/win32-x64/installer-inspection.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}catch(error){console.error(error.stack??error.message);process.exitCode=1;}
