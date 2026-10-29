import React,{useRef,useState} from 'react';
import {createClient} from '@supabase/supabase-js';
import type {SupabaseClient} from '@supabase/supabase-js';
import {RemoteClient} from '../../lib/remote-client.js';
import {selectClient} from '../../lib/desktop-client.js';
import type {SessionView} from '../../../../../packages/contracts/src/http.js';
export function Login({managed,onStart,onConnected,onLocal}:{managed:boolean;onStart:()=>void;onConnected:(session:SessionView)=>void;onLocal:()=>void}){
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[password,setPassword]=useState(''),[code,setCode]=useState('');
 const [stage,setStage]=useState<'signin'|'invite'|'password'>('signin');
 const auth=useRef<SupabaseClient|null>(null),remote=useRef<RemoteClient|null>(null);
 async function login(event:React.FormEvent<HTMLFormElement>){
  event.preventDefault();setBusy(true);setError('');const fields=new FormData(event.currentTarget),secret=password,token=code;setPassword('');setCode('');
  let passwordSaved=false;
  try{
   if(stage!=='password'){
    const authUrl=new URL(String(fields.get('authUrl')));
    if(authUrl.protocol!=='https:'||authUrl.username||authUrl.password||authUrl.pathname!=='/'||authUrl.search||authUrl.hash)throw new Error('Требуется HTTPS-адрес Supabase без пути.');
    const key=String(fields.get('publishableKey'));if(!key.startsWith('sb_publishable_'))throw new Error('Используйте publishable key, доступный клиентам.');
    const client=createClient(authUrl.origin,key,{global:{fetch:async(input,init)=>{
     const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
     if(url.origin!==authUrl.origin)throw new Error('Недопустимый адрес Auth.');
     return fetch(input,{...init,redirect:'error'});
    }},auth:{storageKey:`site-factory-managed-${crypto.randomUUID()}`,persistSession:false,autoRefreshToken:true,detectSessionInUrl:false}});
    let subscription:{unsubscribe():void}|undefined;
    const next=new RemoteClient(String(fields.get('apiUrl')),async()=>(await client.auth.getSession()).data.session?.access_token??null,fetch,()=>{subscription?.unsubscribe();client.auth.stopAutoRefresh();void client.auth.signOut();});
    subscription=client.auth.onAuthStateChange(event=>{if(event==='SIGNED_OUT')next.dispose();}).data.subscription;
    auth.current?.auth.stopAutoRefresh();auth.current=client;remote.current=next;selectClient(next);onStart();
    const email=String(fields.get('email')).trim();
    if(stage==='invite'){
     const result=await client.auth.verifyOtp({email,token,type:'invite'});
     if(result.error||!result.data.session)throw new Error('Код недействителен или истёк. Проверьте письмо и обратитесь к администратору.');
     setStage('password');return;
    }
    const result=await client.auth.signInWithPassword({email,password:secret});if(result.error)throw new Error('Не удалось войти. Проверьте email и пароль.');
   }else{
    if(!auth.current||!remote.current)throw new Error('Подтвердите приглашение ещё раз.');
    const result=await auth.current.auth.updateUser({password:secret});
    if(result.error)throw new Error('Не удалось сохранить пароль. Проверьте требования к паролю и повторите; код повторно вводить не нужно.');
    passwordSaved=true;setStage('signin');
   }
   onConnected(await remote.current!.request<SessionView>('session'));
  }catch(e){
   if(passwordSaved&&(e as {code?:string}).code==='FORBIDDEN')setError('Пароль сохранён. Доступ к реестру ещё не предоставлен: попросите администратора повторить приглашение с тем же email и ролью, затем войдите с паролем.');
   else setError((e as Error).message);
  }finally{setBusy(false);}
 }
 return <section className="device-panel"><h2>Подключение к общему API</h2><p>Вход по приглашению. Роль и доступные сайты определяет сервер. Генерация и публикация в управляемом режиме пока недоступны.</p>{error?<p role="alert">{error}</p>:null}
 <form onSubmit={e=>void login(e)} className="managed-form">
  <label>Адрес общего API<input name="apiUrl" type="url" placeholder="https://control.example.com" disabled={busy||stage==='password'} required/></label>
  <label>Адрес проекта Supabase<input name="authUrl" type="url" placeholder="https://project.supabase.co" disabled={busy||stage==='password'} required/></label>
  <label>Publishable key<input name="publishableKey" autoComplete="off" disabled={busy||stage==='password'} required/></label>
  <label>Email<input name="email" type="email" autoComplete="username" disabled={busy||stage==='password'} required/></label>
  {stage==='invite'?<label>Код приглашения<input value={code} onChange={e=>setCode(e.target.value)} autoComplete="one-time-code" inputMode="numeric" disabled={busy} required/></label>:<label>{stage==='password'?'Новый пароль':'Пароль'}<input type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete={stage==='password'?'new-password':'current-password'} disabled={busy} required/></label>}
  {stage==='password'?<p>Код подтверждён. Установите пароль для следующих входов. Если сохранение не удалось, повторите этот шаг без нового кода.</p>:null}
  <button className="primary" disabled={busy}>{busy?'Подключение…':stage==='invite'?'Подтвердить код':stage==='password'?'Сохранить пароль и войти':'Войти в общий реестр'}</button>
 </form>
 {stage!=='password'?<button disabled={busy} onClick={()=>{setStage(stage==='signin'?'invite':'signin');setCode('');setPassword('');setError('');}}>{stage==='signin'?'Принять приглашение по коду':'У меня уже есть пароль'}</button>:null}
 {managed?<button disabled={busy} onClick={()=>{selectClient('local');onLocal();}}>Перейти в локальный режим</button>:<p className="hint">Сейчас выбран локальный режим. Данные на этом устройстве отделены от общего реестра.</p>}</section>;
}
