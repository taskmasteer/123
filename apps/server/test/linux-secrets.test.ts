import {test,expect} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {linuxSecretCodec} from '../src/linux-secrets.js';
test('Linux secrets authenticate ciphertext and require the installation key',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sf-secrets-'));try{
  const path=join(dir,'key');await writeFile(path,randomBytes(32),{mode:0o600});const codec=linuxSecretCodec(path);
  const secret='fixture-'+randomBytes(16).toString('hex'),a=await codec(secret),b=await codec(secret);
  expect(a).not.toBe(b);expect(a).not.toContain(secret);expect(await codec(a,true)).toBe(secret);
  const bytes=Buffer.from(a.slice(12),'base64');bytes[15]!^=1;await expect(codec('sf-linux-v1:'+bytes.toString('base64'),true)).rejects.toThrow();
  await writeFile(path,randomBytes(32));await expect(codec(a,true)).rejects.toThrow();await expect(codec('old-dpapi-ciphertext',true)).rejects.toThrow(/portable backup/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
