import {test,expect} from 'vitest';
import {RemoteClient,sessionView} from '../src/lib/remote-client.js';
import {selectClient,desktopClient} from '../src/lib/desktop-client.js';
const id='11111111-1111-4111-8111-111111111111';
test('generation capability is explicit while publication remains unavailable',()=>{
 const session={principal:{userId:id,role:'admin'},mode:'managed',capabilities:{admin:true,edit:true,generation:true,publish:false,export:false,preview:true,nativeModelSettings:false}};
 expect(sessionView(session).capabilities.generation).toBe(true);
 expect(()=>sessionView({...session,capabilities:{...session.capabilities,publish:true}})).toThrow();
});
test('worker list validates heartbeat and last stage while rejecting credential fields',async()=>{
 let data:unknown=[{id,name:'Machine',paused:false,revoked:false,lastHeartbeat:1000,jobs:[{id,siteId:id,stage:'generate',state:'running'}]}];
 const client=new RemoteClient('https://control.test',async()=>'fixture',async()=>Response.json(data));
 expect(await client.request('worker.list')).toEqual(data);
 data=[{...(data as any[])[0],token:'private'}];await expect(client.request('worker.list')).rejects.toMatchObject({code:'INVALID_INPUT'});
});
test('remote DTO rejects private jobs and remote failure never invokes native fallback',async()=>{
 const site={id,domain:'test.example',ownerId:id,assignedUserIds:[],input:{domain:'test.example'},revision:0,draftId:null,publishedId:null,generationStatus:'queued',domainStatus:'unconfigured',job:{id,siteId:id,kind:'generate',stage:'brief',state:'queued',checkpointId:null,baseRevision:0,providerRecovery:{secret:'private'}}};
 const client=new RemoteClient('https://control.test',async()=>'fixture',async()=>Response.json({items:[site],nextCursor:null}));
 await expect(client.request('site.list')).rejects.toMatchObject({code:'INVALID_INPUT'});
 const offline=new RemoteClient('https://control.test',async()=>'fixture',async()=>{throw new Error('network');});selectClient(offline);
 await expect(desktopClient.request('site.list')).rejects.toMatchObject({code:'UNAVAILABLE'});
 await expect(desktopClient.modelSettings({action:'status'})).rejects.toMatchObject({code:'UNAVAILABLE'});selectClient('local');
});
test('remote uses current session token and validates server error envelopes',async()=>{
 let token='one';const seen:string[]=[];const client=new RemoteClient('https://control.test',async()=>token,async(_url,init)=>{seen.push(new Headers(init?.headers).get('authorization')!);return Response.json({items:[],nextCursor:null});});
 await client.request('site.list');token='two';await client.request('site.list');expect(seen).toEqual(['Bearer one','Bearer two']);
 const invalid=new RemoteClient('https://control.test',async()=>'fixture',async()=>Response.json({error:{code:'UNAVAILABLE',message:'safe',privateKey:'must reject'},requestId:'fixture'},{status:503}));await expect(invalid.request('site.list')).rejects.toMatchObject({code:'INVALID_INPUT'});
});
test('remote registry follows an explicit validated cursor without fetching other pages on its own',async()=>{
 const sites=Array.from({length:51},(_,i)=>({id:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,domain:`site-${i+1}.example`,ownerId:id,assignedUserIds:[],input:{domain:`site-${i+1}.example`},revision:0,draftId:null,publishedId:null,generationStatus:'queued',domainStatus:'unconfigured',job:null}));
 const cursor=sites[49]!.id,calls:string[]=[];
 const client=new RemoteClient('https://control.test',async()=>'fixture',async input=>{const url=String(input);calls.push(url);return Response.json(url.includes('?')?{items:sites.slice(50),nextCursor:null}:{items:sites.slice(0,50),nextCursor:cursor});});
 const first=await client.request<{items:typeof sites;nextCursor:string}>('site.list');expect(first.items).toHaveLength(50);expect(calls).toHaveLength(1);
 const second=await client.request<{items:typeof sites;nextCursor:null}>('site.list',{cursor:first.nextCursor});
 expect(second.items.map(s=>s.domain)).toEqual(['site-51.example']);expect(second.nextCursor).toBeNull();
 expect(calls).toEqual(['https://control.test/sites','https://control.test/sites?cursor='+cursor]);
 await expect(client.request('site.list',{cursor:'https://foreign.test/?token=bad'})).rejects.toMatchObject({code:'INVALID_INPUT'});expect(calls).toHaveLength(2);
});
