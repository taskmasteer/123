import {publicationDiagnosticCaptions} from '../../../../../packages/contracts/src/publication.js';
import React, { useEffect, useRef, useState } from 'react';
import type { Principal, Site } from '../../../../../packages/contracts/src/model.js';
import type { PublicationView, DomainSetup } from '../../../../../packages/contracts/src/publication.js';
import { desktopClient } from '../../lib/desktop-client.js';
const phases: Record<PublicationView['phase'], string> = { pending: 'Подготовка публикации', uploading: 'Передача файлов', creating: 'Создание размещения', checking: 'Проверка размещения', promoting: 'Переключение домена', reconciling: 'Уточнение результата', waiting_quota: 'Ожидание лимита хостинга', awaiting_dns: 'Ожидание DNS и HTTPS', published: 'Опубликовано', needs_attention: 'Требуется проверка' };
export function PublicationPanel({ site, principal, onChanged }: {
    site: Site;
    principal: Principal;
    onChanged: () => void;
}) {
    const [value, setValue] = useState<{
        publication: PublicationView | null;
        domain: DomainSetup;
    } | null>(null), [pollError, setPollError] = useState(''), [actionError, setActionError] = useState(''), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
    const request = useRef<{
        revision: string;
        key: string;
    } | null>(null);
    useEffect(() => { let stopped = false; let timer: ReturnType<typeof setTimeout>; async function poll() { try {
        const next = await desktopClient.request<typeof value>('publication.status', { siteId: site.id });
        if (!stopped) {
            setValue(next);
            setPollError('');
        }
    }
    catch (e) {
        if (!stopped)
            setPollError((e as Error).message);
    }
    finally {
        if (!stopped)
            timer = setTimeout(() => void poll(), 3000);
    } } void poll(); return () => { stopped = true; clearTimeout(timer); }; }, [site.id, refresh]);
    const publication = value?.publication;
    const error = actionError || pollError;
    const canEdit = principal.role !== 'user' && (principal.role === 'admin' || site.ownerId === principal.userId || site.assignedUserIds.includes(principal.userId));
    const canResume = publication?.origin === 'generation' ? (principal.role === 'admin' || site.ownerId === principal.userId) : canEdit;
    async function act(resume: boolean) {
        setBusy(true);
        try {
            if (resume)
                await desktopClient.request('publication.resume', { siteId: site.id, id: publication!.id });
            else {
                if (!request.current || request.current.revision !== site.draftId)
                    request.current = { revision: site.draftId!, key: crypto.randomUUID() };
                await desktopClient.request('publication.request', { siteId: site.id, revisionId: site.draftId, expectedRevision: site.revision, requestKey: request.current.key });
            }
            setActionError('');
            setRefresh(v => v + 1);
            onChanged();
        }
        catch (e) {
            setActionError((e as Error).message);
        }
        finally {
            setBusy(false);
        }
    }
    return <section className="device-panel publication-panel" aria-label={'Публикация ' + site.domain}>
  <h2>Публикация · {site.domain}</h2>
  <p role="status">{publication ? phases[publication.phase] : 'Публикация ещё не запрошена'}</p>
  {publication?.cancelRequested ? <p className="conflict-note">Запрошена отмена. Уже отправленное переключение могло завершиться; здесь показан подтверждённый результат.</p> : null}
  {publication?.settlement === 'conflict' ? <p className="error-banner">Внешний результат сохранён, но версия реестра изменилась. Нужна проверка администратором.</p> : null}
  {publication?.retryAt ? <p className="hint">Следующая проверка не раньше {new Date(publication.retryAt).toLocaleString('ru-RU')}.</p> : null}
  {value?.domain.records.length ? <><p>Записи меняются вручную у регистратора.</p><table><thead><tr><th>Тип</th><th>Имя</th><th>Значение</th></tr></thead><tbody>{value.domain.records.map((r, i) => <tr key={i}><td>{r.type}</td><td>{r.name}</td><td style={{ overflowWrap: 'anywhere' }}>{r.value}</td></tr>)}</tbody></table></> : null}
  <p className="hint">Запущенное устройство автоматически продолжает публикацию. Если устройства выключены, используйте кнопку продолжения. Ожидание лимита или DNS сохраняет готовые файлы.</p>
  <div className="row-actions">
   {publication?.settlement === 'pending' && canResume ? <button disabled={busy} onClick={() => void act(true)}>Продолжить публикацию</button> : null}
   {canEdit && site.draftId && site.draftId !== site.publishedId && publication?.settlement !== 'pending' ? <button className="primary" disabled={busy} onClick={() => void act(false)}>Опубликовать принятый черновик</button> : null}
  </div>
  {publication?.diagnostic?<p role="status">{publicationDiagnosticCaptions[publication.diagnostic.code]} · {new Date(publication.diagnostic.at).toLocaleString('ru-RU')}</p>:null}{error ? <p role="alert" className="error-banner">{error}</p> : null}
 </section>;
}
