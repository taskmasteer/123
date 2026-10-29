import React,{useEffect,useRef,useState} from 'react';
import type {Style,Reference} from '../../../../../packages/adapters/src/local-catalog.js';
import {desktopClient} from '../../lib/desktop-client.js';
export function CreateSiteDialog({styles,references,onClose,onCreated}:{styles:Style[];references:Reference[];onClose:()=>void;onCreated:()=>void}){
 const ref=useRef<HTMLDialogElement>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const enabledStyles=styles.filter(style=>style.enabled);
 const eligibleReferenceIds=new Set(enabledStyles.flatMap(style=>style.referenceIds));
 useEffect(()=>{ref.current?.showModal();},[]);
 return <dialog ref={ref} onCancel={event=>{if(busy)event.preventDefault();else onClose();}} aria-labelledby="create-title">
 <form onSubmit={async event=>{event.preventDefault();if(busy)return;const data=new FormData(event.currentTarget);setBusy(true);setError('');try{
 await desktopClient.request('site.create',{domain:String(data.get('domain')).trim(),about:String(data.get('about')),...(data.get('referenceId')?{referenceId:String(data.get('referenceId'))}:{})});onCreated();
 }catch(e){setError((e as Error).message);setBusy(false);}}}>
 <h2 id="create-title">Создать сайт</h2><p className="muted">Укажите домен. Тему можно описать самостоятельно или оставить выбор исполнителю.</p>
 <label>Домен<input name="domain" autoFocus required maxLength={253} placeholder="example.test" disabled={busy}/></label>
 <label>О чём сайт <span className="muted">(необязательно)</span><textarea name="about" rows={3} maxLength={8000} disabled={busy} placeholder="Например: инструменты для надёжной работы с данными"/></label>
 <label>Референс<select name="referenceId" disabled={busy}><option value="">Выбрать автоматически</option><optgroup label="Референсы">{references.filter(reference=>eligibleReferenceIds.has(reference.id)).map(reference=><option key={reference.id} value={reference.id}>{reference.name}</option>)}</optgroup><optgroup label="Стили">{enabledStyles.map(style=><option key={style.id} value={style.id}>{style.name}</option>)}</optgroup></select></label>
 <p className="hint">Содержимое сайта будет на английском. После проверки сохранится версия сайта; первый выпуск публикуется автоматически при настроенном подключении.</p>
 {error?<p role="alert" className="error">{error}</p>:null}
 <footer className="dialog-actions"><button type="button" onClick={onClose} disabled={busy}>Отмена</button><button className="primary" disabled={busy}>{busy?'Создание…':'Создать'}</button></footer>
 </form></dialog>;
}
