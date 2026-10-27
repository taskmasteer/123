import {expect,test} from 'vitest';
import {SupabaseInvitationProvider,configuredInvitations,type InvitationLedger,type InvitationAttempt} from '../src/invitations.js';
const actor={userId:'33333333-3333-4333-8333-333333333333',role:'admin' as const};
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',operation='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',email='invite@example.test';
const user={id,email,aud:'authenticated',invited_at:'2026-10-27T00:00:00Z'};
function ledger(){let value:InvitationAttempt|null=null;return {read:async()=>value,claim:async(_e,_o,_a,bound)=>{if(value)return false;value=bound??{userId:null,evidence:null};return true;},bind:async(_e,_o,_a,userId,evidence)=>{value={userId,evidence};}} satisfies InvitationLedger;}
function provider(store:InvitationLedger,fetcher:typeof fetch){return new SupabaseInvitationProvider({url:'https://auth.example',serviceRoleKey:'fixture-service-key'},store,fetcher);}
test('sends the official invite contract once, then reconciles its durable identity with Admin GET',async()=>{
 const store=ledger(),calls:string[]=[];let failGet=true;
 const p=provider(store,async(input,init)=>{const url=new URL(String(input));calls.push(init!.method+' '+url.pathname);expect(init!.redirect).toBe('error');expect(new Headers(init!.headers).get('authorization')).toBe('Bearer fixture-service-key');
  if(url.pathname.endsWith('/invite')){expect(JSON.parse(String(init!.body))).toEqual({email});expect(new Headers(init!.headers).has('idempotency-key')).toBe(false);return Response.json(user);}
  if(url.pathname.endsWith('/admin/users')){expect(url.searchParams.get('per_page')).toBe('100');expect(url.searchParams.has('email')).toBe(false);return Response.json({users:[]});}
  if(failGet){failGet=false;return Response.json({error:'private provider detail'},{status:503});}return Response.json(user);
 });
 await expect(p.ensureInvited(email,operation,actor)).rejects.toMatchObject({code:'UNAVAILABLE'});
 expect(await p.ensureInvited(email,operation,actor)).toEqual({verifiedUserId:id});
 expect(calls.filter(c=>c.startsWith('POST'))).toHaveLength(1);
});
test('lost invite response cannot be retried by sending mail or trusting user metadata',async()=>{
 const store=ledger();let posts=0,gets=0;
 const p=provider(store,async(_input,init)=>{if(init!.method==='POST'){posts++;throw new Error('socket lost with secret');}gets++;return Response.json({users:[]});});
 for(let i=0;i<2;i++)await expect(p.ensureInvited(email,operation,actor)).rejects.toMatchObject({code:'NEEDS_ATTENTION'});
 expect(posts).toBe(1);expect(gets).toBe(2);
});
test('paginates all users and binds a freshly verified existing confirmed identity without sending',async()=>{
 const pages:number[]=[];
 const p=provider(ledger(),async(input,init)=>{expect(init!.method).toBe('GET');const url=new URL(String(input));if(url.pathname.endsWith('/'+id))return Response.json({...user,email_confirmed_at:'2026-10-26T00:00:00Z'});const page=Number(url.searchParams.get('page'));pages.push(page);return Response.json({users:page===1?Array.from({length:100},(_,i)=>({email:`other${i}@example.test`})):page===2?[{...user,email_confirmed_at:'2026-10-26T00:00:00Z'}]:[]});});
 expect(await p.ensureInvited(email,operation,actor)).toEqual({verifiedUserId:id});expect(pages).toEqual([1,2]);
});
test.each(['unconfirmed','mismatch','spoof','provider-error','duplicate'])('fails closed for %s identity evidence',async(kind)=>{
 let posts=0;
 const p=provider(ledger(),async(input,init)=>{if(init!.method==='POST'){posts++;return kind==='provider-error'?Response.json(user,{status:500}):Response.json({...user,email:'wrong@example.test'});}
  if(String(input).includes('/admin/users/'+id))return Response.json({...user,email:'wrong@example.test',email_confirmed_at:'2026-10-26T00:00:00Z'});
  const candidate={...user,...(kind==='mismatch'?{email_confirmed_at:'2026-10-26T00:00:00Z'}:{}),user_metadata:{operationId:operation,email_confirmed_at:'2026-10-26T00:00:00Z'}};
  return Response.json({users:kind==='provider-error'||kind==='spoof'?[]:kind==='duplicate'?[candidate,candidate]:[candidate]});
 });
 await expect(p.ensureInvited(email,operation,actor)).rejects.toMatchObject({code:'NEEDS_ATTENTION'});
 expect(posts).toBe(kind==='provider-error'||kind==='spoof'?1:0);
});
test('configuration is opt-in and rejects non-HTTPS/credential-bearing auth origins',()=>{
 expect(configuredInvitations({} as never,{})).toBeUndefined();
 for(const url of ['http://auth.example','https://user:pass@auth.example','https://auth.example/path'])expect(()=>providerConfig(url)).toThrow();
 function providerConfig(url:string){return new SupabaseInvitationProvider({url,serviceRoleKey:'fixture'},ledger());}
});
