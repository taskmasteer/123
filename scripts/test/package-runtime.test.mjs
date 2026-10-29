import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { inventoryRuntime, checkRuntime, checkArchitecture, workspaceClosure } from '../lib/package-runtime.mjs';
import {expectedNsisMain,tauriPackageConfiguration} from '../lib/package-native.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
test('expected installer main permits only the exact pinned first bundle-type transformation',()=>{
 const original=Buffer.from('prefix:__TAURI_BUNDLE_TYPE_VAR_UNK:suffix'),expected=Buffer.from('prefix:__TAURI_BUNDLE_TYPE_VAR_NSS:suffix'),proof=expectedNsisMain(original);
 assert.equal(proof.sha256,sha(expected));assert.equal(proof.replacementCount,1);assert.equal(original.toString(),'prefix:__TAURI_BUNDLE_TYPE_VAR_UNK:suffix');
 expected[0]^=1;assert.notEqual(proof.sha256,sha(expected));assert.throws(()=>expectedNsisMain(Buffer.from('missing marker')),/marker/);
});
test('target config preserves Mac runtime directory links using supported Contents files mapping',()=>{
 for(const target of ['darwin-arm64','darwin-x64']){const config=tauriPackageConfiguration('/fixed/runtime',target);assert.deepEqual(config.bundle.resources,{});assert.deepEqual(config.bundle.macOS.files,{'Resources/runtime':'/fixed/runtime'});assert.deepEqual(config.bundle.targets,['app','dmg']);}
 const win=tauriPackageConfiguration('C:/checked/runtime','win32-x64','C:/CHECKE~1/runtime');assert.deepEqual(win.bundle.resources,{'C:/CHECKE~1/runtime/':'runtime/'});assert.equal(win.bundle.macOS,undefined);
});
async function fixture(action) { const root = await mkdtemp(join(tmpdir(), 'sf-package-test-')); try { await action(root); } finally { await rm(root, { recursive: true, force: true }); } }
test('resource plus adjacent manifest/checksum replacement cannot satisfy an independent expected anchor', async () => fixture(async root => {
  await writeFile(join(root, 'worker.js'), 'original');
  const manifest = await inventoryRuntime(root, { target: 'win32-x64' });
  const bytes = Buffer.from(JSON.stringify(manifest)); await writeFile(join(root, 'manifest.json'), bytes);
  await checkRuntime(root, sha(bytes), { required: false, target: 'win32-x64' });
  await writeFile(join(root, 'worker.js'), 'changed');
  const changed = Buffer.from(JSON.stringify(await inventoryRuntime(root, { target: 'win32-x64' })));
  await writeFile(join(root, 'manifest.json'), changed); await writeFile(join(root, 'manifest.sha256'), sha(changed));
  await assert.rejects(checkRuntime(root, sha(bytes), { required: false, target: 'win32-x64' }), /anchor/i);
}));
test('missing, extra and corrupt files fail exact inventory validation', async () => fixture(async root => {
  await writeFile(join(root, 'worker.js'), 'original');
  const bytes = Buffer.from(JSON.stringify(await inventoryRuntime(root, { target: 'win32-x64' })));
  await writeFile(join(root, 'manifest.json'), bytes);
  await writeFile(join(root, 'worker.js'), 'corrupted');
  await assert.rejects(checkRuntime(root, sha(bytes), { required: false, target: 'win32-x64' }), /hash|inventory|size/i);
  await writeFile(join(root, 'worker.js'), 'original'); await writeFile(join(root, 'extra'), 'x');
  await assert.rejects(checkRuntime(root, sha(bytes), { required: false, target: 'win32-x64' }), /inventory/i);
  await rm(join(root, 'extra')); await rm(join(root, 'worker.js'));
  await assert.rejects(checkRuntime(root, sha(bytes), { required: false, target: 'win32-x64' }), /inventory/i);
}));
test('PE and Mach-O architecture checks reject a different target and truncated headers', () => {
  const pe = Buffer.alloc(160); pe.write('MZ'); pe.writeUInt32LE(64, 60); pe.write('PE\0\0', 64); pe.writeUInt16LE(0x8664, 68);
  assert.equal(checkArchitecture(pe, 'win32-x64'), true);
  assert.throws(() => checkArchitecture(pe, 'darwin-arm64'), /architecture/i);
  const macho = Buffer.alloc(32); macho.writeUInt32LE(0xfeedfacf); macho.writeUInt32LE(0x0100000c, 4);
  assert.equal(checkArchitecture(macho, 'darwin-arm64'), true);
  assert.throws(() => checkArchitecture(macho, 'darwin-x64'), /architecture/i);
  assert.throws(() => checkArchitecture(Buffer.from('MZ'), 'win32-x64'), /header|architecture/i);
});
test('preserved emitted imports include actual modules and fail unresolved or nonliteral workspace imports', async () => fixture(async root => {
  await mkdir(join(root, 'apps/worker/src'), { recursive: true }); await mkdir(join(root, 'packages/core/src'), { recursive: true });
  const entry = 'apps/worker/src/stdio.js';
  await writeFile(join(root, entry), "import '../../../packages/core/src/run.js'; import {readFile} from 'node:fs/promises';");
  await writeFile(join(root, 'packages/core/src/run.js'), 'export const run=1;');
  assert.deepEqual((await workspaceClosure(root, entry)).files.sort(), [entry, 'packages/core/src/run.js']);
  await writeFile(join(root, entry), "import './missing.js';");
  await assert.rejects(workspaceClosure(root, entry), /resolve|missing/i);
  await writeFile(join(root, entry), 'export const run=p=>import(p);');
  await assert.rejects(workspaceClosure(root, entry), /nonliteral/i);
}));

