import React,{useEffect,useState} from 'react';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '../../components/ui/dialog.js';
import {Button} from '../../components/ui/button.js';
import {Input} from '../../components/ui/input.js';
import {Textarea} from '../../components/ui/textarea.js';
import {Label} from '../../components/ui/label.js';
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from '../../components/ui/select.js';
import {ReferencePicker} from '../../web/ReferencePicker.js';
import {desktopClient} from '../../lib/desktop-client.js';
import type {Catalog} from '../references/ReferenceLibrary.js';
import type {ImportRowView} from '../../../../../packages/contracts/src/import.js';

export function BatchSiteDialog({row,busy,onClose,onSave}:{row:ImportRowView;busy:boolean;onClose:()=>void;onSave:(value:Record<string,string>)=>Promise<boolean>}){
 const [value,setValue]=useState({domain:row.input.domain,about:row.input.about??'',referenceId:row.input.referenceId??'',layoutReferenceId:row.input.layoutReferenceId??'',mentionedUrl:row.input.mentionedUrl??'',mentionedDescription:row.input.mentionedDescription??''});
 const [catalog,setCatalog]=useState<Catalog|null>(null),[error,setError]=useState('');
 useEffect(()=>{let active=true;void desktopClient.request<Catalog>('catalog.list',{}).then(c=>{if(active)setCatalog(c);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[]);
 const field=(key:keyof typeof value,text:string)=>setValue(v=>({...v,[key]:text}));
 return <Dialog open onOpenChange={open=>{if(!open&&!busy)onClose();}}><DialogContent className="create-dialog" style={{maxHeight:'90vh',overflowY:'auto'}}><DialogHeader><DialogTitle>Изменить сайт</DialogTitle><DialogDescription>Строка {row.rowNumber}. Изменения применятся перед запуском пачки.</DialogDescription></DialogHeader><form onSubmit={e=>{e.preventDefault();setError('');void onSave(value).then(ok=>{if(ok)onClose();else setError('Не удалось сохранить. Пачка могла измениться — закройте окно и откройте строку заново.');});}}>
 <div className="field"><Label htmlFor="row-domain">Домен сайта *</Label><Input id="row-domain" required maxLength={253} value={value.domain} onChange={e=>field('domain',e.target.value)} disabled={busy}/></div>
 <div className="field"><Label htmlFor="row-about">О чём сайт</Label><Textarea id="row-about" maxLength={8000} value={value.about} onChange={e=>field('about',e.target.value)} disabled={busy}/></div>
 <div className="field"><Label>Оформление</Label><Select value={value.referenceId||'auto'} onValueChange={v=>field('referenceId',v==='auto'?'':v)} disabled={busy||!catalog}><SelectTrigger aria-label="Оформление"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="auto">Подобрать автоматически</SelectItem>{catalog?.styles.filter(s=>s.enabled&&!s.id.startsWith('reference-')).map(s=><SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent></Select></div>
 {catalog?<ReferencePicker catalog={catalog} value={value.layoutReferenceId} onChange={v=>field('layoutReferenceId',v)} disabled={busy}/>:<p>Загрузка библиотеки…</p>}
 <div className="mention-section"><div className="field"><Label htmlFor="row-link">Упоминаемая ссылка *</Label><Input id="row-link" type="url" required maxLength={2048} value={value.mentionedUrl} onChange={e=>field('mentionedUrl',e.target.value)} disabled={busy}/></div></div>
 {error?<p role="alert">{error}</p>:null}<div className="dialog-footer"><Button type="button" variant="outline" disabled={busy} onClick={onClose}>Отмена</Button><Button disabled={busy||!catalog}>{busy?'Сохраняем…':'Сохранить изменения'}</Button></div></form></DialogContent></Dialog>;
}
