import {describe,it,expect} from 'vitest';
import {parseDesktopRequest} from '../src/desktop-protocol.js';
describe('private desktop protocol',()=>{
 it.each([{id:'a',version:2,method:'site.list',params:{}},{id:'a',version:1,method:'shell.exec',params:{}},{id:'a',version:1,method:'site.list',params:{path:'C:/secret'}},{id:'a',version:1,method:'preview.open',params:{siteId:'x',revisionId:'../x'}},{id:'a',version:1,method:'catalog.style.update',params:{id:'light-product',enabled:'yes'}}])('rejects malformed or unauthorized request %j',request=>{expect(()=>parseDesktopRequest(request)).toThrow();});
 it('accepts a fixed list operation',()=>expect(parseDesktopRequest({id:'a',version:1,method:'site.list',params:{}}).method).toBe('site.list'));
});
