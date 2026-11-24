import { createHash } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { Parser } from 'saxen';
import { AppError } from '../../../packages/contracts/src/model.js';
import { publicationDomain,pilotDomains } from './hosting-policy.js';

export type DnsRecord={Name:string;Type:string;Address:string;MXPref:string;TTL:string;providerData?:Record<string,unknown>};
export type DnsZone={domain:string;records:DnsRecord[];emailType?:string};
export type NamecheapConfig={username:string;apiKey:string;clientIp:string};
export function zoneHash(zone:DnsZone){return createHash('sha256').update(JSON.stringify({email:zone.emailType??'',records:zone.records.filter(r=>r.Type!=='SOA').map(r=>JSON.stringify({Name:r.Name,Type:r.Type,Address:r.Address,MXPref:r.MXPref,TTL:r.TTL,...(r.providerData&&r.Type!=='A'?{extra:Object.fromEntries(Object.entries(r.providerData).filter(([k])=>k!=='recordId').sort(([a],[b])=>a.localeCompare(b)))}:{})})).sort()})).digest('hex');}
export function mergeIPv4(zone:DnsZone,ip:string,ttl='300'):DnsZone{
  if(!isIPv4(ip))throw new AppError('INVALID_INPUT','Некорректный IPv4.');
  // Preserve mail, verification, www and other subdomains. No AAAA rewrite is implicit.
  if(zone.records.some(r=>r.Name==='@'&&['AAAA','CNAME','ALIAS'].includes(r.Type)))throw new AppError('CONFLICT','У корня домена есть AAAA/CNAME/ALIAS. Сначала согласуйте совместимую DNS-конфигурацию.');
  return {...zone,records:[...zone.records.filter(r=>!(r.Name==='@'&&['A','URL','URL301','FRAME'].includes(r.Type))),{Name:'@',Type:'A',Address:ip,MXPref:'10',TTL:ttl}]};
}

export function parseNamecheap(xml:string){
  if(xml.length>1024*1024||/<!DOCTYPE|<!ENTITY/i.test(xml))throw new AppError('UNAVAILABLE','Небезопасный ответ DNS API.');
  const tags:{name:string;attrs:Record<string,string>}[]=[];
  const parser=new Parser();
  parser.on('error',()=>{throw new AppError('UNAVAILABLE','Некорректный ответ DNS API.');});
  parser.on('warn',()=>{throw new AppError('UNAVAILABLE','Неоднозначный ответ DNS API.');});
  parser.on('openTag',(name:string,attrs:()=>Record<string,string>,decode?:(v:string)=>string)=>{tags.push({name,attrs:Object.fromEntries(Object.entries(attrs()).map(([k,v])=>[k,decode?decode(v):v]))});});
  parser.parse(xml);
  if(tags.find(t=>t.name==='ApiResponse')?.attrs.Status!=='OK'){
    const number=tags.find(t=>t.name==='Error')?.attrs.Number??'unknown';
    throw new AppError('UNAVAILABLE',`Namecheap отклонил запрос (${number}). Проверьте API-ключ, whitelist и DNS домена.`);
  }
  return tags;
}
export class NamecheapDns{
  private static lastCall=0;
  constructor(private config:NamecheapConfig,private transport:typeof fetch=fetch,private allowed:readonly string[]|undefined=pilotDomains){}
  private async call(domain:string,command:string,values:Record<string,string>={}){
    domain=publicationDomain(domain,this.allowed);
    const parts=domain.split('.');if(parts.length<2)throw new AppError('INVALID_INPUT','Нужен корневой домен.');
    if(!isIPv4(this.config.clientIp))throw new AppError('INVALID_INPUT','Нужен исходящий IPv4 управляющего сервера.');
    // Reserve the next slot before awaiting: independent host queues share one limiter.
    const slot=Math.max(Date.now(),NamecheapDns.lastCall+6100);NamecheapDns.lastCall=slot;const wait=slot-Date.now();if(wait>0)await new Promise(r=>setTimeout(r,wait));
    const body=new URLSearchParams({ApiUser:this.config.username,ApiKey:this.config.apiKey,UserName:this.config.username,ClientIp:this.config.clientIp,Command:command,SLD:parts[0]!,TLD:parts.slice(1).join('.'),...values});
    let response:Response;
    try{response=await this.transport('https://api.namecheap.com/xml.response',{method:'POST',body,redirect:'error',signal:AbortSignal.timeout(25000)});}catch(e){if(e instanceof AppError)throw e;throw new AppError('UNAVAILABLE','Namecheap не ответил. Проверьте сеть и whitelist IPv4.');}
    if(!response.ok)throw new AppError('UNAVAILABLE',`Namecheap HTTP ${response.status}.`);
    const reader=response.body!.getReader();const chunks:Uint8Array[]=[];let size=0;
    while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>1024*1024){await reader.cancel();throw new AppError('UNAVAILABLE','Ответ Namecheap слишком большой.');}chunks.push(value);}
    return parseNamecheap(Buffer.concat(chunks).toString('utf8'));
  }
  async read(domain:string):Promise<DnsZone>{
    const tags=await this.call(domain,'namecheap.domains.dns.getHosts');
    const result=tags.find(t=>t.name==='DomainDNSGetHostsResult');
    if(result?.attrs.IsUsingOurDNS!=='true'||result.attrs.Domain?.toLowerCase()!==domain)throw new AppError('CONFLICT','Домен должен использовать поддерживаемый DNS Namecheap.');
    const records=tags.filter(t=>t.name==='host'||t.name==='Host').map(t=>{
      const a=t.attrs;
      if(!a.Name||!a.Type||a.Address===undefined||!a.TTL)throw new AppError('UNAVAILABLE','DNS-запись прочитана не полностью.');
      if(!['A','AAAA','CAA','CNAME','MX','MXE','NS','TXT','URL','URL301','FRAME','ALIAS'].includes(a.Type))throw new AppError('CONFLICT',`Тип DNS ${a.Type} пока не поддерживается безопасной записью.`);
      if(a.IsDDNSEnabled==='true')throw new AppError('CONFLICT','В зоне есть Dynamic DNS: автоматическая перезапись остановлена.');
      return {Name:a.Name,Type:a.Type,Address:a.Address,MXPref:a.MXPref??'10',TTL:a.TTL};
    });
    const email=tags.find(t=>t.name==='EmailType')?.attrs.Type??result.attrs.EmailType;
    return {domain,records,...(email?{emailType:email}:{})};
  }
  async write(zone:DnsZone){
    publicationDomain(zone.domain,this.allowed);
    if(!zone.records.length||zone.records.length>150)throw new AppError('INVALID_INPUT','Неподдерживаемый размер DNS-зоны.');
    const values:Record<string,string>={};
    zone.records.forEach((r,i)=>{const n=i+1;Object.assign(values,{['HostName'+n]:r.Name,['RecordType'+n]:r.Type,['Address'+n]:r.Address,['MXPref'+n]:r.MXPref,['TTL'+n]:r.TTL});});
    if(zone.emailType)values.EmailType=zone.emailType;
    const result=(await this.call(zone.domain,'namecheap.domains.dns.setHosts',values)).find(t=>t.name==='DomainDNSSetHostsResult');
    if(result?.attrs.IsSuccess!=='true')throw new AppError('UNAVAILABLE','Namecheap не подтвердил сохранение DNS.');
  }
}
