import {describe,it,expect} from 'vitest';
import {parseDesktopRequest} from '../src/desktop-protocol.js';
describe('private desktop protocol',()=>{
 it.each([{id:'a',version:2,method:'site.list',params:{}},{id:'a',version:1,method:'shell.exec',params:{}},{id:'a',version:1,method:'site.list',params:{path:'C:/secret'}},{id:'a',version:1,method:'preview.open',params:{siteId:'x',revisionId:'../x'}},{id:'a',version:1,method:'catalog.style.update',params:{id:'light-product',enabled:'yes'}}])('rejects malformed or unauthorized request %j',request=>{expect(()=>parseDesktopRequest(request)).toThrow();});
 it('accepts a fixed list operation',()=>expect(parseDesktopRequest({id:'a',version:1,method:'site.list',params:{}}).method).toBe('site.list'));
});

it('enforces edit and publication request schemas without accepting role or artifact path overrides', () => {
 const siteId='11111111-1111-4111-8111-111111111111', candidateId='22222222-2222-4222-8222-222222222222';
 for(const [method,params] of [
  ['edit.request',{siteId,instruction:'Updated heading',expectedRevision:1,candidateId}],
  ['edit.accept',{siteId,candidateId,expectedRevision:1}],['edit.reject',{siteId,candidateId}],
  ['chat.list',{siteId}],['edit.list',{siteId}],['site.publish',{siteId,expectedRevision:2}],
  ['preview.screenshot',{siteId,revisionId:candidateId,candidateId,width:375}],
 ] as const) expect(parseDesktopRequest({id:'test',version:1,method,params}).method).toBe(method);
 for(const [method,params] of [
  ['edit.request',{siteId,instruction:'',expectedRevision:1}],
  ['edit.request',{siteId,instruction:'x',expectedRevision:-1}],
  ['edit.request',{siteId,instruction:'x',expectedRevision:1,role:'admin'}],
  ['edit.accept',{siteId,candidateId,expectedRevision:1.5}],
  ['edit.reject',{siteId,candidateId:'../private'}],
  ['site.publish',{siteId}],['chat.list',{siteId,path:'../private'}],
  ['preview.screenshot',{siteId,revisionId:candidateId,candidateId:'../private',width:375}],
 ] as const) expect(()=>parseDesktopRequest({id:'test',version:1,method,params})).toThrow();
});
import { parseModelConfiguration } from '../src/desktop-protocol.js';
it('private model configuration rejects absent, non-string and injected secrets',()=>{
 for(const apiKey of [undefined,null,123,{},'bad\nheader'])expect(()=>parseModelConfiguration({mode:'live',apiKey,model:'configured'})).toThrow();
 expect(()=>parseDesktopRequest({id:'x',version:1,method:'model.configure',params:{mode:'demo'}})).toThrow();
});
