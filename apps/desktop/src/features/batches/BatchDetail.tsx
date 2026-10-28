import React, { useEffect, useRef, useState } from 'react';
import { desktopClient } from '../../lib/desktop-client.js';
import type { ImportSummary, ImportRowView, ImportPage } from '../../../../../packages/contracts/src/import.js';
import { BatchImport, uploadImportFile } from './BatchImport.js';
import { BatchTable } from './BatchTable.js';
export function BatchDetail({ id, onBack, admin = false }: {
    id: string;
    onBack: () => void;
    admin?: boolean;
}) {
    const [summary, setSummary] = useState<ImportSummary | null>(null), [rows, setRows] = useState<ImportRowView[]>([]), [error, setError] = useState(''), [pollError, setPollError] = useState(''), [busy, setBusy] = useState(false), [version, setVersion] = useState(0);
    const [cursors, setCursors] = useState<(string | null)[]>([null]), [next, setNext] = useState<string | null>(null), [status, setStatus] = useState('all'), [edit, setEdit] = useState<ImportRowView | null>(null), [about, setAbout] = useState(''), [domain, setDomain] = useState(''), [assignees, setAssignees] = useState<string[]>([]), [users, setUsers] = useState<{
        id: string;
        email: string;
        active: boolean;
    }[]>([]), [usersError, setUsersError] = useState(''), [editRevision, setEditRevision] = useState(0);
    const mounted = useRef(true);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const key = useRef(crypto.randomUUID()), cursor = cursors.at(-1) ?? null;
    useEffect(() => {
        let stopped = false, timer: ReturnType<typeof setTimeout>;
        async function poll() {
            try {
                const [s, p] = await Promise.all([desktopClient.request<ImportSummary>('batch.get', { id }), desktopClient.request<ImportPage>('batch.rows', { id, status, ...(cursor ? { cursor } : {}) })]);
                if (!stopped) {
                    setSummary(s);
                    setRows(p.items);
                    setNext(p.nextCursor);
                    setPollError('');
                }
            }
            catch (e) {
                if (!stopped)
                    setPollError((e as Error).message);
            }
            finally {
                if (!stopped)
                    timer = setTimeout(() => void poll(), 1500);
            }
        }
        void poll();
        return () => { stopped = true; clearTimeout(timer); };
    }, [id, cursor, status, version]);
    async function action(method: string, params: Record<string, unknown>) {
        setBusy(true);
        setError('');
        try {
            await desktopClient.request(method, params);
            if (mounted.current)
                setVersion(v => v + 1);
            return true;
        }
        catch (e) {
            if (mounted.current)
                setError((e as Error).message);
            return false;
        }
        finally {
            if (mounted.current)
                setBusy(false);
        }
    }
    useEffect(() => { if (!admin)
        return; let stopped = false; void desktopClient.request<{
        id: string;
        email: string;
        active: boolean;
    }[]>('admin.users').then(list => { if (!stopped)
        setUsers(list.filter(u => u.active)); }).catch(e => { if (!stopped)
        setUsersError(e.message); }); return () => { stopped = true; }; }, [admin, id]);
    useEffect(() => { if (summary?.assignedUserIds)
        setAssignees(summary.assignedUserIds); }, [summary?.assignedUserIds?.join(',')]);
    const editable = summary?.state === 'preview' && summary.canControl;
    return <section className="batch-detail"><button onClick={onBack}>Все пачки</button><h2>{summary?.name ?? 'Загрузка пачки…'}</h2>{summary ? <><p>Корректных строк: {summary.validCount}. С ошибками: {summary.invalidCount}.</p><div className="row-actions">{editable ? <button className="primary" disabled={busy || !summary.validCount} onClick={() => void action('import.commit', { id, revision: summary.revision, requestKey: key.current })}>Запустить корректные строки</button> : summary.canControl ? <>{summary.state === 'active' ? <button disabled={busy} onClick={() => void action('batch.pause', { id })}>Пауза пачки</button> : summary.state === 'paused' ? <button disabled={busy} onClick={() => void action('batch.resume', { id })}>Продолжить пачку</button> : null}{!['cancelled', 'preview'].includes(summary.state) ? <button disabled={busy} onClick={() => void action('batch.cancel', { id })}>Отменить пачку</button> : null}</> : <span>Доступ к просмотру пачки</span>}</div><p className="hint">Корректные строки запускаются отдельно. Строки с ошибками остаются здесь. Пауза действует на границе сохранённого этапа; продолжение не повторяет завершённые или неудачные задания.</p></> : null}
 {pollError ? <p role="alert">Не удалось обновить пачку: {pollError}</p> : null}{error ? <p role="alert">{error}</p> : null}<label className="batch-filter">Показать строки<select value={status} onChange={e => { setStatus(e.target.value); setCursors([null]); setRows([]); }}><option value="all">Все</option><option value="invalid">С ошибками</option><option value="valid">Без ошибок</option></select></label>
 <BatchTable rows={rows} editable={!!editable} busy={busy} {...(summary?.canControl && summary.state === 'active' ? { onRetry: (row: ImportRowView) => void action('batch.retry', { id, rowNumber: row.rowNumber }) } : {})} onEdit={row => { setEditRevision(summary?.revision ?? 0); setEdit(row); setAbout(row.input.about ?? ''); setDomain(row.input.domain); }} onLogo={(row, file) => {
            if (!summary)
                return;
            setBusy(true);
            setError('');
            void uploadImportFile(file, { draftId: id, rowNumber: row.rowNumber, revision: summary.revision }).then(asset => desktopClient.request('logo.complete', { id: asset })).then(() => {
                if (mounted.current)
                    setVersion(v => v + 1);
            }).catch(e => {
                if (mounted.current)
                    setError(e.message);
            }).finally(() => {
                if (mounted.current)
                    setBusy(false);
            });
        }}/>
 <nav className="row-actions" aria-label="Страницы строк"><button disabled={busy || cursors.length === 1} onClick={() => setCursors(c => c.slice(0, -1))}>Предыдущие строки</button><span>Страница {cursors.length}</span><button disabled={busy || !next} onClick={() => {
            if (next)
                setCursors(c => [...c, next]);
        }}>Следующие строки</button></nav>
 {edit && summary ? <form className="device-panel batch-row-edit" onSubmit={e => {
                e.preventDefault();
                void action('import.update', { id, revision: editRevision, rowNumber: edit.rowNumber, domain, about }).then(saved => {
                    if (saved)
                        setEdit(null);
                });
            }}><h3>Строка {edit.rowNumber}</h3><label>Домен в строке {edit.rowNumber}<input value={domain} maxLength={253} onChange={e => setDomain(e.target.value)}/></label><label>О сайте в строке {edit.rowNumber}<textarea value={about} maxLength={8000} onChange={e => setAbout(e.target.value)}/></label><div className="row-actions"><button disabled={busy}>Сохранить строку</button><button type="button" onClick={() => setEdit(null)}>Закрыть правку</button></div></form> : null}
 {admin ? <form className="device-panel" onSubmit={e => { e.preventDefault(); void action('batch.assign', { id, userIds: assignees }); }}><h3>Доступ к пачке</h3><p>Назначение пачки даёт доступ ко всем её текущим и будущим сайтам. Управление генерацией остаётся у владельца и администратора.</p><label>Пользователи с доступом<select multiple value={assignees} onChange={e => setAssignees(Array.from(e.target.selectedOptions, option => option.value))}>{users.map(user => <option key={user.id} value={user.id}>{user.email}</option>)}</select></label>{usersError ? <p role="alert">Не удалось загрузить пользователей: {usersError}</p> : null}<button disabled={busy || !!usersError}>Сохранить доступ к пачке</button></form> : null}
 </section>;
}
export function Batches({ admin = false }: {
    admin?: boolean;
}) {
    const [id, setId] = useState<string | null>(null), [items, setItems] = useState<ImportSummary[]>([]), [error, setError] = useState(''), [cursor, setCursor] = useState<string | null>(null), [next, setNext] = useState<string | null>(null);
    useEffect(() => {
        if (id)
            return;
        let stopped = false;
        void desktopClient.request<{
            items: ImportSummary[];
            nextCursor: string | null;
        }>('batch.list', cursor ? { cursor } : {}).then(p => {
            if (!stopped) {
                setItems(p.items);
                setNext(p.nextCursor);
            }
        }).catch(e => {
            if (!stopped)
                setError(e.message);
        });
        return () => { stopped = true; };
    }, [id, cursor]);
    if (id)
        return <BatchDetail key={id} id={id} admin={admin} onBack={() => setId(null)}/>;
    return <><BatchImport onPrepared={summary => setId(summary.id)}/><section className="device-panel"><h2>Пачки сайтов</h2>{error ? <p role="alert">{error}</p> : null}{items.map(item => <button key={item.id} className="batch-summary" onClick={() => setId(item.id)}>{item.name} — строк: {item.total}, с ошибками: {item.invalidCount}</button>)}{!items.length ? <p>Пачек пока нет.</p> : null}<div className="row-actions"><button disabled={!cursor} onClick={() => setCursor(null)}>Первая страница пачек</button><button disabled={!next} onClick={() => setCursor(next)}>Следующие пачки</button></div></section></>;
}
