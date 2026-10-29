import {test,expect} from 'vitest';
import {uploadResources} from '../src/remote-uploads.js';
const id='11111111-1111-4111-8111-111111111111';
test('Node sends bytes directly to scoped R2 PUT without worker bearer or base64 control JSON',async()=>{
 const calls:{url:string;init:RequestInit}[]=[];const bytes=Buffer.from('<h1>immutable</h1>');
 const result=await uploadResources({controlOrigin:'https://control.test',workerToken:'fixture-worker',lease:{jobId:id,workerId:id,generation:1,expiresAt:1},purpose:'artifact',templateVersion:'1.0.0',expectedCheckpointId:null,files:[{path:'index.html',mediaType:'text/html',bytes}],fetch:async(url,init)=>{calls.push({url:String(url),init:init!});if(String(url).endsWith('/prepare'))return Response.json({uploadId:id,expiresAt:Date.now()+600000,files:[{path:'index.html',objectKey:'private/artifacts/immutable',url:'https://fixture.r2.cloudflarestorage.com/private/immutable?signature=fixture',headers:{'content-type':'text/html','if-none-match':'*'}}]});if(init?.method==='PUT')return new Response(null,{status:200});return Response.json({uploadId:id,manifestId:id,checkpointId:null});}});
 expect(result.manifestId).toBe(id);expect(calls[1]!.init.headers).toEqual({'content-type':'text/html','if-none-match':'*'});expect(calls[1]!.init.body).toEqual(bytes);expect(String(calls[0]!.init.body)).not.toContain(bytes.toString('base64'));expect(calls[1]!.url).not.toContain('fixture-worker');
});

const grant = { uploadId: id, expiresAt: Date.now() + 600000, files: [{ path: 'index.html', objectKey: 'private/artifacts/immutable', url: 'https://fixture.r2.cloudflarestorage.com/private/immutable?signature=fixture', headers: { 'content-type': 'text/html', 'if-none-match': '*' } }] };
const uploadOptions = { controlOrigin: 'https://control.test', workerToken: 'fixture-worker', lease: { jobId: id, workerId: id, generation: 1, expiresAt: 1 }, purpose: 'artifact' as const, templateVersion: '1.0.0', expectedCheckpointId: null, files: [{ path: 'index.html', mediaType: 'text/html', bytes: Buffer.from('contents') }] };
for (const phase of ['prepare', 'put', 'complete'] as const) {
 test(`aborts a pending ${phase} upload phase without retrying it`, async () => {
  const controller = new AbortController(), calls: string[] = [];
  let entered!: () => void; const started = new Promise<void>(resolve => entered = resolve);
  const transport: typeof fetch = async (url, init) => {
   const current = String(url).endsWith('/prepare') ? 'prepare' : init?.method === 'PUT' ? 'put' : 'complete';
   calls.push(current);
   if (current === phase) { entered(); return new Promise<Response>(() => {}); }
   return current === 'prepare' ? Response.json(grant) : current === 'put' ? new Response(null, {status: 200}) : Response.json({uploadId:id, manifestId:id, checkpointId:null});
  };
  const running = uploadResources({ ...uploadOptions, signal: controller.signal, fetch: transport });
  await started; controller.abort();
  const outcome = await Promise.race([running.then(() => 'resolved', () => 'aborted'), new Promise<string>(resolve => setTimeout(() => resolve('stuck'), 50))]);
  expect(outcome).toBe('aborted');
  expect(calls.filter(value => value === phase)).toHaveLength(1);
 });
 test(`times out a pending ${phase} upload phase`, async () => {
  const transport: typeof fetch = async (url, init) => {
   const current = String(url).endsWith('/prepare') ? 'prepare' : init?.method === 'PUT' ? 'put' : 'complete';
   if (current === phase) return new Promise<Response>(() => {});
   return current === 'prepare' ? Response.json(grant) : current === 'put' ? new Response(null, {status: 200}) : Response.json({uploadId:id, manifestId:id, checkpointId:null});
  };
  const running = uploadResources({ ...uploadOptions, timeoutMs: 10, fetch: transport });
  const outcome = await Promise.race([running.then(() => 'resolved', () => 'timed out'), new Promise<string>(resolve => setTimeout(() => resolve('stuck'), 100))]);
  expect(outcome).toBe('timed out');
 });
}
