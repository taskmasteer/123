import {StatusBadge} from '../components/ui/status-badge.js';
import React,{useState} from 'react';
import {Button} from '../components/ui/button.js';
import {api} from './client.js';
import type {DesktopSite} from '../features/sites/SiteList.js';
type Plan={siteId:string;domain:string;revisionId:string;address:string;serverId:string;provider:string};
type Row={id:string;domain:string;plan?:Plan;status:string};
export function BulkPublication({sites,onChange}:{sites:DesktopSite[];onChange:()=>Promise<unknown>}){
 const [selected,setSelected]=useState<Record<string,string>>({}),[rows,setRows]=useState<Row[]>([]),[busy,setBusy]=useState(false),[checked,setChecked]=useState(false);
 async function check(){setBusy(true);setChecked(false);const result:Row[]=[],excluded:string[]=[];try{for(const [id,domain]of Object.entries(selected)){try{const plan=await api<Plan>('/api/sites/'+id+'/hosting/preflight',{excluded});excluded.push(plan.address);result.push({id,domain,plan,status:'Готов · '+plan.address+' · '+plan.provider});}catch(e){result.push({id,domain,status:(e as Error).message});}setRows([...result]);}setChecked(true);}finally{setBusy(false);}}
 async function publish(){setBusy(true);setChecked(false);try{for(const row of rows){if(!row.plan)continue;try{await api('/api/sites/'+row.id+'/hosting',row.plan);row.status='Поставлен в очередь';delete row.plan;setSelected(s=>{const next={...s};delete next[row.id];return next;});}catch(e){row.status=(e as Error).message;delete row.plan;}setRows([...rows]);}await onChange();}finally{setBusy(false);}}
 return <details className="hosting-panel"><summary>Массовая публикация</summary><p>Выберите до 256 сайтов. Проверка читает DNS и проверяет файлы и свободные IPv4. Адреса закрепляются при постановке в очередь.</p>
 <div className="hosting-actions"><Button variant="outline" disabled={busy} onClick={()=>{setSelected(s=>Object.fromEntries([...Object.entries(s),...sites.filter(s=>s.draftId).map(s=>[s.id,s.domain])].slice(0,256)));setChecked(false);}}>Выбрать готовые на странице</Button><Button variant="ghost" disabled={busy} onClick={()=>{setSelected({});setRows([]);setChecked(false);}}>Снять выбор</Button></div>
 {sites.map(site=><label key={site.id} className="hosting-history"><input type="checkbox" aria-label={'Выбрать '+site.domain} checked={!!selected[site.id]} disabled={busy||!site.draftId||!selected[site.id]&&Object.keys(selected).length>=256} onChange={e=>{setSelected(s=>{const next={...s};if(e.target.checked)next[site.id]=site.domain;else delete next[site.id];return next;});setChecked(false);}}/>{site.domain}</label>)}
 <p>Выбрано: {Object.keys(selected).length}. Выбор сохраняется при переходе между страницами.</p><div className="hosting-actions"><Button disabled={busy||!Object.keys(selected).length} onClick={()=>void check()}>Проверить выбранные</Button><Button disabled={busy||!checked||!rows.some(r=>r.plan)} onClick={()=>void publish()}>Опубликовать прошедшие проверку</Button></div>
 {busy?<p role="status">Обработка… Дождитесь результата перед закрытием приложения. Поставленные в очередь задания продолжатся на сервере.</p>:null}
 {rows.map(row=><p key={row.id}>{row.domain}: <StatusBadge state={row.plan?'ready':row.status==='Поставлен в очередь'?'queued':'failed'}>{row.status}</StatusBadge></p>)}
 </details>;
}
