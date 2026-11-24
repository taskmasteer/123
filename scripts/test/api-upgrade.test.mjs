import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {installRelease,rollbackRelease} from '../lib/api-upgrade.mjs';
const names=['dist','scripts','templates','references','supabase','apps','packages','node_modules'];
async function fixture(){const parent=await mkdtemp(join(tmpdir(),'sf-upgrade-')),root=join(parent,'old'),next=join(parent,'new');for(const [dir,value]of [[root,'old'],[next,'new']]){await mkdir(join(dir,'.local-state/server'),{recursive:true});await writeFile(join(dir,'.local-state/server/preserved'),'data');for(const name of names){await mkdir(join(dir,name));await writeFile(join(dir,name,'version'),value);}for(const name of ['package.json','package-lock.json','api-package.json'])await writeFile(join(dir,name),value);}return {parent,root,next};}
test('release switch and rollback preserve installation data',async()=>{const f=await fixture();try{await installRelease(f.root,f.next);assert.equal(await readFile(join(f.root,'dist/version'),'utf8'),'new');await rollbackRelease(f.root);await rollbackRelease(f.root);assert.equal(await readFile(join(f.root,'dist/version'),'utf8'),'old');assert.equal(await readFile(join(f.root,'.local-state/server/preserved'),'utf8'),'data');}finally{await rm(f.parent,{recursive:true,force:true});}});
test('interruption halfway through an upgrade restores all old components',async()=>{const f=await fixture();try{await assert.rejects(installRelease(f.root,f.next,async name=>{if(name==='templates')throw Error('interrupted');}),/interrupted/);for(const name of names)assert.equal(await readFile(join(f.root,name,'version'),'utf8'),'old');}finally{await rm(f.parent,{recursive:true,force:true});}});
