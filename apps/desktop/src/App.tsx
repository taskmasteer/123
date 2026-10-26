import React,{useEffect,useRef,useState} from 'react';
import {desktopClient} from './lib/desktop-client.js';
import {CreateSiteDialog} from './features/sites/CreateSiteDialog.js';
import {SiteList} from './features/sites/SiteList.js';
import type {DesktopSite} from './features/sites/SiteList.js';
import {ReferenceLibrary} from './features/references/ReferenceLibrary.js';
import type {Catalog} from './features/references/ReferenceLibrary.js';
import './app.css';
type Device={available:boolean;activeJobs:number;maxJobs:number};
export default function App(){
 const [section,setSection]=useState('Сайты'),[sites,setSites]=useState<DesktopSite[]>([]),[catalog,setCatalog]=useState<Catalog>({styles:[],references:[]});
 const [loading,setLoading]=useState(true),[error,setError]=useState(''),[device,setDevice]=useState<Device|null>(null),[creating,setCreating]=useState(false);
 const [preview,setPreview]=useState<DesktopSite|null>(null),[refresh,setRefresh]=useState(0);
 async function loadCatalog(){setCatalog(await desktopClient.request<Catalog>('catalog.list'));}
 useEffect(()=>{void loadCatalog().catch(e=>setError((e as Error).message));},[]);
 useEffect(()=>{let stopped=false,timer:ReturnType<typeof setTimeout>;async function poll(){try{const [list,status]=await Promise.all([desktopClient.request<{items:DesktopSite[]}>('site.list'),desktopClient.request<Device>('device.status')]);if(!stopped){setSites(list.items);setDevice(status);setError('');}}catch(e){if(!stopped){setError((e as Error).message);setDevice(null);}}finally{if(!stopped){setLoading(false);timer=setTimeout(()=>void poll(),600);}}}void poll();return()=>{stopped=true;clearTimeout(timer);};},[refresh]);
 async function action(method:string,site:DesktopSite){try{await desktopClient.request(method,method==='job.retry'?{siteId:site.id}:{siteId:site.id,revisionId:site.publishedId});setRefresh(v=>v+1);}catch(e){setError((e as Error).message);}}
 return <div className="app-shell"><aside className="sidebar"><div className="brand"><span className="brand-mark" aria-hidden="true">▦</span>Site Factory</div><nav aria-label="Разделы">{['Сайты','Референсы','Устройство'].map(name=><button key={name} aria-current={section===name?'page':undefined} onClick={()=>setSection(name)}>{name}</button>)}</nav><div className="sidebar-bottom"><span className={device?'device-dot online':'device-dot'} aria-hidden="true"/><span>{device?'Исполнитель доступен':'Нет связи'}</span><p>Демо — без внешних сервисов</p></div></aside>
 <main><header className="topbar"><div><h1>{section}</h1>{section==='Сайты'?<span className="muted">{sites.length} сайтов в локальном реестре</span>:null}</div>{section==='Сайты'?<button className="primary" onClick={()=>setCreating(true)}>Создать сайт</button>:null}</header>
 <div className="workspace">{error?<div role="alert" className="error-banner"><strong>Не удалось выполнить операцию</strong><span>{error}</span><button onClick={()=>{setRefresh(v=>v+1);void loadCatalog().catch(e=>setError(e.message));}}>Повторить</button></div>:null}
 {section==='Сайты'?<><div className="context-line"><span>Реестр доменов</span><span className="muted">Создание → проверка → локальная версия</span></div><SiteList sites={sites} loading={loading} onPreview={setPreview} onOpen={site=>void action('preview.open',site)} onRetry={site=>void action('job.retry',site)}/><p className="workspace-note">Локальные версии доступны на этом устройстве. Домены и внешний хостинг в демо не подключены.</p></>:section==='Референсы'?<ReferenceLibrary catalog={catalog} onChange={loadCatalog}/>:<section className="device-panel"><h2>{device?'Исполнитель доступен':'Исполнитель недоступен'}</h2><p>Это устройство создаёт и проверяет локальные сайты.</p><dl><dt>Режим</dt><dd>Локальное демо</dd><dt>Активные задания</dt><dd>{device?device.activeJobs+' из '+device.maxJobs:'Нет связи'}</dd><dt>Модель и публикация</dt><dd>Демонстрационные адаптеры, без внешних запросов</dd></dl><p className="hint">При закрытии приложения текущая работа сохраняется. После запуска исполнение продолжится.</p></section>}
 </div></main>{creating?<CreateSiteDialog styles={catalog.styles} onClose={()=>setCreating(false)} onCreated={()=>{setCreating(false);setRefresh(v=>v+1);}}/>:null}
 {preview?<Screenshot site={preview} onClose={()=>setPreview(null)}/>:null}</div>;
}
function Screenshot({site,onClose}:{site:DesktopSite;onClose:()=>void}){
 const ref=useRef<HTMLDialogElement>(null),[width,setWidth]=useState(1440),[url,setUrl]=useState(''),[error,setError]=useState('');
 useEffect(()=>{ref.current?.showModal();},[]);useEffect(()=>{let active=true;setUrl('');setError('');void desktopClient.request<{dataUrl:string}>('preview.screenshot',{siteId:site.id,revisionId:site.publishedId,width}).then(result=>{if(active)setUrl(result.dataUrl);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[site.id,site.publishedId,width]);
 return <dialog ref={ref} className="screenshot-dialog" onCancel={onClose} aria-labelledby="screenshot-title"><div className="preview-header"><div><h2 id="screenshot-title">{site.domain}</h2><p className="muted">Проверенный снимок Chromium</p></div><div className="row-actions">{[375,1440].map(value=><button key={value} aria-pressed={width===value} onClick={()=>setWidth(value)}>{value} px</button>)}<button onClick={onClose} aria-label="Закрыть снимок">Закрыть</button></div></div><div className="screenshot-surface">{error?<p role="alert">{error}</p>:url?<img src={url} alt={'Снимок сайта '+site.domain} style={{maxWidth:width}}/>:<p role="status">Загрузка снимка…</p>}</div></dialog>;
}
