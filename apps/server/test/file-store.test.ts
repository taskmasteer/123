import {afterEach,test,expect,vi} from 'vitest';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {FileObjectTransport} from '../src/file-store.js';
import {directory,cleanDirectories} from '../../worker/test/fixtures.js';
vi.mock('node:fs/promises',async original=>{const actual=await original<typeof import('node:fs/promises')>();return {...actual,link:vi.fn(actual.link)};});
afterEach(async()=>{vi.clearAllMocks();await cleanDirectories();});
const bytes=Buffer.from('complete immutable payload'),key='private/site/file';
test('atomic objects preserve metadata, ranges, limits, retries and deletion across restart',async()=>{
  const root=await directory(),store=new FileObjectTransport(root);await store.put(key,bytes,'text/plain');
  const reopened=new FileObjectTransport(root);expect(await reopened.head(key)).toEqual({size:bytes.length,mediaType:'text/plain'});
  expect(Buffer.from(await reopened.get(key,100))).toEqual(bytes);expect(Buffer.from(await reopened.range(key,9,9)).toString()).toBe('immutable');
  await expect(reopened.get(key,3)).rejects.toThrow();await expect(reopened.range(key,2,100)).rejects.toThrow();await expect(reopened.range(key,-1,1)).rejects.toThrow();
  await reopened.put(key,bytes,'text/plain');await expect(reopened.put(key,bytes,'text/html')).rejects.toThrow();
  await reopened.delete(key);await expect(reopened.head(key)).rejects.toThrow();
});
test('competing processes cannot overwrite a published object',async()=>{
  const root=await directory(),a=new FileObjectTransport(root),b=new FileObjectTransport(root);
  await Promise.all([a.put(key,bytes,'text/plain'),b.put(key,bytes,'text/plain')]);
  const outcomes=await Promise.allSettled([a.put(key+'2',Buffer.from('first'),'text/plain'),b.put(key+'2',Buffer.from('second'),'text/plain')]);
  expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(outcomes.filter(r=>r.status==='rejected')).toHaveLength(1);
  expect(['first','second']).toContain(Buffer.from(await a.get(key+'2',100)).toString());
});
test('failed publication exposes no partial object and a restart can retry',async()=>{
  const root=await directory(),store=new FileObjectTransport(root);
  vi.mocked(fs.link).mockImplementationOnce(async()=>{await expect(store.head(key)).rejects.toThrow();throw new Error('Simulated failure before commit');});
  await expect(store.put(key,bytes,'text/plain')).rejects.toThrow('Simulated failure');
  expect(await fs.readdir(join(root,'private/site'))).toEqual([]);
  // A process killed mid-write may leave an unreachable staging file.
  await fs.writeFile(join(root,key+'.pending-crashed'),bytes.subarray(0,4));
  await expect(store.head(key)).rejects.toThrow();await new FileObjectTransport(root).put(key,bytes,'text/plain');
  expect(Buffer.from(await store.get(key,100))).toEqual(bytes);
});
test('legacy data stays readable and interrupted MIME sidecars can be repaired without replacing bytes',async()=>{
  const root=await directory(),store=new FileObjectTransport(root);await fs.mkdir(join(root,'private/site'),{recursive:true});
  await fs.writeFile(join(root,key),bytes);await fs.writeFile(join(root,key+'.mime'),'text/plain');
  expect(await store.head(key)).toEqual({size:bytes.length,mediaType:'text/plain'});expect(Buffer.from(await store.get(key,100))).toEqual(bytes);
  await fs.unlink(join(root,key+'.mime'));await expect(store.head(key)).rejects.toThrow();
  await expect(store.put(key,Buffer.from('different'),'text/plain')).rejects.toThrow();
  await store.put(key,bytes,'text/plain');expect(await store.head(key)).toEqual({size:bytes.length,mediaType:'text/plain'});
  await store.delete(key);expect(await fs.readdir(join(root,'private/site'))).toEqual([]);
});
test('corrupted committed objects fail closed instead of falling back to older files',async()=>{
  const root=await directory(),store=new FileObjectTransport(root);await store.put(key,bytes,'text/plain');
  const path=join(root,key+'.object'),data=await fs.readFile(path);data[data.length-1]=data[data.length-1]!^1;await fs.writeFile(path,data);
  await expect(store.get(key,100)).rejects.toThrow('Corrupt');
  await fs.writeFile(path,Buffer.from('truncated'));await fs.writeFile(join(root,key),bytes);await fs.writeFile(join(root,key+'.mime'),'text/plain');
  await expect(store.head(key)).rejects.toThrow('Invalid object header');
});
