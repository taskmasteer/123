import {StatusBadge} from '../components/ui/status-badge.js';
import React,{useState} from 'react';
import {Button} from '../components/ui/button.js';
import {Input} from '../components/ui/input.js';
import {Textarea} from '../components/ui/textarea.js';
import {Label} from '../components/ui/label.js';
import {api} from './client.js';
export type ManagedHost={id:string;name:string;host:string;port:number;username:string;status:string;phase?:string;operation?:string;checked_at?:string|null;addresses?:{address:string;siteId:string|null;state:string;releaseAfter:string|null}[]};
const states:Record<string,string>={free:'Свободен',provisioning:'Настраивается',reserved:'Резерв',active:'Используется',draining:'Ожидает освобождения'};
export function ServerMaintenance({host,onChange}:{host:ManagedHost;onChange:()=>Promise<unknown>}){
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 async function action(name:string,fields:Record<string,unknown>={}){setBusy(true);setError('');try{await api('/api/servers/'+host.id+'/maintenance',{action:name,...fields});await onChange();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 const available=['ready','draining','retired'].includes(host.status),repair=host.status==='failed'&&host.phase==='maintenance'&&host.operation==='connection';
 return <details className="hosting-details"><summary>Адреса и обслуживание</summary><p>Последнее соединение: {host.checked_at?new Date(host.checked_at).toLocaleString('ru'):'ещё не проверено'}</p>
 {host.addresses?.map(a=><div className="hosting-history" key={a.address}><span>{a.address}</span><StatusBadge state={a.state}>{states[a.state]??a.state}</StatusBadge>{a.releaseAfter?<small>Освобождение после {new Date(a.releaseAfter).toLocaleString('ru')}</small>:null}</div>)}
 {error?<p role="alert" className="notice">{error}</p>:null}
 {available||repair?<><div className="hosting-actions"><Button variant="outline" size="sm" disabled={busy||repair} onClick={()=>void action('check')}>Проверить сервер</Button><Button variant="outline" size="sm" disabled={busy||repair} onClick={()=>void action('rotate')}>Заменить SSH-ключ</Button>{host.status==='ready'?<Button variant="outline" size="sm" disabled={busy} onClick={()=>void action('drain')}>Запретить новые сайты</Button>:<Button variant="outline" size="sm" disabled={busy||repair} onClick={()=>void action('activate')}>Разрешить размещение</Button>}<Button variant="outline" size="sm" disabled={busy||repair||host.status==='retired'||host.addresses?.some(a=>a.siteId)} onClick={()=>void action('retire')}>Вывести из конвейера</Button></div>
 <form onSubmit={e=>{e.preventDefault();const form=e.currentTarget;void action('addresses',{addresses:String(new FormData(form).get('addresses'))});}}><div className="field"><Label htmlFor={'extra-'+host.id}>Добавить IPv4, выделенные провайдером</Label><Textarea id={'extra-'+host.id} name="addresses" rows={2} required placeholder="По одному адресу на строку"/></div><Button variant="outline" disabled={busy||repair}>Настроить IPv4</Button></form>
 <details><summary>Изменить подключение SSH</summary><p>Параметры применятся после проверки соединения. Отпечаток сервера сохраняется. Пустой пароль означает использование текущего ключа.</p><form onSubmit={e=>{e.preventDefault();void action('connection',Object.fromEntries(new FormData(e.currentTarget)));}}>
 {([['name','Название',host.name],['host','IPv4 для SSH',host.host],['port','Порт',String(host.port)],['username','SSH-логин',host.username]] as const).map(([name,label,value])=><div className="field" key={name}><Label htmlFor={host.id+'-'+name}>{label}</Label><Input id={host.id+'-'+name} name={name} defaultValue={value} required/></div>)}
 <div className="field"><Label htmlFor={host.id+'-password'}>Пароль для нового подключения · необязательно</Label><Input id={host.id+'-password'} name="password" type="password" autoComplete="new-password"/></div><Button disabled={busy}>Проверить и сохранить SSH</Button></form></details></>:<p>Обслуживание станет доступно после завершения или повтора текущей операции.</p>}
 </details>;
}
