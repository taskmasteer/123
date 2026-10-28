import { RecoveryPublications } from './RecoveryPublications.js';
import React, { useEffect, useRef, useState } from 'react';
import { archiveCall, awaitArchive, type ArchiveResult } from '../../lib/archive-client.js';
import { desktopClient } from '../../lib/desktop-client.js';
export function BackupSettings({ managed = false, principalId }: {
    managed?: boolean;
    principalId?: string;
}) {
    const [passphrase, setPassphrase] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState(''), [result, setResult] = useState<ArchiveResult | null>(null), [mappings, setMappings] = useState<Record<string, string>>({}), [quarantined, setQuarantined] = useState(false), active = useRef<AbortController | null>(null), handleId = useRef<string | null>(null), [retired, setRetired] = useState(false), [hasPending, setHasPending] = useState(true);
    useEffect(() => { void desktopClient.request<{
        quarantined: boolean;
    }>('recovery.status').then(r => setQuarantined(r.quarantined)).catch(() => { }); return () => { active.current?.abort(); if (handleId.current)
        void archiveCall({ action: 'close', id: handleId.current }).catch(() => { }); }; }, [managed, principalId]);
    async function begin(action: 'backup' | 'inspect') { const secret = passphrase; setPassphrase(''); setBusy(true); setError(''); setResult(null); setMessage(''); const controller = new AbortController(); active.current?.abort(); active.current = controller; try {
        if (handleId.current)
            await archiveCall({ action: 'close', id: handleId.current }).catch(() => { });
        const operation = await archiveCall<{
            id: string;
        }>({ action, passphrase: secret });
        handleId.current = operation.id;
        const ready = await awaitArchive(operation.id, controller.signal, setMessage);
        if (controller.signal.aborted)
            return;
        setResult(ready);
        if (ready.users)
            setMappings(Object.fromEntries(ready.users.map(u => [u.id, u.id === principalId ? u.id : ''])));
        setMessage(action === 'backup' ? 'Независимая зашифрованная копия готова к сохранению.' : 'Пароль, структура и хэши файлов проверены.');
    }
    catch (error) {
        if (!controller.signal.aborted)
            setError((error as Error).message);
    }
    finally {
        if (!controller.signal.aborted)
            setBusy(false);
    } }
    async function restore() { if (!result?.inspectionId)
        return; setBusy(true); setError(''); const controller = new AbortController(); active.current = controller; try {
        if (managed) {
            const all = (result.users ?? []).map(u => ({ sourceId: u.id, destinationId: mappings[u.id] ?? '' }));
            for (let start = 0; start < all.length; start += 50)
                await archiveCall({ action: 'map', id: result.inspectionId, mappings: all.slice(start, start + 50) });
        }
        const operation = await archiveCall<{
            id: string;
        }>({ action: 'restore', id: result.inspectionId, mappings: [] });
        const previous = handleId.current;
        handleId.current = operation.id;
        const ready = await awaitArchive(operation.id, controller.signal, setMessage);
        if (previous)
            await archiveCall({ action: 'close', id: previous }).catch(() => { });
        if (controller.signal.aborted)
            return;
        setResult(ready);
        setQuarantined(true);
        setMessage(`Восстановлено сайтов: ${ready.restoredSites ?? 0}. ${ready.restartRequired ? 'Перезапустите приложение. ' : ''}Возобновление заданий требует отдельной проверки.`);
    }
    catch (error) {
        if (!controller.signal.aborted)
            setError((error as Error).message);
    }
    finally {
        if (!controller.signal.aborted)
            setBusy(false);
    } }
    async function save() { if (!result?.handle)
        return; try {
        await archiveCall({ action: 'save', id: result.handle.id });
        await archiveCall({ action: 'close', id: result.handle.id });
        handleId.current = null;
        setResult(null);
        setMessage('Копия сохранена в выбранном месте.');
    }
    catch (error) {
        setError((error as Error).message);
    } }
    async function release() { setError(''); try {
        await desktopClient.request('recovery.release', managed ? { retiredSourceAuthority: retired } : {});
        setQuarantined(false);
        setMessage('Проверка установки подтверждена. Приостановленные задания можно возобновить явным действием.');
    }
    catch (error) {
        setError((error as Error).message);
    } }
    return <section className="backup-settings" aria-labelledby="backup-title"><div className="settings-heading"><h2 id="backup-title">Независимая резервная копия</h2><p>Сайты, история, проверки и закреплённые материалы сохраняются в одном зашифрованном файле. Служебные ключи и входы пользователей переносятся отдельно.</p></div><p className="hint">Копия восстанавливается в пустую установку того же типа: {managed ? 'управляемую' : 'локальную'}. Версии в R2 не заменяют этот файл.</p><form onSubmit={event => { event.preventDefault(); void begin('backup'); }}><label htmlFor="backup-passphrase">Пароль копии</label><input id="backup-passphrase" type="password" autoComplete="new-password" spellCheck={false} maxLength={256} value={passphrase} onChange={event => setPassphrase(event.target.value)} placeholder="Введите парольную фразу"/><p className="hint">Пароль не сохраняется. Для проверки существующей копии введите её пароль.</p><div className="settings-actions"><button className="primary" type="submit" disabled={busy || passphrase.length < 8}>Создать копию</button><button type="button" disabled={busy || passphrase.length < 8} onClick={() => void begin('inspect')}>Проверить и восстановить копию</button></div></form>
 {result?.handle ? <div className="backup-ready"><strong>Копия проверена</strong><p>{result.handle.size.toLocaleString('ru-RU')} Б</p><code>SHA-256: {result.handle.sha256}</code><button disabled={busy} onClick={() => void save()}>Сохранить файл…</button></div> : null}
 {result?.inspectionId ? <div className="restore-review"><h3>Восстановление в пустую установку</h3><p>Рабочая база сохранится. Восстановленные задания останутся приостановлены; завершённые задания сохранят свой статус.</p>{managed ? <><p>Укажите подтверждённые Auth ID пользователей новой установки. Приглашения выполняются отдельно.</p><div className="restore-mappings">{(result.users ?? []).map(user => <label key={user.id}>{user.email ?? user.id}<small>Исходный ID: {user.id}</small><input value={mappings[user.id] ?? ''} onChange={event => setMappings(current => ({ ...current, [user.id]: event.target.value }))} placeholder="Подтверждённый Auth UUID назначения"/></label>)}</div></> : null}<button className="primary" disabled={busy || (managed && (result.users ?? []).some(u => !mappings[u.id]))} onClick={() => void restore()}>Восстановить проверенную копию</button></div> : null}
 {quarantined ? <div className="restore-review"><h3>Установка приостановлена после восстановления</h3><p>Повторно подключите рабочие устройства и проверьте владельцев сайтов. Неизвестные внешние публикации и аккаунты должны быть сверены по инструкции восстановления.</p>{managed ? <><p>Обычные устройства входят в тот же управляющий API. Перед запуском восстановленной установки отключите прежний управляющий API и отзовите или замените его ключи провайдеров: разные базы не разделяют блокировки.</p><label><input type="checkbox" checked={retired} onChange={event => setRetired(event.target.checked)}/>Прежний управляющий API отключён, ключи и неизвестные внешние действия сверены</label><RecoveryPublications retired={retired} onPending={setHasPending}/></> : null}<button disabled={busy || (managed && (!retired || hasPending))} onClick={() => void release()}>Проверка завершена — разрешить работу</button></div> : null}
 {busy ? <p role="status">{message || 'Подготовка копии…'}</p> : message ? <p role="status">{message}</p> : null}{error ? <p className="error-text" role="alert">{error}</p> : null}</section>;
}