test('provenance distinguishes an actual clean commit from changed or untracked source bytes',async()=>fixture(async root=>{
 const {sourceIdentity}=await import('../lib/package-runtime.mjs'), {execFileSync}=await import('node:child_process');
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
 git('init','-q');await writeFile(join(root,'source.js'),'original');git('add','source.js');git('-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','fixture');
 const clean=await sourceIdentity(root);assert.equal(clean.revision,git('rev-parse','HEAD'));assert.equal(clean.dirty,false);
 await writeFile(join(root,'source.js'),'changed');const dirty=await sourceIdentity(root);assert.equal(dirty.dirty,true);assert.match(dirty.fingerprint,/^[a-f0-9]{64}$/);
 await writeFile(join(root,'new.js'),'new source');assert.notEqual((await sourceIdentity(root)).fingerprint,dirty.fingerprint);
}));
test('reachable missing vendor fails inside staged root even with the dependency in an ancestor',async()=>fixture(async root=>{
 const {verifyStagedDependencies}=await import('../lib/package-runtime.mjs');
 const stage=join(root,'runtime');await mkdir(join(stage,'node_modules/a'),{recursive:true});await mkdir(join(root,'node_modules/b'),{recursive:true});
 await writeFile(join(stage,'entry.js'),"import 'a';");await writeFile(join(stage,'node_modules/a/package.json'),JSON.stringify({name:'a',main:'index.js',dependencies:{b:'1.0.0'}}));await writeFile(join(stage,'node_modules/a/index.js'),"require('b')");await writeFile(join(root,'node_modules/b/package.json'),JSON.stringify({name:'b',main:'index.js'}));await writeFile(join(root,'node_modules/b/index.js'),'module.exports=1;');
 await assert.rejects(verifyStagedDependencies(stage,'entry.js'),/staged|dependency|resolve/i);
 await mkdir(join(stage,'node_modules/b'),{recursive:true});await writeFile(join(stage,'node_modules/b/package.json'),JSON.stringify({name:'b',main:'index.js'}));await writeFile(join(stage,'node_modules/b/index.js'),'module.exports=1;');await verifyStagedDependencies(stage,'entry.js');
}));
