import { test, expect, vi } from 'vitest';
import { RemoteClient, sessionView } from '../src/lib/remote-client.js';
import { selectClient, desktopClient } from '../src/lib/desktop-client.js';
const id = '11111111-1111-4111-8111-111111111111';

test('disposal closes native archive IDs with the captured original client before clearing Auth',async()=>{
    let token='one',disposed=false,release!:()=>void;const close=new Promise<void>(r=>release=r),requests:any[]=[];
    vi.stubGlobal('isTauri',true);vi.stubGlobal('window',{__TAURI_INTERNALS__:{invoke:async(command:string,args:any)=>{expect(command).toBe('archive_operation');requests.push(args.request);if(args.request.action==='close')await close;return args.request.action==='close'?{ok:true}:{id,state:'working'};}}});
    try{
        const client=new RemoteClient('https://original.test',async()=>token,fetch,()=>{disposed=true;});
        await client.archive({action:'backup',passphrase:'private password'});token='two';await client.archive({action:'status',id});client.dispose();await new Promise(setImmediate);
        expect(disposed).toBe(false);expect(requests.at(-1)).toEqual({action:'close',id,remote:{origin:'https://original.test',accessToken:'two'}});
        await expect(client.archive({action:'status',id})).rejects.toMatchObject({code:'UNAUTHENTICATED'});release();await new Promise(setImmediate);expect(disposed).toBe(true);
    }finally{release();vi.unstubAllGlobals();}
});
test('remote evidence accepts the worker validation PNG identity but rejects traversal and encoded screenshot paths',async()=>{
 const candidate={id,siteId:id,jobId:id,baseRevision:0,baseDraftId:id,baseManifestId:id,parentRevisionId:id,manifestId:id,status:'ready',validation:{ok:true,issues:[],screenshotIds:[`validation/${id}.png`]},summary:'Checked',createdAt:1,acceptance:null,instruction:'Visual edit',job:{id,siteId:id,kind:'edit',stage:'completed',state:'completed',checkpointId:id,baseRevision:0}};
 let value:unknown={candidates:[candidate],publication:null};const client=new RemoteClient('https://control.test',async()=> 'fixture',async()=>Response.json(value));
 expect((await client.request<any>('edit.list',{siteId:id})).candidates[0].validation.screenshotIds).toEqual([`validation/${id}.png`]);
 for(const path of [`validation/../${id}.png`,`validation/%2f${id}.png`,`validation/${id}.png?token=x`,`other/${id}.png`]){value={candidates:[{...candidate,validation:{...candidate.validation,screenshotIds:[path]}}],publication:null};await expect(client.request('edit.list',{siteId:id})).rejects.toMatchObject({code:'INVALID_INPUT'});}
});
test('native lifecycle actions carry the configured origin before dispatching any credential', async () => {
    const requests: unknown[] = [];
    vi.stubGlobal('isTauri', true);
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke: async (command: string, args: unknown) => {
                expect(command).toBe('managed_worker');
                requests.push(args);
                return { workerId: id, name: 'Machine', origin: 'https://installation-b.test', enrolled: true, running: false, error: null };
            } } });
    try {
        const client = new RemoteClient('https://installation-b.test', async () => 'installation-b-admin');
        for (const method of ['worker.start', 'worker.stop', 'worker.remove'])
            await client.request(method);
        expect(requests).toEqual([
            { request: { action: 'start', expectedOrigin: 'https://installation-b.test' } },
            { request: { action: 'stop', expectedOrigin: 'https://installation-b.test' } },
            { request: { action: 'revoke', expectedOrigin: 'https://installation-b.test', accessToken: 'installation-b-admin' } }
        ]);
    }
    finally {
        vi.unstubAllGlobals();
    }
});
test('publication capability follows configured server while export remains unavailable', () => {
    const session = { principal: { userId: id, role: 'admin' }, mode: 'managed', capabilities: { admin: true, edit: true, generation: true, publish: false, export: false, preview: true, nativeModelSettings: false } };
    expect(sessionView(session).capabilities.generation).toBe(true);
    expect(sessionView({ ...session, capabilities: { ...session.capabilities, publish: true } }).capabilities.publish).toBe(true);
    expect(() => sessionView({ ...session, capabilities: { ...session.capabilities, export: true } })).toThrow();
});
test('publication client routes IDs only and rejects provider-private status fields', async () => {
    let value: unknown = { publication: null, domain: { records: [{ type: 'CNAME', name: 'test.example', value: 'target.vercel-dns.com' }], verified: false } };
    const calls: {
        url: string;
        body: unknown;
    }[] = [];
    const client = new RemoteClient('https://control.test', async () => 'fixture', async (input, init) => { calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null }); return Response.json(value); });
    expect(await client.request('publication.status', { siteId: id })).toEqual(value);
    value = { id, siteId: id, revisionId: id, manifestId: id, manifestHash: 'a'.repeat(64), deploymentId: null, phase: 'pending', retryAt: null, cancelRequested: false, settlement: 'pending', verifiedAt: null, origin: 'draft' };
    await client.request('publication.request', { siteId: id, revisionId: id, expectedRevision: 1, requestKey: id });
    expect(calls[1]).toEqual({ url: `https://control.test/sites/${id}/publication`, body: { revisionId: id, expectedRevision: 1, requestKey: id } });
    value = { ...(value as object), token: 'provider-private' };
    await expect(client.request('publication.resume', { siteId: id, id })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});
