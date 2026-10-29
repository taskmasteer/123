import {argumentsFor} from './lib/package-stage.mjs';
import {inventoryRuntime,sourceIdentity,sha256,checkRuntime,targetInfo} from './lib/package-runtime.mjs';
import {rustLicenses} from './lib/rust-licenses.mjs';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
export async function finalizeRuntime(target){
 const info=targetInfo(target),runtime=resolve('.local-state/package',target,'runtime');
 if(info.os==='darwin')await stat(join(runtime,'helpers/site-factory-runtime-guard'));
 await rustLicenses(runtime,info.triple);
 const lock=await readFile('scripts/runtime-sources.lock.json'),npm=await readFile('package-lock.json');
 await writeFile(join(runtime,'licenses/browser-provenance.json'),lock);
 const manifest=await inventoryRuntime(runtime,{target,source:await sourceIdentity(resolve('.')),signature:'unsigned-local',packageLockSha256:sha256(npm),sourceLockSha256:sha256(lock)}),bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
 await writeFile(join(runtime,'manifest.json'),bytes);const expected=sha256(bytes);const checked=await checkRuntime(runtime,expected,{target});
 const receipt={...checked,manifest:join(runtime,'manifest.json'),anchorTrust:'expected digest compiled by native trusted build; this checkout receipt is for independent package inspection',createdAt:new Date().toISOString()};
 await mkdir('.local-state/build-receipts',{recursive:true});await writeFile(resolve('.local-state/build-receipts',target+'.json'),JSON.stringify(receipt,null,2));return receipt;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{console.log(JSON.stringify(await finalizeRuntime(argumentsFor().target)));}catch(error){console.error(error.message);process.exitCode=1;}}
