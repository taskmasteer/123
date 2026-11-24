import {createHash} from 'node:crypto';
/** Log stable metadata and local call sites, never provider bodies or credentials. */
export function logFailure(operation:string,error:unknown){
 const value=error as {name?:unknown;code?:unknown;stack?:unknown;status?:unknown};
 const safe=(v:unknown)=>typeof v==='string'&&/^[a-zA-Z0-9_]{1,64}$/.test(v)?v:'unknown';
 const stack=typeof value?.stack==='string'?value.stack:'';
 const frames=stack.split('\n').slice(1).map(line=>line.match(/(?:apps|packages|scripts)[/\\][a-zA-Z0-9_./\\:-]+:\d+:\d+/)?.[0]).filter(Boolean).slice(0,8);
 console.error(JSON.stringify({time:new Date().toISOString(),operation,name:safe(value?.name),code:safe(value?.code),fingerprint:createHash('sha256').update(stack).digest('hex').slice(0,16),frames,...(typeof value?.status==='number'&&value.status>=100&&value.status<=599?{status:value.status}:{})}));
}
