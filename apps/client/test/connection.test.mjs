import {test} from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import {createConnection} from '../connection.mjs';
const config={endpoint:'https://control.example:9443',certificate:'fixture',fingerprint:'fixture'};
test('catalog PATCH is allowed, unrelated methods/routes stay blocked and cookies stay private',async t=>{
 const calls=[];
 t.mock.method(https,'request',(options,callback)=>{
  const req=new EventEmitter();req.setTimeout=()=>req;req.write=()=>{};req.end=()=>{calls.push(options);queueMicrotask(()=>{const res=new EventEmitter();res.headers={'set-cookie':['__Host-factory=fixture-session; Secure; HttpOnly']};res.statusCode=200;callback(res);res.emit('data',Buffer.from('{}'));res.emit('end');});};return req;
 });
 const connection=createConnection(config);
 try{
  await connection.request('/auth/login','POST',{login:'fixture'});
  await connection.request('/api/catalog/styles/editorial','PATCH',{enabled:false},4096,'csrf-value');
  await connection.request('/api/catalog/references/corporate','PATCH',{description:'updated'});
  assert.equal(calls[1].headers.cookie,'__Host-factory=fixture-session');assert.equal(calls[1].headers['x-csrf-token'],'csrf-value');
  for(const [path,method] of [['/api/accounts/status','PATCH'],['/api/catalog/styles/id','DELETE'],['https://other.example/api/catalog/styles/id','PATCH'],['/api/catalog/styles/id/extra','PATCH']])await assert.rejects(connection.request(path,method,{}));
  assert.equal(calls.length,3);
 }finally{connection.clear();}
});
test('a late response cannot restore credentials after local logout',async t=>{
 const callbacks=[],requests=[];
 t.mock.method(https,'request',(options,callback)=>{requests.push(options);callbacks.push(callback);const req=new EventEmitter();req.setTimeout=()=>req;req.end=()=>{};return req;});
 const finish=(index,cookie)=>{const res=new EventEmitter();res.statusCode=200;res.headers=cookie?{'set-cookie':['__Host-factory='+cookie]}:{};callbacks[index](res);res.emit('data',Buffer.from('{}'));res.emit('end');};
 const connection=createConnection(config);
 try{
  const old=connection.request('/auth/status');connection.clear();finish(0,'late-session');await old;
  const next=connection.request('/auth/status');assert.equal(requests[1].headers.cookie,undefined);finish(1);await next;
 }finally{connection.clear();}
});
