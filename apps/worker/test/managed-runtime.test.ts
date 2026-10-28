import { test, expect } from 'vitest';
import { createManagedRuntime } from '../src/managed-runtime.js';
import type { WorkerDeps } from '../src/pipeline.js';
test('explicit visual-only mode starts enrolled remote polling without model configuration and never asks for AI jobs',async()=>{
 const calls:{path:string;body:unknown}[]=[];const runtime=createManagedRuntime(()=>({} as WorkerDeps),()=>false,(async(url,init)=>{calls.push({path:new URL(String(url)).pathname,body:JSON.parse(String(init?.body))});return Response.json(String(url).endsWith('/claim')?null:{});}) as typeof fetch);
 const p=await runtime.request('managed.prepare',{}) as {workerId:string;token:string};await runtime.request('managed.start',{...p,controlOrigin:'https://control.test',mode:'visual'});await expect.poll(()=>calls.filter(c=>c.path.endsWith('/claim')).length).toBeGreaterThan(0);await runtime.stop();expect(calls.filter(c=>c.path.endsWith('/claim')).every(c=>JSON.stringify(c.body)==='{"mode":"visual"}')).toBe(true);
});
test('private enrollment generates an unpredictable token and sends only to configured HTTPS without redirects', async () => {
    const sent: RequestInit[] = [];
    const runtime = createManagedRuntime(() => ({} as WorkerDeps), () => false, (async (url, init) => {
        expect(String(url)).toBe('https://control.test/workers/enroll');
        sent.push(init!);
        const body = JSON.parse(String(init?.body));
        return Response.json({ workerId: body.workerId, name: body.name });
    }) as typeof fetch);
    const a = await runtime.request('managed.prepare', {}) as any, b = await runtime.request('managed.prepare', {}) as any;
    expect(Buffer.from(a.token, 'base64url')).toHaveLength(32);
    expect(a.token).not.toBe(b.token);
    const result = await runtime.request('managed.enroll', { ...a, name: 'Machine', controlOrigin: 'https://control.test', accessToken: 'transient-admin' });
    expect(JSON.stringify(result)).not.toContain(a.token);
    expect(sent[0]!.redirect).toBe('error');
    expect(sent[0]!.headers).toMatchObject({ authorization: 'Bearer transient-admin' });
    await expect(runtime.request('managed.enroll', { ...a, name: 'Machine', controlOrigin: 'http://control.test', accessToken: 'transient-admin' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(runtime.request('managed.start', { ...a, controlOrigin: 'https://control.test' })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await runtime.stop();
});
