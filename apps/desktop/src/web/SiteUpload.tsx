import React,{useRef,useState} from 'react';
import {Upload} from 'lucide-react';
import {Button} from '../components/ui/button.js';
import {api} from './client.js';

export function SiteUpload({siteId,disabled,onSaved,onBusy}:{siteId:string;disabled:boolean;onSaved:(id:string)=>void;onBusy:(busy:boolean)=>void}){
 const input=useRef<HTMLInputElement>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
 async function upload(file:File){
  setError('');setMessage('');if(file.size>11000000||!file.name.toLowerCase().endsWith('.zip')){setError('Выберите ZIP размером до 11 МБ.');return;}setBusy(true);onBusy(true);
  try{
   const path=`/api/sites/${siteId}/upload`,transfer=await api<{id:string}>(path,{action:'begin',size:file.size});
   for(let offset=0;offset<file.size;offset+=32768){const bytes=new Uint8Array(await file.slice(offset,offset+32768).arrayBuffer());await api(path,{action:'chunk',id:transfer.id,offset,base64:btoa(String.fromCharCode(...bytes))});setMessage(`Загрузка: ${Math.min(100,Math.round((offset+bytes.length)/file.size*100))}%`);}
   const saved=await api<{revisionId:string}>(path,{action:'commit',id:transfer.id});onSaved(saved.revisionId);setMessage('Новая версия сохранена. Нажмите «Опубликовать обновление», чтобы заменить сайт.');
  }catch(e){setError((e as Error).message);}finally{setBusy(false);onBusy(false);if(input.current)input.current.value='';}
 }
 return <div className="site-upload"><h3>Новая версия из ZIP</h3><p>index.html в корне, до 100 статических файлов, до 10 МБ после распаковки. Загружается полный комплект файлов новой версии.</p><input ref={input} type="file" accept=".zip,application/zip" hidden aria-label="Архив новой версии" onChange={e=>{const file=e.target.files?.[0];if(file)void upload(file);}}/><Button variant="outline" disabled={disabled||busy} onClick={()=>input.current?.click()}><Upload/>{busy?'Загрузка…':'Загрузить ZIP с новой версией'}</Button>{message?<p role="status">{message}</p>:null}{error?<p role="alert">{error}</p>:null}</div>;
}
