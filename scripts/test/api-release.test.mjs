import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {apiReleasePayload,archiveDigest,verifyApiArchive} from '../lib/api-release.mjs';
test('API release binds platform and content to the separate API signature domain',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sf-api-release-')),file=join(dir,'api.zip'),keys=generateKeyPairSync('ed25519');
 try{
  await writeFile(file,'fixture');
  const manifest={kind:'site-factory-api',protocol:1,target:'windows',version:'0.6.0',size:7,sha256:await archiveDigest(file),publishedAt:new Date().toISOString()};
  manifest.signature=sign(null,apiReleasePayload(manifest),keys.privateKey).toString('base64');await writeFile(file+'.json',JSON.stringify(manifest));
  assert.equal((await verifyApiArchive(file,keys.publicKey)).version,'0.6.0');
  await writeFile(file+'.json',JSON.stringify({...manifest,target:'linux'}));await assert.rejects(verifyApiArchive(file,keys.publicKey),/signature/);
  await writeFile(file+'.json',JSON.stringify(manifest));await writeFile(file,'changed');await assert.rejects(verifyApiArchive(file,keys.publicKey),/content/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
