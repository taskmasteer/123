import React, { useEffect, useState } from 'react';
import { desktopClient } from '../../lib/desktop-client.js';
interface PendingPublication {
    id: string;
    siteId: string;
    domain: string;
    accountId: string | null;
    attached: boolean;
    digest: string;
}
const reasons: Record<string, string> = { 'configured-account-mismatch': 'Настроенный аккаунт отличается от исходного.', 'unverified-configured-account': 'Не удалось подтвердить настроенный аккаунт.', 'configured-account-changed': 'Аккаунт изменился во время проверки.', 'missing-frozen-project': 'В исходной записи нет подтверждённого проекта.', 'unattached-reservation-needs-manual-proof': 'Действие не было связано с подтверждённой записью провайдера.', 'ambiguous-deployments': 'Найдено несколько подходящих размещений.', 'no-positive-deployment-proof': 'Нет положительного доказательства размещения.', 'deployment-list-incomplete': 'Список провайдера слишком велик для одной безопасной сверки.', 'deployment-not-terminal': 'Провайдер ещё не завершил размещение.', 'public-alias-not-confirmed': 'Публичный адрес не указывает на ожидаемую версию.', 'provider-or-public-proof-unavailable': 'Провайдер или публичная проверка пока недоступны.', 'site-binding-changed': 'Состояние сайта изменилось после исходного действия.', 'publication-admission-missing': 'В исходной записи не сохранилось право завершить действие.' };
export function RecoveryPublications({ retired, onPending }: {
    retired: boolean;
    onPending(value: boolean): void;
}) {
    const [items, setItems] = useState<PendingPublication[]>([]), [restoreId, setRestoreId] = useState<string | null>(null), [offset, setOffset] = useState(0), [next, setNext] = useState<number | null>(null), [refresh, setRefresh] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
    useEffect(() => { let alive = true; void desktopClient.request<{
        restoreId: string | null;
        items: PendingPublication[];
        nextOffset: number | null;
        remaining: number;
    }>('recovery.publications', { offset }).then(page => { if (!alive)
        return; setItems(page.items); setRestoreId(page.restoreId); setNext(page.nextOffset); onPending(page.remaining > 0); }, error => { if (alive) {
        onPending(true);
        setError(error.message);
    } }); return () => { alive = false; }; }, [offset, refresh, onPending]);
    async function reconcile(item: PendingPublication) { if (!restoreId)
        return; setBusy(true); setError(''); setMessage(''); try {
        const result = await desktopClient.request<{
            status: string;
            reason?: string;
        }>('recovery.reconcile', { restoreId, id: item.id, digest: item.digest, retiredSourceAuthority: retired });
        if (result.status === 'manual-required')
            setMessage((reasons[result.reason ?? ''] ?? 'Исходные привязки или доказательства не подтверждены.') + ' Требуется ручная проверка по инструкции; установка остаётся приостановлена.');
        else {
            setMessage(result.status === 'settled' ? 'Публичная версия подтверждена. Исходное действие завершено в журнале.' : 'Провайдер подтвердил неуспешное завершение. Действие отменено в журнале.');
            setRefresh(v => v + 1);
        }
    }
    catch (error) {
        setError((error as Error).message);
        setRefresh(v => v + 1);
    }
    finally {
        setBusy(false);
    } }
    return <section className="recovery-publications" aria-labelledby="recovery-publications-title"><h3 id="recovery-publications-title">Сверка внешних публикаций</h3><p>Сервер читает данные настроенного провайдера и проверяет публичный сайт. Подтверждённый результат записывается в журнале; новые размещения и продвижение версий не выполняются.</p>{items.length ? <ul>{items.map(item => <li key={item.id}><strong>{item.domain}</strong><p className="hint">Аккаунт: {item.accountId ?? 'исходная привязка отсутствует'} · действие {item.id.slice(0, 8)}</p><button disabled={busy || !retired} onClick={() => void reconcile(item)}>Сверить публикацию</button></li>)}</ul> : !error ? <p className="hint">Неразрешённых внешних действий на этой странице нет.</p> : null}<div className="pagination"><button disabled={!offset || busy} onClick={() => setOffset(Math.max(0, offset - 20))}>Назад</button><button disabled={next === null || busy} onClick={() => setOffset(next!)}>Следующие</button></div>{message ? <p role="status">{message}</p> : null}{error ? <p className="error-text" role="alert">{error}</p> : null}</section>;
}
