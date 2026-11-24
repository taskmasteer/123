import React,{useEffect,useState} from 'react';
import {api} from './client.js';
import {Button} from '../components/ui/button.js';
import {Input} from '../components/ui/input.js';
import {Label} from '../components/ui/label.js';
import {Select,SelectTrigger,SelectValue,SelectContent,SelectItem} from '../components/ui/select.js';
export function DomainProviders(){
 const [provider,setProvider]=useState('godaddy'),[rows,setRows]=useState<{domain:string;provider:string}[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const load=()=>api<typeof rows>('/api/hosting/domains').then(setRows);
 useEffect(()=>{void load().catch(e=>setError(e.message));},[]);
 return <section className="settings-card"><h2>DNS доменов</h2><p>Если подключён один провайдер, новые домены используют его. Если подключены оба, укажите провайдера до создания сайта или запуска пачки.</p><form onSubmit={e=>{e.preventDefault();const form=e.currentTarget,domain=new FormData(form).get('domain');setBusy(true);setError('');void api('/api/hosting/domains',{domain,provider}).then(()=>{form.reset();return load();}).catch(e=>setError(e.message)).finally(()=>setBusy(false));}}><div className="field"><Label htmlFor="dns-domain">Домен</Label><Input id="dns-domain" name="domain" placeholder="example.com" required disabled={busy}/></div><div className="field"><Label>DNS-провайдер</Label><Select value={provider} onValueChange={setProvider} disabled={busy}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem value="godaddy">GoDaddy</SelectItem><SelectItem value="namecheap">Namecheap</SelectItem></SelectContent></Select></div><Button disabled={busy}>Сохранить провайдера</Button></form>{error?<p role="alert">{error}</p>:null}<div className="members">{rows.map(row=><div key={row.domain}><span>{row.domain}</span><span>{row.provider==='godaddy'?'GoDaddy':'Namecheap'}</span></div>)}</div></section>;
}
