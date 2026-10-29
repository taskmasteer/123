import React, { useState, useEffect } from 'react';
import { desktopClient } from '../../lib/desktop-client.js';
import { healthCaption, healthIntervalMs, type HealthObservation } from '../../../../../packages/contracts/src/monitoring.js';
export function HealthStatus({ siteId, publishedId }: {
    siteId: string;
    publishedId: string | null;
}) {
    const [value, setValue] = useState<HealthObservation | null>(null), [error, setError] = useState(false), [refresh, setRefresh] = useState(0);
    useEffect(() => { let active = true; setValue(null); setError(false); void desktopClient.request<HealthObservation>('site.health', { siteId }).then(r => { if (active)
        setValue(r); }).catch(() => { if (active)
        setError(true); }); return () => { active = false; }; }, [siteId, publishedId, refresh]);
    const stale = value?.checkedAt !== null && value?.checkedAt !== undefined && Date.now() - value.checkedAt >= healthIntervalMs;
    return <span><span>{error ? 'Наблюдение недоступно' : !value ? 'Нет наблюдения' : value.provenance === 'demo' ? 'Демо · публичный сайт не проверен' : value.provenance === 'restored' ? 'После восстановления · не проверено' : (value.revisionId !== publishedId || value.status === null) && value.checkedAt ? 'Публикация изменилась · нужна новая проверка' : value.checkedAt === null ? 'Ещё не проверен' : healthCaption(value.code)}</span>{value?.checkedAt != null ? <small className="muted"> · {stale ? 'Устарело · ' : ''}{new Date(value.checkedAt).toLocaleString('ru-RU')}</small> : null}<button className="health-refresh" aria-label="Обновить наблюдение" onClick={() => setRefresh(v => v + 1)}>↻</button></span>;
}
