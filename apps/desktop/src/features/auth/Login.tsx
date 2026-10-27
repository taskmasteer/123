import React,{useRef,useState} from 'react';
import {createClient} from '@supabase/supabase-js';
import type {SupabaseClient} from '@supabase/supabase-js';
import {RemoteClient} from '../../lib/remote-client.js';
import {selectClient} from '../../lib/desktop-client.js';
import type {SessionView} from '../../../../../packages/contracts/src/http.js';
export function Login({managed,onStart,onConnected,onLocal}:{managed:boolean;onStart:()=>void;onConnected:(session:SessionView)=>void;onLocal:()=>void}){
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[password,setPassword]=useState('');const auth=useRef<SupabaseClient|null>(null);
 async function login(event:React.FormEvent<HTMLFormElement>){event.preventDefault();setBusy(true);setError('');const fields=new FormData(event.currentTarget),secret=password;setPassword('');try{
  const authUrl=new URL(String(fields.get('authUrl')));if(authUrl.protocol!=='https:')throw new Error('Требуется HTTPS-адрес Supabase.');
  const key=String(fields.get('publishableKey'));if(!key.startsWith('sb_publishable_'))throw new Error('Используйте publishable key, доступный клиентам.');
  const client=createClient(authUrl.origin,key,{auth:{storageKey:`site-factory-managed-${crypto.randomUUID()}`,persistSession:false,autoRefreshToken:true,detectSessionInUrl:false}});auth.current?.auth.stopAutoRefresh();auth.current=client;
  const remote=new RemoteClient(String(fields.get('apiUrl')),async()=>(await client.auth.getSession()).data.session?.access_token??null,fetch,()=>{client.auth.stopAutoRefresh();void client.auth.signOut();});
  selectClient(remote);onStart();
  const result=await client.auth.signInWithPassword({email:String(fields.get('email')),password:secret});if(result.error)throw new Error('Не удалось войти. Проверьте email и пароль.');
  onConnected(await remote.request<SessionView>('session'));
 }catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 return <section className="device-panel"><h2>Подключение к общему API</h2><p>Вход по приглашению. Роль и доступные сайты определяет сервер. Генерация и публикация в управляемом режиме пока недоступны.</p>{error?<p role="alert">{error}</p>:null}
 <form onSubmit={e=>void login(e)} className="managed-form"><label>Адрес общего API<input name="apiUrl" type="url" placeholder="https://control.example.com" required/></label><label>Адрес проекта Supabase<input name="authUrl" type="url" placeholder="https://project.supabase.co" required/></label><label>Publishable key<input name="publishableKey" autoComplete="off" required/></label><label>Email<input name="email" type="email" autoComplete="username" required/></label><label>Пароль<input type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password" required/></label><button className="primary" disabled={busy}>{busy?'Подключение…':'Войти в общий реестр'}</button></form>
 {managed?<button onClick={()=>{auth.current?.auth.stopAutoRefresh();void auth.current?.auth.signOut();selectClient('local');onLocal();}}>Перейти в локальный режим</button>:<p className="hint">Сейчас выбран локальный режим. Данные на этом устройстве отделены от общего реестра.</p>}</section>;
}
