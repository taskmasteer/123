import React, { useEffect, useRef, useState } from 'react';
import { desktopClient } from '../../lib/desktop-client.js';
import { archiveCall, awaitArchive } from '../../lib/archive-client.js';
export function SourceFiles({ siteId, revisionId }: {
    siteId: string;
    revisionId: string;
}) {
    const [files, setFiles] = useState<{
        path: string;
        size: number;
    }[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), alive = useRef(true), sequence = useRef(0);
    useEffect(() => {
        const scope = ++sequence.current;
        alive.current = true;
        setFiles([]);
        setError('');
        void desktopClient.request<{
            files: {
                path: string;
                size: number;
            }[];
        }>('source.list', { siteId, revisionId }).then(r => {
            if (alive.current && scope === sequence.current)
                setFiles(r.files);
        }, e => {
            if (alive.current && scope === sequence.current)
                setError(e.message);
        });
        return () => { alive.current = false; sequence.current++; };
    }, [siteId, revisionId]);
    async function download(file?: string) {
        setBusy(true);
        setError('');
        const signal = new AbortController();
        let id: string | undefined;
        try {
            if(window.factoryDesktop){await window.factoryDesktop.download(siteId,revisionId,file);setMessage('Выбор места сохранения завершён.');return;}
            if(!('__TAURI_INTERNALS__' in window)){
                const name=file?.split('/').at(-1)??`site-${siteId}.zip`;
                const picker=(window as any).showSaveFilePicker;
                const handle=picker?await picker.call(window,{suggestedName:name}):null;
                const query=new URLSearchParams({revisionId,...(file?{path:file}:{})});
                const response=await fetch(`/api/sites/${siteId}/download?${query}`,{credentials:'same-origin',redirect:'error'});
                if(!response.ok)throw new Error((await response.json()).error?.message??'Не удалось скачать файл.');
                const blob=await response.blob();
                if(handle){const writer=await handle.createWritable();await writer.write(blob);await writer.close();}
                else{const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
                setMessage('Файл передан для сохранения.');return;
            }
            const operation = await archiveCall<{
                id: string;
            }>({ action: file ? 'file' : 'source', siteId, revisionId, ...(file ? { path: file } : {}) });
            id = operation.id;
            const result = await awaitArchive(operation.id, signal.signal, setMessage);
            if (!alive.current)
                return;
            await archiveCall({ action: 'save', id: result.handle!.id });
            setMessage('Файл сохранён в выбранном месте.');
        }
        catch (error) {
            if (alive.current)
                setError((error as Error).message);
        }
        finally {
            if (id)
                await archiveCall({ action: 'close', id }).catch(() => { });
            if (alive.current)
                setBusy(false);
        }
    }
    return <section className="source-files" aria-labelledby="source-title"><div className="settings-heading"><h2 id="source-title">Исходные файлы</h2></div><button disabled={busy} onClick={()=>void download()}>Скачать ZIP исходников</button>{error?<p role="alert">{error}</p>:null}{message?<p role="status">{message}</p>:null}<div className="source-file-cards">{files.map(file=><button className="source-file-card" key={file.path} disabled={busy} onClick={()=>void download(file.path)} title={'Скачать '+file.path}><strong>{file.path}</strong><span>{file.size.toLocaleString('ru-RU')} Б · Скачать</span></button>)}</div></section>;
}