test('worker list validates heartbeat and last stage while rejecting credential fields', async () => {
    let data: unknown = [{ id, name: 'Machine', paused: false, revoked: false, lastHeartbeat: 1000, jobs: [{ id, siteId: id, stage: 'generate', state: 'running' }] }];
    const client = new RemoteClient('https://control.test', async () => 'fixture', async () => Response.json(data));
    expect(await client.request('worker.list')).toEqual(data);
    data = [{ ...(data as any[])[0], token: 'private' }];
    await expect(client.request('worker.list')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});
test('remote DTO rejects private jobs and remote failure never invokes native fallback', async () => {
    const site = { id, domain: 'test.example', ownerId: id, assignedUserIds: [], input: { domain: 'test.example' }, revision: 0, draftId: null, publishedId: null, generationStatus: 'queued', domainStatus: 'unconfigured', job: { id, siteId: id, kind: 'generate', stage: 'brief', state: 'queued', checkpointId: null, baseRevision: 0, providerRecovery: { secret: 'private' } } };
    const client = new RemoteClient('https://control.test', async () => 'fixture', async () => Response.json({ items: [site], nextCursor: null }));
    await expect(client.request('site.list')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const offline = new RemoteClient('https://control.test', async () => 'fixture', async () => { throw new Error('network'); });
    selectClient(offline);
    await expect(desktopClient.request('site.list')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(desktopClient.modelSettings({ action: 'status' })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    selectClient('local');
});
test('remote uses current session token and validates server error envelopes', async () => {
    let token = 'one';
    const seen: string[] = [];
    const client = new RemoteClient('https://control.test', async () => token, async (_url, init) => { seen.push(new Headers(init?.headers).get('authorization')!); return Response.json({ items: [], nextCursor: null }); });
    await client.request('site.list');
    token = 'two';
    await client.request('site.list');
    expect(seen).toEqual(['Bearer one', 'Bearer two']);
    const invalid = new RemoteClient('https://control.test', async () => 'fixture', async () => Response.json({ error: { code: 'UNAVAILABLE', message: 'safe', privateKey: 'must reject' }, requestId: 'fixture' }, { status: 503 }));
    await expect(invalid.request('site.list')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});
test('remote registry follows an explicit validated cursor without fetching other pages on its own', async () => {
    const sites = Array.from({ length: 51 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, domain: `site-${i + 1}.example`, ownerId: id, assignedUserIds: [], input: { domain: `site-${i + 1}.example` }, revision: 0, draftId: null, publishedId: null, generationStatus: 'queued', domainStatus: 'unconfigured', job: null }));
    const cursor = sites[49]!.id, calls: string[] = [];
    const client = new RemoteClient('https://control.test', async () => 'fixture', async (input) => { const url = String(input); calls.push(url); return Response.json(url.includes('?') ? { items: sites.slice(50), nextCursor: null } : { items: sites.slice(0, 50), nextCursor: cursor }); });
    const first = await client.request<{
        items: typeof sites;
        nextCursor: string;
    }>('site.list');
    expect(first.items).toHaveLength(50);
    expect(calls).toHaveLength(1);
    const second = await client.request<{
        items: typeof sites;
        nextCursor: null;
    }>('site.list', { cursor: first.nextCursor });
    expect(second.items.map(s => s.domain)).toEqual(['site-51.example']);
    expect(second.nextCursor).toBeNull();
    expect(calls).toEqual(['https://control.test/sites', 'https://control.test/sites?cursor=' + cursor]);
    await expect(client.request('site.list', { cursor: 'https://foreign.test/?token=bad' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(calls).toHaveLength(2);
});
test('staged import commands stay on the configured API and reject private response fields', async () => {
    const calls: {
        url: string;
        body: any;
    }[] = [];
    let result: unknown = { id };
    const client = new RemoteClient('https://control.test', async () => 'fixture', async (input, init) => { calls.push({ url: String(input), body: JSON.parse(String(init!.body)) }); return Response.json(result); });
    await client.request('resource.begin', { name: 'sites.csv', size: 1, sha256: 'a'.repeat(64) });
    result = { ok: true };
    await client.request('resource.chunk', { id, index: 0, base64: 'YQ==' });
    expect(calls.every(c => c.url === 'https://control.test/batches/commands')).toBe(true);
    expect(calls.every(c => Buffer.byteLength(JSON.stringify(c.body)) < 64000)).toBe(true);
    result = { id, privateKey: 'never expose' };
    await expect(client.request('resource.begin', { name: 'sites.csv', size: 1, sha256: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(client.request('resource.chunk', { id, index: 0, base64: 'A'.repeat(33000) })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});

test('disposal denies an archive start whose credential read was already pending',async()=>{
 let release!:(token:string)=>void;const token=new Promise<string>(r=>release=r),calls:any[]=[];vi.stubGlobal('isTauri',true);vi.stubGlobal('window',{__TAURI_INTERNALS__:{invoke:async(_command:string,args:any)=>{calls.push(args);return {id,state:'working'};}}});
 try{const client=new RemoteClient('https://control.test',()=>token);const pending=client.archive({action:'backup',passphrase:'private password'});client.dispose();release('fixture');await expect(pending).rejects.toMatchObject({code:'UNAUTHENTICATED'});expect(calls).toEqual([]);}finally{vi.unstubAllGlobals();}
});
