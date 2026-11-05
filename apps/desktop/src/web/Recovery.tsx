import {StatusBadge} from '../components/ui/status-badge.js';
import React,{useEffect,useState} from 'react';
import {Download,ShieldCheck,RefreshCw,KeyRound} from 'lucide-react';
import {Button} from '../components/ui/button.js';
import {Badge} from '../components/ui/badge.js';
import {api} from './client.js';
type Backup={id:string;status:string;error:string|null;bytes:string|null;created_at:string};
export function RecoverySettings(){
 const [state,setState]=useState<{held:boolean;maintenance:boolean;backups:Backup[]}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const refresh=()=>api<NonNullable<typeof state>>('/api/recovery').then(setState);
 useEffect(()=>{const load=()=>void refresh().catch(e=>setError(e.message));load();const timer=setInterval(load,3000);return()=>clearInterval(timer);},[]);
 async function run(action:()=>Promise<unknown>){setBusy(true);setError('');try{await action();await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 return <section className="settings-card"><div className="settings-title"><h2>Резервные копии</h2><ShieldCheck/></div><p>Полная зашифрованная копия базы, файлов, настроек и ключей создаётся ежедневно. Для восстановления нужны архив и ключ. Сохраните оба вне Windows VPS.</p>
 {state?.held?<div className="notice"><p>Установка восстановлена. Фоновые операции остановлены. Проверьте доступ к Linux VPS, адрес Windows в Namecheap whitelist и настройки подключения клиентов.</p><Button disabled={busy} onClick={()=>void run(()=>api('/api/recovery/resume',{}))}>Продолжить после восстановления</Button></div>:null}
 {error?<p className="notice" role="alert">{error}</p>:null}
 <div className="hosting-actions"><Button disabled={busy||state?.maintenance||state?.backups.some(b=>b.status==='running')} onClick={()=>void run(()=>api('/api/recovery/backups',{}))}><RefreshCw/>Создать копию</Button><Button variant="outline" disabled={busy} onClick={()=>void run(async()=>{if(!window.factoryDesktop)throw Error('Сохранение ключа доступно в настольном приложении.');const result=await api<{key:string}>('/api/recovery/key',{});await window.factoryDesktop.saveAccess('Site Factory — ключ восстановления\n'+result.key+'\nХраните отдельно от сервера. Нужен вместе с файлом .sfbak.\n');})}><KeyRound/>Сохранить ключ восстановления</Button></div>
 {state?.maintenance?<p role="status">Создаётся согласованная копия. Рабочие операции временно приостановлены.</p>:null}
 {state?.backups.map(backup=><div className="hosting-history" key={backup.id}><span>{new Date(backup.created_at).toLocaleString('ru')}{backup.bytes?' · '+(Number(backup.bytes)/1024/1024).toFixed(1)+' МБ':''}</span><StatusBadge state={backup.status}>{({running:'Создаётся',complete:'Проверена',failed:'Ошибка',expired:'Заменена новой копией',unavailable:'Архив на прежнем сервере'} as Record<string,string>)[backup.status]}</StatusBadge>{backup.error?<p role="alert">{backup.error}</p>:null}{backup.status==='complete'?<Button variant="outline" size="sm" disabled={busy} onClick={()=>void run(async()=>{if(!window.factoryDesktop)throw Error('Скачайте копию из настольного приложения.');await window.factoryDesktop.backupDownload(backup.id);})}><Download/>Сохранить архив</Button>:null}</div>)}
 </section>;
}
