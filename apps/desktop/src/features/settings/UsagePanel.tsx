import React, { useEffect, useState } from 'react';
import { desktopClient } from '../../lib/desktop-client.js';
import type { UsageSummary } from '../../../../../packages/contracts/src/monitoring.js';
export function UsagePanel({ siteId }: {
    siteId?: string;
}) {
    const [value, setValue] = useState<UsageSummary | null>(null), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
    useEffect(() => { let active = true; setValue(null); setError(''); void desktopClient.request<UsageSummary>(siteId ? 'site.usage' : 'usage.summary', siteId ? { siteId } : {}).then(r => { if (active)
        setValue(r); }).catch(() => { if (active)
        setError('Сводка недоступна. Проверьте доступ и соединение.'); }); return () => { active = false; }; }, [siteId, refresh]);
    return <section className="settings-section" aria-label="Расход ресурсов"><h2>Расход ресурсов</h2><p>{siteId ? 'Этот сайт' : 'Вся установка'} · <button onClick={() => setRefresh(v => v + 1)}>Обновить</button></p>{error ? <p role="alert">{error}</p> : !value ? <p role="status">Загрузка сводки…</p> : <><dl><dt>Известные токены</dt><dd>{value.inputTokens.toLocaleString('ru-RU')} входящих · {value.outputTokens.toLocaleString('ru-RU')} исходящих</dd><dt>Измеренное активное время</dt><dd>{value.durationMs === null ? 'Неизвестно' : `${(value.durationMs / 1000).toFixed(1)} с · частичный итог`}</dd><dt>Проверенные сохранённые байты</dt><dd>{value.knownBytesStored.toLocaleString('ru-RU')} Б{value.bytesStored === null ? ' · полный объём неизвестен' : ''}</dd><dt>Оценка стоимости</dt><dd>Неизвестна</dd></dl><p className="muted">Заданий в сводке: {value.jobs}; без данных: {value.missingJobs}. Измеренных заданий: {value.measuredJobs}. Исторические и неполные попытки могут содержать неизвестный расход.</p>{value.uncertainRequests || value.requestPending ? <p>Неопределённые запросы: {value.uncertainRequests}{value.requestPending ? ' · есть неподтверждённый запрос' : ''}.</p> : null}<p className="muted">Расход изображений неизвестен. {value.imagePending ? 'Есть неподтверждённое изображение. ' : ''}{value.provenance.includes('demo') ? 'Содержит демонстрационные данные. ' : ''}Это наблюдаемые ресурсы, а не счёт провайдера. Общие каталоги и служебные расходы не распределены по сайтам.</p></>}</section>;
}
