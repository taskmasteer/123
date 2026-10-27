import {test,expect} from 'vitest';
import {RemoteClient} from '../src/lib/remote-client.js';
import {selectClient,desktopClient} from '../src/lib/desktop-client.js';
const id='11111111-1111-4111-8111-111111111111';
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
