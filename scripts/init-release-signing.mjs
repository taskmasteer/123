import {generateKeyPairSync} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
const directory=resolve(homedir(),'.site-factory-signing'),file=join(directory,'release.pem');
await mkdir(directory,{recursive:true,mode:0o700});
if(process.platform==='win32'){
 const result=spawnSync('icacls',[directory,'/inheritance:r','/grant:r',process.env.USERDOMAIN+'\\'+process.env.USERNAME+':(OI)(CI)F'],{stdio:'ignore',windowsHide:true});if(result.status!==0)throw Error('Cannot restrict signing key directory');
}
let key;try{key=await readFile(file);}catch(e){if(e.code!=='ENOENT')throw e;const pair=generateKeyPairSync('ed25519');key=pair.privateKey.export({format:'pem',type:'pkcs8'});await writeFile(file,key,{flag:'wx',mode:0o600});}
const {createPublicKey}=await import('node:crypto');
await writeFile(resolve('apps/client/release-key.pem'),createPublicKey(key).export({format:'pem',type:'spki'}));
console.log('Public release key exported. Keep the signing directory outside API access and copy it to offline storage.');
