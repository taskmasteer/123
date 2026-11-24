import { test,expect } from 'vitest';
import { createDeepSeekModel } from '../src/deepseek.js';
import { compactReadHistory, executeCall, validateContinuation } from '../src/openai/tool-loop.js';
import {AppError} from '../../contracts/src/model.js';
import type { ModelRequest,ModelContinuation } from '../../contracts/src/model.js';
import { assertAllowedHost,mentionedUrl } from '../../contracts/src/domain-policy.js';

test('an unavailable DeepSeek tool receives a bounded error without touching files and resumes from its checkpoint',async()=>{
 let sent=false,saved:ModelContinuation|undefined;
 const model=createDeepSeekModel('fixture',async(_url,init)=>{
   if(!sent){sent=true;return Response.json({status:'completed',output:[{type:'function_call',call_id:'edit-1',name:'edit_file',arguments:'{}'}]});}
   const body=JSON.parse(String(init?.body));
   expect(body.input.find((i:{call_id?:string;type:string})=>i.call_id==='edit-1'&&i.type==='function_call_output').output).toContain('Available tools: list, read, write, replace');
   return Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Recovered.'}]}]});
 });
 const forbidden=async():Promise<never>=>{throw Error('Unexpected file operation');};
 const tools={list:forbidden,read:forbidden,write:forbidden,replace:forbidden},signal=new AbortController().signal;
 await expect(model.run(request,tools,signal,{checkpoint:async state=>{
   if(!saved&&state.items.some(i=>i.type==='function_call')){saved=structuredClone(state);throw Error('Restart fixture');}
 }})).rejects.toThrow('Restart fixture');
 expect((await model.run({...request,continuation:saved!},tools,signal)).summary).toBe('Recovered.');
 const state=structuredClone(saved!);
 const invalid={type:'function_call',name:'edit_file',arguments:'{}',call_id:'fixture'};
 for(let n=0;n<3;n++)await executeCall(invalid,tools,state,signal);
 await expect(executeCall(invalid,tools,state,signal)).rejects.toThrow('repeatedly requested');
});
const request:ModelRequest={mode:'generate',baseManifestId:null,conversation:[],site:{id:'site',domain:'example.test',ownerId:'owner',assignedUserIds:[],input:{domain:'example.test',mentionedUrl:'https://example.com/a'},revision:0,draftId:null,publishedId:null,generationStatus:'queued',domainStatus:'unconfigured'},instruction:'Create a page',styleId:'corporate'};
test('DeepSeek uses fixed endpoint, ordered tools and provider-bound durable replay',async()=>{
  let calls=0;const seen:string[]=[],checkpoints:ModelContinuation[]=[];
  const model=createDeepSeekModel('test-key-never-output',async(url,init)=>{
    expect(String(url)).toBe('https://api.deepseek.com/responses');expect(init?.redirect).toBe('error');const body=JSON.parse(String(init?.body));expect(body.model).toBe('deepseek-flash');expect(body.input[0].content).toContain('https://example.com/a');calls++;
    return Response.json({id:'response-'+calls,status:'completed',usage:{input_tokens:1,output_tokens:2},output:calls===1?[{type:'function_call',name:'write',call_id:'a',arguments:JSON.stringify({path:'index.html',text:'A'})},{type:'function_call',name:'replace',call_id:'b',arguments:JSON.stringify({path:'index.html',oldText:'A',newText:'B'})}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Finished.'}]}]});
  });let text='';const tools={list:async()=>['index.html'],read:async()=>text,write:async(_p:string,v:string)=>{seen.push('write');text=v;},replace:async(_p:string,a:string,b:string)=>{seen.push('replace');text=text.replace(a,b);}};
  const result=await model.run(request,tools,new AbortController().signal,{checkpoint:async c=>{checkpoints.push(c);}});expect(seen).toEqual(['write','replace']);expect(text).toBe('B');expect(result.continuation?.provider).toBe('deepseek-responses');expect(JSON.stringify(checkpoints)).not.toContain('test-key-never-output');
  const final=result.continuation!;expect(()=>validateContinuation(final,final.binding)).toThrow();
  await expect(model.run({...request,site:{...request.site,input:{...request.site.input,mentionedUrl:'https://example.com/b'}},continuation:final},tools,new AbortController().signal)).rejects.toThrow();
});
test('domain policy matches exact names and subdomains before network access',()=>{
  expect(()=>assertAllowedHost('sub.blocked.example',['blocked.example'])).toThrow();expect(()=>assertAllowedHost('blocked.example.',['blocked.example'])).toThrow();expect(()=>assertAllowedHost('notblocked.example',['blocked.example'])).not.toThrow();
  for(const value of ['http://127.0.0.1/','https://user:pass@example.com','javascript:alert(1)','https://example.local/'])expect(()=>mentionedUrl(value)).toThrow();
});

test('mismatched replacement can be corrected while unsafe path errors remain fatal',async()=>{
 const state={seen:{}} as ModelContinuation,signal=new AbortController().signal;
 const call={type:'function_call',name:'replace',call_id:'replace1',arguments:JSON.stringify({path:'index.html',oldText:'missing',newText:'new'})};
 const tools={list:async()=>['index.html'],read:async()=>'<h1>Original</h1>',write:async()=>{},replace:async()=>{throw new AppError('INVALID_INPUT','Replacement must match exactly once.');}};
 const result=await executeCall(call,tools,state,signal);expect(JSON.parse(result.output)).toMatchObject({ok:false});expect(result.output).toContain('No changes were made');
 tools.replace=async()=>{throw new AppError('INVALID_INPUT','Unsafe path.');};
 await expect(executeCall({...call,call_id:'replace2'},tools,state,signal)).rejects.toThrow('Unsafe path.');
});

test('rejected helper file is reported to the model and a saved failed call can resume',async()=>{
 let turn=0,saved:ModelContinuation|undefined,legacy=true,html='';
 const model=createDeepSeekModel('fixture-key',async()=>Response.json({id:'helper-'+(++turn),status:'completed',output:turn===1?[{type:'function_call',name:'write',call_id:'helper',arguments:JSON.stringify({path:'check.py',text:'print(1)'})}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Finished.'}]}]}));
 const tools={list:async()=>['index.html'],read:async()=>html,write:async(path:string,text:string)=>{if(path==='check.py')throw new AppError('INVALID_INPUT',legacy?'Legacy interruption':'Only static site files are allowed.');html=text;},replace:async()=>{}};
 await expect(model.run(request,tools,new AbortController().signal,{checkpoint:async c=>{saved=c;}})).rejects.toThrow('Legacy interruption');
 expect(model.canRecover?.(saved,'Only static site files are allowed.')).toBe(true);
 expect(model.canRecover?.(saved,'Unsafe artifact path.')).toBe(false);
 const resumed=model.recover!(request,saved!,{previousIdentity:model.identity!,operationId:'recovered-helper',diagnostic:'Only static site files are allowed.'});
 legacy=false;const result=await model.run({...request,operationId:'recovered-helper',continuation:resumed},tools,new AbortController().signal);
 expect(result.continuation?.items.filter(i=>i.type==='function_call_output').map(i=>i.output).join()).toContain('File rejected');
 expect(html).toBe('');
});

test.each(['read','replace'] as const)('an interrupted %s of an invented filename resumes and corrects the path',async(name)=>{
 let turn=0,html='original',saved:ModelContinuation|undefined;
 const args=name==='read'?{path:'B'}:{path:'B',oldText:'original',newText:'wrong'};
 const model=createDeepSeekModel('fixture-key',async(_url,init)=>{
   const input=JSON.parse(String(init?.body)).input;
   if(++turn===2)expect(JSON.parse(input.at(-1).output)).toMatchObject({ok:false,paths:['index.html']});
   return Response.json({status:'completed',output:turn===1?[{type:'function_call',name,call_id:'bad',arguments:JSON.stringify(args)}]:turn===2?[{type:'function_call',name:'replace',call_id:'fix',arguments:JSON.stringify({path:'index.html',oldText:'original',newText:'corrected'})}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Done'}]}]});
 });
 let interrupted=true;
 function check(path:string){if(path==='B')throw new AppError('INVALID_INPUT',interrupted?'Legacy interruption':'Only static site files are allowed.');}
 const tools={list:async()=>['index.html'],read:async(path:string)=>{check(path);return html;},replace:async(path:string,_a:string,b:string)=>{check(path);html=b;},write:async()=>{throw Error('unexpected write');}};
 await expect(model.run(request,tools,new AbortController().signal,{checkpoint:async c=>{saved=structuredClone(c);}})).rejects.toThrow('Legacy interruption');
 interrupted=false;
 const operationId='resumed-filename',diagnostic='Only static site files are allowed.';
 const continuation=model.recover!(request,saved!,{previousIdentity:model.identity!,operationId,diagnostic});
 await model.run({...request,operationId,continuation},tools,new AbortController().signal);
 expect(html).toBe('corrected');expect(turn).toBe(3);
});

test('editing budget hands saved output to validation and recovers legacy exhausted jobs',async()=>{
 let turn=0,saved:ModelContinuation|undefined;
 const model=createDeepSeekModel('fixture-key',async()=>Response.json({id:'budget-'+(++turn),status:'completed',output:[{type:'function_call',name:'write',call_id:'write-'+turn,arguments:JSON.stringify({path:'index.html',text:'<h1>Page '+turn+'</h1>'})}]}));
 let html='';const tools={list:async()=>['index.html'],read:async()=>html,write:async(_path:string,text:string)=>{html=text;},replace:async()=>{}};
 const result=await model.run(request,tools,new AbortController().signal,{checkpoint:async c=>{saved=structuredClone(c);}});
 expect(turn).toBe(48);expect(html).toContain('Page 48');expect(result.summary).toContain('require validation');
 const legacy={...saved!,terminal:'stalled' as const};expect(model.canRecover!(legacy,'Model response stalled.')).toBe(true);
 expect(model.canRecover!({...legacy,turns:4},'Model response stalled.')).toBe(false);
 const continuation=model.recover!(request,legacy,{previousIdentity:model.identity!,operationId:'budget-recovery',diagnostic:'Model response stalled.'});
 const recovered=await model.run({...request,operationId:'budget-recovery',continuation},tools,new AbortController().signal);
 expect(recovered.continuation?.terminal).toBe('final');expect(turn).toBe(48);
});

test('missing path returns tool feedback without mutation, then corrected call succeeds',async()=>{
 let turn=0,html='unchanged';const model=createDeepSeekModel('fixture-key',async(_url,init)=>{const body=JSON.parse(String(init?.body));turn++;if(turn===2)expect(body.input.at(-1).output).toContain('path');return Response.json({status:'completed',output:turn===1?[{type:'function_call',name:'replace',call_id:'bad-path',arguments:JSON.stringify({oldText:'unchanged',newText:'fixed'})}]:turn===2?[{type:'function_call',name:'replace',call_id:'fixed-path',arguments:JSON.stringify({path:'index.html',oldText:'unchanged',newText:'fixed'})}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Done'}]}]});});
 const tools={list:async()=>['index.html'],read:async()=>html,write:async()=>{throw Error('Unexpected write');},replace:async(path:string,_a:string,b:string)=>{expect(path).toBe('index.html');html=b;}};
 await model.run(request,tools,new AbortController().signal);expect(html).toBe('fixed');expect(turn).toBe(3);
});
test('truncated output is discarded, recovery survives restart and never executes partial calls',async()=>{
 let turn=0,html='original',saved:ModelContinuation|undefined;const model=createDeepSeekModel('fixture-key',async(_url,init)=>{turn++;const body=JSON.parse(String(init?.body));if(turn>1){expect(JSON.stringify(body.input)).not.toContain('partial-call');expect(JSON.stringify(body.input)).toContain('small replace');}return Response.json(turn===1?{status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[{type:'function_call',name:'write',call_id:'partial-call',status:'incomplete',arguments:'{"path":"index.html","text":"cut'}]}:{status:'completed',output:turn===2?[{type:'function_call',name:'replace',call_id:'small-call',arguments:JSON.stringify({path:'index.html',oldText:'original',newText:'finished'})}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Done'}]}]});});
 const tools={list:async()=>['index.html'],read:async()=>html,write:async()=>{throw Error('Partial output must not write');},replace:async(_p:string,_a:string,b:string)=>{html=b;}};
 await expect(model.run(request,tools,new AbortController().signal,{checkpoint:async c=>{saved=structuredClone(c);if(c.outputRepairs===1)throw Error('simulated shutdown');}})).rejects.toThrow('simulated shutdown');expect(html).toBe('original');expect(saved?.outputRepairs).toBe(1);
 await model.run({...request,continuation:saved!},tools,new AbortController().signal);expect(html).toBe('finished');expect(turn).toBe(3);
});
test('truncation retries are bounded and refusals are not recovered',async()=>{
 let calls=0;const tools={list:async()=>[],read:async()=>'',write:async()=>{throw Error('must not mutate');},replace:async()=>{throw Error('must not mutate');}};
 const model=createDeepSeekModel('fixture-key',async()=>{calls++;return Response.json({status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[]});});
 await expect(model.run(request,tools,new AbortController().signal)).rejects.toThrow('Model response incomplete.');expect(calls).toBe(4);
 const refused=createDeepSeekModel('fixture-key',async()=>Response.json({status:'incomplete',incomplete_details:{reason:'content_filter'},output:[]}));await expect(refused.run(request,tools,new AbortController().signal)).rejects.toThrow('Model response incomplete.');
});

test('large repeated reads compact without losing latest files or replay identities',()=>{
 const state={items:[],seen:{}} as unknown as ModelContinuation;
 for(let i=0;i<5;i++){state.items.push({type:'function_call',name:'read',call_id:'r'+i,arguments:JSON.stringify({path:'index.html'})},{type:'function_call_output',call_id:'r'+i,output:'x'.repeat(200000)+i});}
 state.items.push({type:'function_call',name:'replace',call_id:'pending',arguments:JSON.stringify({path:'index.html',oldText:'old',newText:'new'})});
 compactReadHistory(state);expect(JSON.stringify(state).length).toBeLessThan(250000);expect(state.items).toHaveLength(11);expect(state.items[9]!.output).toBe('x'.repeat(200000)+'4');expect(state.items.at(-1)!.call_id).toBe('pending');expect(state.items[1]!.output).toContain('archived');
});

test('compacted replay resumes without repeating completed file replacements',async()=>{
 let turn=0,replacements=0,html='A'+'x'.repeat(200000),saved:ModelContinuation|undefined;
 const model=createDeepSeekModel('fixture-key',async()=>{turn++;const output=turn===8?[{type:'message',role:'assistant',content:[{type:'output_text',text:'Done'}]}]:[{type:'function_call',name:turn%2?'read':'replace',call_id:'large-'+turn,arguments:JSON.stringify(turn%2?{path:'index.html'}:{path:'index.html',oldText:String.fromCharCode(64+turn/2),newText:String.fromCharCode(65+turn/2)})}];return Response.json({status:'completed',output});});
 const tools={list:async()=>['index.html'],read:async()=>html,write:async()=>{},replace:async(_p:string,a:string,b:string)=>{expect(html.startsWith(a)).toBe(true);html=html.replace(a,b);replacements++;}};
 await expect(model.run(request,tools,new AbortController().signal,{checkpoint:async c=>{saved=structuredClone(c);if(c.items.some(i=>typeof i.output==='string'&&i.output.includes('Older read snapshot omitted')))throw Error('restart after compaction');}})).rejects.toThrow('restart after compaction');
 expect(saved!.items.some(i=>typeof i.output==='string'&&i.output.includes('Older read snapshot omitted'))).toBe(true);
 await model.run({...request,continuation:saved!},tools,new AbortController().signal);expect(replacements).toBe(3);expect(html.startsWith('D')).toBe(true);
});


test('persisted transport exhaustion waits, resumes after cooldown and has a finite retry budget',async()=>{
 const {createResponsesModel}=await import('../src/openai/responses.js');let now=100000,saved:ModelContinuation|undefined,calls=0;
 const model=createResponsesModel({apiKey:'fixture-key',model:'deepseek-flash',provider:'deepseek'},async()=>{calls++;return new Response('',{status:503});},{now:()=>now,delay:async ms=>{now+=ms;}});
 const tools={list:async()=>[],read:async()=>'',write:async()=>{},replace:async()=>{}},signal=new AbortController().signal,hooks={checkpoint:async(c:ModelContinuation)=>{saved=c;}};
 await expect(model.run(request,tools,signal,hooks)).rejects.toMatchObject({code:'PROVIDER_WAIT'});expect(saved?.transportExhausted).toBe(true);const firstCalls=calls;
 await expect(model.run({...request,continuation:saved!},tools,signal,hooks)).rejects.toMatchObject({code:'PROVIDER_WAIT'});expect(calls).toBe(firstCalls);
 for(let round=1;round<=3;round++){now=saved!.retryAt;await expect(model.run({...request,continuation:saved!},tools,signal,hooks)).rejects.toMatchObject({code:'PROVIDER_WAIT'});expect(saved!.retryCycles).toBe(round);}
 now=saved!.retryAt;const finalCalls=calls;await expect(model.run({...request,continuation:saved!},tools,signal,hooks)).rejects.toMatchObject({code:'NEEDS_ATTENTION'});expect(calls).toBe(finalCalls);
});
