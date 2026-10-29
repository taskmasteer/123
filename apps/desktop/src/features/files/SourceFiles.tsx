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
    }[]>([]), [path, setPath] = useState<string | null>(null), [text, setText] = useState(''), [offset, setOffset] = useState<number | null>(0), [error, setError] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), decoder = useRef(new TextDecoder()), alive = useRef(true), sequence = useRef(0);
    useEffect(() => {
        const scope = ++sequence.current;
        alive.current = true;
        setFiles([]);
        setPath(null);
        setText('');
        setOffset(0);
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
    async function read(selected: string, next = 0) {
        const token = ++sequence.current;
        setBusy(true);
        setError('');
        try {
            const file = await desktopClient.request<{
                base64: string;
                nextOffset: number | null;
            }>('source.read', { siteId, revisionId, path: selected, offset: next }), bytes = Uint8Array.from(atob(file.base64), c => c.charCodeAt(0));
            if (!alive.current || token !== sequence.current)
                return;
            if (next === 0) {
                decoder.current = new TextDecoder('utf8');
                setText(decoder.current.decode(bytes, { stream: file.nextOffset !== null }));
            }
            else
                setText(current => current + decoder.current.decode(bytes, { stream: file.nextOffset !== null }));
            setOffset(file.nextOffset);
        }
        catch (error) {
            if (alive.current && token === sequence.current)
                setError((error as Error).message);
        }
        finally {
            if (alive.current && token === sequence.current)
                setBusy(false);
        }
    }
    async function download(file?: string) {
        setBusy(true);
        setError('');
        const signal = new AbortController();
        let id: string | undefined;
        try {
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
    const plain = path && /\.(html|css|js)$/i.test(path);
    return <section className="source-files" aria-labelledby="source-title"><div className="settings-heading"><h2 id="source-title">Исходные файлы</h2><p>Оригинальные байты версии {revisionId.slice(0, 8)}. Доступ администратора.</p></div><button disabled={busy} onClick={() => void download()}>Скачать ZIP исходников</button>{error ? <p className="error-text" role="alert">{error}</p> : null}{message ? <p className="hint" role="status">{message}</p> : null}<div className="source-layout"><ul className="source-tree" aria-label="Дерево файлов">{files.map(file => <li key={file.path}><button aria-current={path === file.path ? 'true' : undefined} disabled={busy} style={{ paddingLeft: 12 + file.path.split('/').length * 8 }} onClick={() => {
                setPath(file.path);
                setText('');
                setOffset(0);
                if (/\.(html|css|js)$/i.test(file.path))
                    void read(file.path);
            }}><span>{file.path}</span><small>{file.size.toLocaleString('ru-RU')} Б</small></button></li>)}</ul><div className="source-content">{path ? <><div className="source-toolbar"><code>{path}</code><button disabled={busy} onClick={() => void download(path)}>Скачать файл</button></div>{plain ? <><pre tabIndex={0}>{text || (offset === null ? 'Файл пуст.' : 'Чтение файла…')}</pre>{offset !== null ? <button disabled={busy} onClick={() => void read(path, offset)}>Прочитать дальше</button> : null}</> : <p className="hint">Двоичный файл. Скачайте его для просмотра.</p>}</> : <p className="hint">Выберите файл в дереве.</p>}</div></div></section>;
}
