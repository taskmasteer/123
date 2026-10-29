import React, { useState } from 'react';
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
export function BatchImport({ onPrepared }: {
    onPrepared: (summary: ImportSummary) => void;
}) {
    const [paste,setPaste]=useState(''),[domain,setDomain]=useState(''),[about,setAbout]=useState(''),[rows,setRows]=useState<{domain:string;about:string}[]>([]);
    const [busy, setBusy] = useState(false), [error, setError] = useState(''), [progress, setProgress] = useState('');
    async function choose(file: File) {
        setBusy(true);
        setError('');
        try {
            const id = await uploadImportFile(file, {}, setProgress);
            setProgress('Проверка строк…');
            onPrepared(await desktopClient.request<ImportSummary>('import.prepare', { id }));
        }
        catch (e) {
            setError((e as Error).message);
        }
        finally {
            setBusy(false);
            setProgress('');
        }
    }
    function stage(values: {domain:string;about:string}[], name:string) {
        if (!values.length || values.length > importLimits.rows) { setError('Введите от 1 до 5000 строк.'); return; }
        const quote=(value:string)=>'"'+value.replaceAll('"','""')+'"';
        void choose(new File(['domain,about\n'+values.map(row=>quote(row.domain)+','+quote(row.about)).join('\n')],name,{type:'text/csv'}));
    }
    return <section className="device-panel batch-import"><h2>Импорт сайтов</h2><p>CSV или один лист XLSX, до 5000 строк. Столбцы: domain, about, referenceId, logo. Для каждого сайта можно отдельно изменить «О сайте».</p><label>Файл CSV или XLSX<input type="file" accept=".csv,.xlsx" disabled={busy} onChange={e => {
            const file = e.target.files?.[0];
            if (file)
                void choose(file);
            e.target.value = '';
        }}/></label><label>Список доменов<textarea value={paste} maxLength={1500000} disabled={busy} onChange={e=>setPaste(e.target.value)} placeholder="Один домен в строке"/></label><button disabled={busy||!paste.trim()} onClick={()=>stage(paste.split(/\r?\n/).filter(line=>line.trim()).map(line=>({domain:line.trim(),about:''})),'pasted.csv')}>Проверить список</button>
        <fieldset disabled={busy}><legend>Добавить сайты вручную</legend><label>Домен новой строки<input value={domain} maxLength={253} onChange={e=>setDomain(e.target.value)}/></label><label>О сайте новой строки<textarea value={about} maxLength={8000} onChange={e=>setAbout(e.target.value)}/></label><button disabled={!domain.trim()||rows.length>=importLimits.rows} onClick={()=>{setRows(current=>[...current,{domain,about}]);setDomain('');setAbout('');}}>Добавить строку</button><ol>{rows.map((row,index)=><li key={index}>{row.domain}<button onClick={()=>setRows(current=>current.filter((_,i)=>i!==index))}>Удалить строку {index+1}</button></li>)}</ol><button disabled={!rows.length} onClick={()=>stage(rows,'manual.csv')}>Проверить строки</button></fieldset>
        <p className="hint">В logo укажите имя локального PNG. Выбор файла выполняется отдельно для каждой строки. Формулы и внешние связи не принимаются.</p>{progress ? <p role="status">{progress}</p> : null}{error ? <p role="alert">{error}</p> : null}</section>;
}
