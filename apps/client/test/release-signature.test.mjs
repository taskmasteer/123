import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {releasePayload,verifyRelease} from '../release-signature.mjs';
test('release metadata is authenticated independently of API transport',()=>{
 const keys=generateKeyPairSync('ed25519'),release={protocol:1,version:'0.6.0',size:123,sha256:'a'.repeat(64),publishedAt:new Date().toISOString()};
 release.signature=sign(null,releasePayload(release),keys.privateKey).toString('base64');
 assert.equal(verifyRelease(release,keys.publicKey),release);
 assert.throws(()=>verifyRelease({...release,size:124},keys.publicKey));
 assert.throws(()=>verifyRelease({...release,signature:''},keys.publicKey));
 assert.throws(()=>verifyRelease(release,generateKeyPairSync('ed25519').publicKey));
});
