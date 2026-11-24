import {randomUUID} from 'node:crypto';
import {isIPv4} from 'node:net';
import {AppError} from '../../../packages/contracts/src/model.js';
import {publicationDomain} from './hosting-policy.js';
import {zoneHash,type DnsZone,type DnsRecord} from './namecheap.js';

// Domains v3, PAT auth. Mutations target a single apex A record, never the zone.
export class GoDaddyDns {
  constructor(private token:string,private transport:typeof fetch=fetch){}
  private async call(domain:string,suffix:string,method='GET',body?:unknown){
    domain=publicationDomain(domain);
    const identity=randomUUID();
    let response:Response;
    try{response=await this.transport(`https://api.godaddy.com/v3/domains/zones/${encodeURIComponent(domain)}/dns-records${suffix}`,{method,headers:{Authorization:`Bearer ${this.token}`,...(body?{'Content-Type':'application/json','Idempotency-Key':identity}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(25000)});}catch(e){if(e instanceof AppError)throw e;throw new AppError('UNAVAILABLE','GoDaddy не ответил. Повторите позже.');}
    if(!response.ok)throw new AppError('UNAVAILABLE',`GoDaddy HTTP ${response.status}. Проверьте доступ к домену и права токена Domains/DNS.`);
    const reader=response.body!.getReader();const chunks:Uint8Array[]=[];let size=0;
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2000000){await reader.cancel();throw new AppError('UNAVAILABLE','Ответ GoDaddy слишком большой.');}chunks.push(value);}
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new AppError('UNAVAILABLE','Некорректный ответ GoDaddy.');}
  }
  async read(domain:string):Promise<DnsZone>{
    domain=publicationDomain(domain);const records:DnsRecord[]=[];let total:number|undefined;
    for(let page=1;page<=100;page++){
      const result=await this.call(domain,`?page=${page}&pageSize=100&totalRequired=true`);
      if(page===1&&Array.isArray(result.items)&&result.items.length===0&&result.totalPages===undefined&&result.totalItems===undefined)return {domain,records:[]};
      if(!Array.isArray(result.items)||!Number.isInteger(result.totalPages)||result.totalPages<0||result.totalPages>100||!Number.isInteger(result.totalItems))throw new AppError('UNAVAILABLE','Неполный ответ DNS GoDaddy.');
      if(total!==undefined&&total!==result.totalItems)throw new AppError('CONFLICT','DNS GoDaddy изменился во время чтения.');total=result.totalItems;
      for(const r of result.items){
        if(typeof r.recordId!=='string'||typeof r.name!=='string'||typeof r.type!=='string'||typeof r.data!=='string'||!Number.isInteger(r.ttl))throw new AppError('UNAVAILABLE','Неполная DNS-запись GoDaddy.');
        records.push({Name:r.name,Type:r.type,Address:r.data,TTL:String(r.ttl),MXPref:String(r.priority??10),providerData:r});
      }
      if(page>=result.totalPages){if(records.length!==total||new Set(records.map(r=>r.providerData!.recordId)).size!==records.length)throw new AppError('CONFLICT','DNS GoDaddy изменился во время чтения.');return {domain,records};}
    }
    throw new AppError('UNAVAILABLE','DNS-зона слишком велика.');
  }
  async write(zone:DnsZone,before?:DnsZone){
    publicationDomain(zone.domain);
    const desired=zone.records.filter(r=>r.Type==='A'&&r.Name==='@');
    if(desired.length!==1||!isIPv4(desired[0]!.Address)||Number(desired[0]!.TTL)<600)throw new AppError('INVALID_INPUT','Нужен один IPv4 корня домена и TTL от 600 секунд.');
    const current=await this.read(zone.domain);if(before&&zoneHash(current)!==zoneHash(before)&&zoneHash(current)!==zoneHash(zone))throw new AppError('CONFLICT','DNS GoDaddy изменился перед записью.');const apex=current.records.filter(r=>r.Type==='A'&&r.Name==='@');
    const unrelated=(z:DnsZone)=>({...z,records:z.records.filter(r=>!(r.Type==='A'&&r.Name==='@'))});
    if(zoneHash(unrelated(current))!==zoneHash(unrelated(zone)))throw new AppError('CONFLICT','DNS GoDaddy изменился перед записью.');
    if(apex.length>1)throw new AppError('CONFLICT','В GoDaddy несколько A-записей корня. Оставьте одну перед подключением сайта.');
    if(current.records.some(r=>r.Name==='@'&&['AAAA','CNAME','ALIAS'].includes(r.Type)))throw new AppError('CONFLICT','В DNS есть несовместимые AAAA/CNAME/ALIAS.');
    const record=desired[0]!,body={name:'@',type:'A',data:record.Address,ttl:Number(record.TTL)};
    if(apex.length&&apex[0]!.Address===record.Address&&apex[0]!.TTL===record.TTL)return;
    await this.call(zone.domain,apex.length?'/'+encodeURIComponent(String(apex[0]!.providerData!.recordId)):'',apex.length?'PUT':'POST',body);
  }
}
