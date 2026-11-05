import React,{useState} from 'react';
import {Button} from '../components/ui/button.js';
import {api} from './client.js';
export function ClientUpdates(){
 const [release,setRelease]=useState<{available:boolean;version?:string;protocol:number}|null>(null),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 async function run(action:()=>Promise<void>){setBusy(true);setMessage('');try{await action();}catch(e){setMessage((e as Error).message);}finally{setBusy(false);}}
 return <section className="settings-card"><h2>Обновление приложения</h2><p>Установлена версия {window.factoryDesktop?.version??'для проверки интерфейса'}. Пакеты загружаются с вашего управляющего сервера и проверяются по SHA-256.</p><Button variant="outline" disabled={busy} onClick={()=>void run(async()=>{setRelease(await api('/api/client-release'));})}>Проверить обновления</Button>
 {release?<p>{release.available?'Доступный пакет: '+release.version:'Пакет ещё не опубликован.'}</p>:null}
 {release?.available?<Button disabled={busy||!window.factoryDesktop||release.protocol!==1} onClick={()=>void run(async()=>{if(await window.factoryDesktop!.updateDownload())setMessage('Пакет сохранён. Закройте приложение, распакуйте архив в новую папку и запустите Site Factory.exe. Прежнюю папку сохраните для возврата.');})}>Скачать проверенный пакет</Button>:null}
 {release?.protocol&&release.protocol!==1?<p role="alert">Для этого протокола требуется новый установочный пакет от владельца сервера.</p>:null}{message?<p role="status">{message}</p>:null}
 </section>;
}
