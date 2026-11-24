import React,{useEffect,useState} from 'react';
import {Button} from '../components/ui/button.js';
import {Input} from '../components/ui/input.js';
import {Label} from '../components/ui/label.js';
import {api} from './client.js';

export function AccountSecurity(){
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState(''),[count,setCount]=useState(0);
 const load=()=>api<unknown[]>('/api/account/sessions').then(s=>setCount(s.length));
 useEffect(()=>{void load().catch(e=>setError(e.message));},[]);
 async function run(action:()=>Promise<unknown>,message:string){setBusy(true);setError('');try{await action();await load();setMessage(message);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 return <section className="settings-card"><h2>Пароль и сеансы</h2><p>Активных сеансов: {count}. Смена пароля завершит вход на остальных устройствах.</p><form onSubmit={e=>{e.preventDefault();const form=e.currentTarget,data=new FormData(form);void run(async()=>{await api('/api/account/password',{currentPassword:data.get('currentPassword'),newPassword:data.get('newPassword')});form.reset();},'Пароль изменён. Сохраните новый пароль в своём менеджере паролей.');}}><div className="field"><Label htmlFor="current-password">Текущий пароль</Label><Input id="current-password" name="currentPassword" type="password" autoComplete="current-password" required maxLength={256} disabled={busy}/></div><div className="field"><Label htmlFor="new-password">Новый пароль</Label><Input id="new-password" name="newPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={256} disabled={busy}/></div><Button disabled={busy}>Изменить пароль</Button></form><Button className="mt-4" variant="outline" disabled={busy||count<2} onClick={()=>void run(()=>api('/api/account/sessions/revoke',{}),'Другие сеансы завершены.')}>Выйти на остальных устройствах</Button>{message?<p role="status">{message}</p>:null}{error?<p role="alert">{error}</p>:null}</section>;
}
