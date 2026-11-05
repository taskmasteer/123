import {Button} from '../../components/ui/button.js';
import {Input} from '../../components/ui/input.js';
import {Textarea} from '../../components/ui/textarea.js';
import {Label} from '../../components/ui/label.js';
import type {Catalog} from '../references/ReferenceLibrary.js';
import React, { useState, useRef } from 'react';
import { desktopClient } from '../../lib/desktop-client.js';
import type { ImportSummary } from '../../../../../packages/contracts/src/import.js';
import { importLimits } from '../../../../../packages/contracts/src/import.js';
/** File input grants bytes through the browser/native picker; no arbitrary path reaches the worker. */
export async function uploadImportFile(file: File, extra: Record<string, unknown> = {}, progress?: (text: string) => void) {
    if (file.size < 1 || file.size > (extra.draftId ? 2000000 : importLimits.sourceBytes))
        throw new Error('Выберите файл допустимого размера: CSV/XLSX до 16 МБ, PNG до 2 МБ.');
    const source = await file.arrayBuffer(), digest = await crypto.subtle.digest('SHA-256', source), sha256 = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
    const { id } = await desktopClient.request<{
        id: string;
    }>('resource.begin', { name: file.name, size: file.size, sha256, ...extra });
    for (let offset = 0; offset < file.size; offset += importLimits.chunkBytes) {
        const bytes = new Uint8Array(source.slice(offset, offset + importLimits.chunkBytes));
        let binary = '';
        for (const byte of bytes)
            binary += String.fromCharCode(byte);
        await desktopClient.request('resource.chunk', { id, index: offset / importLimits.chunkBytes, base64: btoa(binary) });
        progress?.(`Загрузка: ${Math.min(100, Math.round((offset + bytes.length) / file.size * 100))}%`);
    }
    return id;
}
export function BatchImport({onPrepared}:{onPrepared:(summary:ImportSummary)=>void}){
 const fileInput=useRef<HTMLInputElement>(null);
 const [domains,setDomains]=useState(''),[link,setLink]=useState(''),[description,setDescription]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function prepare(file:File){const id=await uploadImportFile(file);onPrepared(await desktopClient.request<ImportSummary>('import.prepare',{id}));}
 async function submit(e:React.FormEvent){e.preventDefault();setBusy(true);setError('');try{
  const list=domains.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);if(!list.length||list.length>importLimits.rows)throw Error('Введите от 1 до 5000 доменов, каждый с новой строки.');
  const catalog=await desktopClient.request<Catalog>('catalog.list',{}),styles=catalog.styles.filter(s=>s.enabled&&!s.id.startsWith('reference-')),refs=catalog.references.filter(r=>catalog.styles.some(s=>s.enabled&&s.id==='reference-'+r.id));
  if(!styles.length||!refs.length)throw Error('В библиотеке должны быть доступны оформление и референсы.');
  const pick=<T,>(items:T[])=>items[crypto.getRandomValues(new Uint32Array(1))[0]!%items.length]!;
  const quote=(v:string)=>'"'+v.replaceAll('"','""')+'"';
  const csv=['domain,referenceId,layoutReferenceId,mentionedUrl,mentionedDescription',...list.map(domain=>[domain,pick(styles).id,pick(refs).id,link.trim(),description.trim()].map(quote).join(','))].join('\n');
  await prepare(new File([csv],'Список доменов.csv',{type:'text/csv'}));
 }catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 return <section className="settings-card batch-import"><div className="batch-import-heading"><h2>Создать пачку сайтов</h2><Button variant="outline" disabled={busy} onClick={()=>fileInput.current?.click()}>Импорт CSV / XLSX</Button><input ref={fileInput} hidden aria-label="Файл CSV или XLSX" type="file" accept=".csv,.xlsx" disabled={busy} onChange={e=>{const file=e.target.files?.[0];if(file){setBusy(true);setError('');void prepare(file).catch(e=>setError(e.message)).finally(()=>setBusy(false));}e.target.value='';}}/></div><p>Введите домены по одному в строке. Для каждого случайно выберем оформление и референс из библиотеки. Перед запуском любые данные можно изменить.</p><form onSubmit={e=>void submit(e)}><div className="field"><Label htmlFor="batch-domains">Список доменов</Label><Textarea id="batch-domains" value={domains} onChange={e=>setDomains(e.target.value)} rows={7} required disabled={busy} placeholder={'first.example\nsecond.example'}/></div><div className="field"><Label htmlFor="batch-link">Общая упоминаемая ссылка *</Label><Input id="batch-link" type="url" value={link} onChange={e=>setLink(e.target.value)} required maxLength={2048} disabled={busy}/></div><Button disabled={busy}>{busy?'Готовим пачку…':'Подготовить сайты'}</Button></form>{error?<p role="alert">{error}</p>:null}</section>;
}
