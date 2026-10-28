import React, { useEffect, useState } from 'react';
import type { Site } from '../../../../../packages/contracts/src/model.js';
import type { HistoryEntry } from '../../../../../packages/contracts/src/recovery.js';
import { desktopClient } from '../../lib/desktop-client.js';
export function VersionHistory({ site, canPublish, onChanged, onSource }: {
    site: Site;
    canPublish: boolean;
    onChanged(): void;
    onSource?: (revisionId: string) => void;
}) {
    const [items, setItems] = useState<HistoryEntry[]>([]), [offset, setOffset] = useState(0), [next, setNext] = useState<number | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
    useEffect(() => { let alive = true; setError(''); void desktopClient.request<{
        items: HistoryEntry[];
        nextOffset: number | null;
    }>('site.history', { siteId: site.id, offset }).then(page => { if (alive) {
        setItems(page.items);
        setNext(page.nextOffset);
    } }, error => { if (alive)
        setError(error.message); }); return () => { alive = false; }; }, [site.id, site.revision, offset]);
    async function rollback(revisionId: string) { setBusy(true); setError(''); setMessage(''); try {
        await desktopClient.request('site.rollback', { siteId: site.id, revisionId, expectedRevision: site.revision, requestKey: crypto.randomUUID() });
        setMessage('Создано отдельное действие отката. Статус публикации покажет результат.');
        onChanged();
    }
    catch (error) {
        setError((error as Error).message);
    }
    finally {
        setBusy(false);
    } }
    return <section className="version-history" aria-labelledby="history-title"><div className="settings-heading"><h2 id="history-title">История публикаций</h2><p>Хранятся текущий выпуск и пять предыдущих опубликованных состояний. Черновик сохраняется отдельно.</p></div>{error ? <p className="error-text" role="alert">{error}</p> : null}{message ? <p role="status">{message}</p> : null}
 {!items.length && !error ? <p className="hint">Завершённых публикаций пока нет.</p> : <ol className="history-list">{items.map((item, index) => <li key={item.id}><div><strong>{item.current ? 'Текущая публикация' : `Выпуск ${offset + index + 1}`}</strong><time dateTime={new Date(item.settledAt).toISOString()}>{new Date(item.settledAt).toLocaleString('ru-RU')}</time><span className="hint">{item.revisionId.slice(0, 8)}{item.mode === 'demo' ? ' · демонстрация' : ''}</span>{item.orderingUncertain ? <span className="hint">Порядок старых действий с одинаковым временем не подтверждён</span> : null}{item.settlement !== 'settled' ? <span className="conflict-note">Внешний результат требует сверки</span> : !item.available ? <span className="hint">Исходные файлы очищены; запись сохранена</span> : null}</div><div className="history-actions">{onSource && item.available ? <button onClick={() => onSource(item.revisionId)}>Исходники</button> : null}{canPublish ? <button disabled={busy || item.current || !item.available || !item.retained || item.settlement !== 'settled'} onClick={() => void rollback(item.revisionId)}>Откатить публикацию</button> : null}</div></li>)}</ol>}
 <div className="pagination"><button disabled={!offset || busy} onClick={() => setOffset(Math.max(0, offset - 20))}>Назад</button><button disabled={next === null || busy} onClick={() => setOffset(next!)}>Следующие</button></div></section>;
}
