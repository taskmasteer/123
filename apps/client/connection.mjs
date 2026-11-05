import https from 'node:https';
import {networkInterfaces} from 'node:os';
import {checkServerIdentity} from 'node:tls';
import {X509Certificate} from 'node:crypto';
import {isIP} from 'node:net';

export function validateConnection(value){
 if(!value||typeof value.endpoint!=='string'||value.endpoint.length>2048||typeof value.certificate!=='string'||value.certificate.length>20000||typeof value.fingerprint!=='string')throw Error('Некорректный файл подключения.');
 const url=new URL(value.endpoint),certificate=new X509Certificate(value.certificate);
 if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Invalid service address.');
 if(certificate.fingerprint256!==value.fingerprint)throw new Error('Certificate fingerprint mismatch.');
 const hostname=url.hostname.replace(/^\[|\]$/g,'');
 if(!(isIP(hostname)?certificate.checkIP(hostname):certificate.checkHost(hostname)))throw Error('Сертификат не соответствует адресу сервера.');
 if(Date.now()<Date.parse(certificate.validFrom)||Date.now()>Date.parse(certificate.validTo))throw Error('Срок сертификата сервера истёк или ещё не наступил.');
 return {endpoint:url.origin,certificate:value.certificate,fingerprint:value.fingerprint};
}
export function createConnection(config){
 const endpoint=new URL(config.endpoint);let cookie='',generation=0;
 // The same bundled configuration works locally and on other computers.
 const local=Object.values(networkInterfaces()).flat().some(item=>item?.address===endpoint.hostname);
 const agent=new https.Agent({keepAlive:true});
 return {clear:()=>{generation++;cookie='';agent.destroy();},async request(path,method='GET',body,maximum=4*1024*1024,csrf){
  const url=new URL(path,endpoint);
  if(url.origin!==endpoint.origin||!/^\/(auth|api)\//.test(url.pathname)||url.pathname.includes('..')||!(['GET','POST'].includes(method)||method==='PATCH'&&/^\/api\/catalog\/(styles|references)\/[a-zA-Z0-9_-]+$/.test(url.pathname)))throw new Error('Invalid application request.');
  const requestGeneration=generation;
  const payload=body===undefined?undefined:JSON.stringify(body);if(payload&&Buffer.byteLength(payload)>64000)throw new Error('Request too large.');
  return new Promise((resolve,reject)=>{
   const req=https.request({agent,hostname:local?'127.0.0.1':endpoint.hostname,port:endpoint.port||443,path:url.pathname+url.search,method,ca:config.certificate,rejectUnauthorized:true,checkServerIdentity:(_host,cert)=>checkServerIdentity(endpoint.hostname,cert)||(cert.fingerprint256!==config.fingerprint?new Error('Service certificate changed.'):undefined),headers:{host:endpoint.host,origin:endpoint.origin,'content-type':'application/json',...(typeof csrf==='string'&&csrf.length<100?{'x-csrf-token':csrf}:{}),...(cookie?{cookie}:{}),...(payload?{'content-length':Buffer.byteLength(payload)}:{})}},res=>{
    // Session cookies remain in the main process, never in the renderer or disk.
    const session=res.headers['set-cookie']?.find(value=>value.startsWith('__Host-factory='));if(session&&requestGeneration===generation)cookie=session.split(';')[0];
    let size=0;const parts=[];res.on('data',chunk=>{size+=chunk.length;if(size>maximum){res.destroy();reject(new Error('Response too large.'));}else parts.push(chunk);});res.on('error',()=>reject(new Error('Connection interrupted.')));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(parts)}));
   });req.setTimeout(30000,()=>req.destroy(new Error('Connection timed out.')));req.on('error',()=>reject(new Error('Не удалось подключиться к API. Проверьте доступность сервера или импортируйте новый файл подключения.')));if(payload)req.write(payload);req.end();
  });
 }};
}
