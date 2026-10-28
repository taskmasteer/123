import React from 'react';
import type { ImportRowView } from '../../../../../packages/contracts/src/import.js';
import { stageLabel } from '../sites/SiteList.js';
export function BatchTable({ rows, editable, busy, onEdit, onLogo, onRetry }: {
    rows: ImportRowView[];
    editable: boolean;
    busy: boolean;
    onEdit: (row: ImportRowView) => void;
    onLogo: (row: ImportRowView, file: File) => void;
    onRetry?: (row: ImportRowView) => void;
}) {
    const column: Record<string, string> = { domain: 'Домен', about: 'О сайте', logo: 'Логотип', referenceId: 'Референс' };
    return <div className="registry batch-table"><table><thead><tr><th>Строка</th><th>Домен и описание</th><th>Результат</th><th>Действия</th></tr></thead><tbody>{rows.map(row => <tr key={row.rowNumber}><td>{row.rowNumber}</td><td><strong>{row.input.domain || 'Домен не указан'}</strong><p className="batch-about">{row.input.about || 'Описание не задано'}</p>{row.input.logo ? <p className="muted">Логотип: {row.input.logoAssetId ? 'сопоставлен' : row.input.logo}</p> : null}</td><td>{row.issues.length ? <ul>{row.issues.map((issue, i) => <li key={i}>{column[issue.column] ?? issue.column}: {issue.message}</li>)}</ul> : row.siteId ? <span>{stageLabel(row.job)}</span> : <span>Готова к запуску</span>}</td><td>{editable ? <><button disabled={busy} aria-label={`Изменить строку ${row.rowNumber}`} onClick={() => onEdit(row)}>Изменить</button>{row.input.logo ? <label className="logo-picker">Выбрать PNG для строки {row.rowNumber}<input type="file" accept=".png,image/png" disabled={busy} onChange={e => {
                        const file = e.target.files?.[0];
                        if (file)
                            onLogo(row, file);
                        e.target.value = '';
                    }}/></label> : null}</> : row.siteId ? <><span className="muted">Сайт добавлен</span>{onRetry && ['paused', 'waiting_provider', 'needs_attention'].includes(row.job?.state ?? '') ? <button disabled={busy} onClick={() => onRetry(row)}>Повторить строку {row.rowNumber}</button> : null}</> : <span className="muted">Строка сохранена</span>}</td></tr>)}</tbody></table>{!rows.length ? <p className="empty">Строк с этим фильтром нет.</p> : null}</div>;
}
