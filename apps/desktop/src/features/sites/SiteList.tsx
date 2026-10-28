import React from 'react';
import type { Site, Job } from '../../../../../packages/contracts/src/model.js';
export type DesktopSite = Site & {
    job: Job | null;
};
const stages: Record<string, string> = { brief: 'Подготовка', assets: 'Материалы', generate: 'Создание', validate: 'Проверка', archive: 'Сохранение', publication: 'Локальный выпуск', completed: 'Нет операций' };
export function stageLabel(job: Pick<Job, 'stage' | 'state'> | null) {
    if (!job)
        return 'В очереди';
    return ({ queued: 'В очереди', paused: 'Приостановлено', waiting_provider: 'Ожидание сервиса', needs_attention: 'Нужна проверка', cancelled: 'Отменено' } as Record<string, string>)[job.state] ?? stages[job.stage] ?? 'В работе';
}
export function SiteList({ sites, loading, onPreview, onOpen, onRetry, onEdit, canEdit = true, canRetry = true, managed = false, onPublication }: {
    sites: DesktopSite[];
    loading: boolean;
    canEdit?: boolean;
    canRetry?: boolean;
    managed?: boolean;
    onPublication?: (site: DesktopSite) => void;
    onPreview: (site: DesktopSite) => void;
    onOpen: (site: DesktopSite) => void;
    onRetry: (site: DesktopSite) => void;
    onEdit: (site: DesktopSite) => void;
}) {
    return <div className="registry"><table><thead><tr><th>Домен</th><th>Работа</th><th>Версия</th><th>Домен в интернете</th><th><span className="sr-only">Действия</span></th></tr></thead>
 <tbody>{sites.map(site => <tr key={site.id}><td className="domain">{site.domain}</td><td><span className={site.job?.state === 'needs_attention' ? 'badge warning' : 'stage'}>{stageLabel(site.job)}</span></td><td>{site.publishedId ? <span className={site.draftId && site.draftId !== site.publishedId ? "badge warning" : "badge success"}>{site.draftId && site.draftId !== site.publishedId ? "Есть черновик" : managed ? "Версия готова" : "Локальная версия готова"}</span> : <span className="muted">Первый выпуск</span>}</td><td className="muted">{site.domainStatus === 'verified' ? 'Подтверждён' : 'Не подключён'}</td><td className="row-actions">{onPublication ? <button aria-label={'Публикация ' + site.domain} onClick={() => onPublication(site)}>Публикация</button> : null}{site.publishedId ? <><button disabled={!canEdit} aria-label={'Правки ' + site.domain} onClick={() => onEdit(site)}>Правки</button><button aria-label={(managed ? 'Предпросмотр ' : 'Снимок ') + site.domain} onClick={() => onPreview(site)}>{managed ? 'Предпросмотр' : 'Снимок'}</button><button aria-label={'Открыть ' + site.domain + (managed ? ' в браузере' : ' в Chromium')} onClick={() => onOpen(site)}>Открыть</button></> : ['paused', 'needs_attention', 'waiting_provider'].includes(site.job?.state ?? '') ? <button disabled={!canRetry} onClick={() => onRetry(site)}>Повторить</button> : null}</td></tr>)}</tbody></table>
 {loading && !sites.length ? <div className="empty" role="status">Загрузка сайтов…</div> : !sites.length ? <div className="empty"><span className="empty-mark" aria-hidden="true">＋</span><h2>Сайтов пока нет</h2><p>Создайте сайт по домену — здесь появятся этапы работы и проверенная версия.</p></div> : null}</div>;
}
