import React,{useState} from 'react';
import type {LocalCatalog} from '../../../../../packages/adapters/src/local-catalog.js';
import {desktopClient} from '../../lib/desktop-client.js';
export type Catalog=Awaited<ReturnType<LocalCatalog['list']>>;
export function ReferenceLibrary({catalog,onChange,canManage=true,managed=false}:{catalog:Catalog;onChange:()=>Promise<void>;canManage?:boolean;managed?:boolean}){
 const [busy,setBusy]=useState(''),[error,setError]=useState('');
 async function update(method:string,params:unknown,id:string){setBusy(id);setError('');try{await desktopClient.request(method,params);await onChange();}catch(e){setError((e as Error).message);}finally{setBusy('');}}
 return <div className="library"><div className="section-intro"><h2>Стили для новых сайтов</h2><p>Оригинальные шаблоны на основе композиционных приёмов. {managed?"Изменения доступны администратору установки.":"Изменения доступны локальному администратору."}</p></div>
 {error?<p role="alert" className="error">{error}</p>:null}<div className="styles">{catalog.styles.map(style=><label className="style" key={style.id}><input type="checkbox" checked={style.enabled} disabled={!!busy||!canManage} onChange={e=>void update('catalog.style.update',{id:style.id,enabled:e.target.checked},style.id)}/><span><strong>{style.name}</strong><small>Версия {style.version}</small></span></label>)}</div>
 <div className="library-heading"><h2>Библиотека источников</h2><span className="muted">{catalog.references.length} источников</span></div>
 {catalog.references.map(reference=><details key={reference.id} className="reference"><summary><strong>{reference.name}</strong><span>{new URL(reference.url).hostname}</span><span className="muted">Обзор {reference.viewedAt}</span></summary>
 <div className="reference-body"><dl><dt>Палитра</dt><dd>{reference.palette.join(', ')}</dd><dt>Типографика</dt><dd>{reference.typography}</dd><dt>Плотность</dt><dd>{reference.density}</dd><dt>Что можно адаптировать</dt><dd>{reference.adaptations.join('; ')}</dd></dl>
 <form onSubmit={e=>{e.preventDefault();void update('catalog.reference.update',{id:reference.id,description:String(new FormData(e.currentTarget).get('description'))},reference.id);}}><label>Описание композиции<textarea name="description" defaultValue={reference.description} required maxLength={4000} rows={4}/></label><button disabled={!!busy||!canManage}>{busy===reference.id?'Сохранение…':'Сохранить описание'}</button></form></div></details>)}</div>;
}
