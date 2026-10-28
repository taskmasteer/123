import React, { useState } from 'react';
import type { EditableElement, ElementPatch } from '../../../../../packages/contracts/src/visual.js';
const labels = { color: 'Цвет текста', backgroundColor: 'Цвет фона', fontSize: 'Размер текста', margin: 'Внешние отступы', padding: 'Внутренние отступы' };
export function ElementInspector({ element, logoAssetId, busy, onSave }: {
    element: EditableElement;
    logoAssetId?: string;
    busy: boolean;
    onSave: (patch: ElementPatch) => void;
}) {
    const [text, setText] = useState(element.text ?? ''), [href, setHref] = useState(element.href ?? ''), [image, setImage] = useState(false), [styles, setStyles] = useState<Record<string, string>>({});
    const patch: ElementPatch = { elementId: element.elementId, ...(element.fields.includes('text') && text !== element.text ? { text } : {}), ...(element.fields.includes('href') && href !== element.href ? { href } : {}), ...(image && logoAssetId ? { imageAssetId: logoAssetId } : {}), ...(Object.values(styles).some(Boolean) ? { styles: Object.fromEntries(Object.entries(styles).filter(([, v]) => v)) } : {}) };
    return <form className="element-inspector" onSubmit={e => { e.preventDefault(); onSave(patch); }}><strong>Элемент &lt;{element.tag}&gt;</strong><span className="muted">{element.documentPath}</span>
 {element.fields.includes('text') ? <label>Текст<textarea aria-label="Текст" maxLength={8000} value={text} onChange={e => setText(e.target.value)} rows={3}/></label> : <p className="hint">Вложенный текст изменяется через чат.</p>}
 {element.fields.includes('href') ? <label>Ссылка<input value={href} maxLength={2048} onChange={e => setHref(e.target.value)}/></label> : null}
 {element.fields.includes('imageAssetId') ? <label><input type="checkbox" checked={image} disabled={!logoAssetId} onChange={e => setImage(e.target.checked)}/>Использовать проверенный логотип сайта{!logoAssetId ? <span className="hint">У сайта нет загруженного проверенного PNG.</span> : null}</label> : null}
 {element.fields.includes('styles') ? <fieldset><legend>Оформление</legend>{Object.entries(labels).map(([key, label]) => <label key={key}>{label}<input maxLength={128} value={styles[key] ?? ''} placeholder={key.includes('Color') || key === 'color' ? '#243446' : 'Например, 16px'} onChange={e => setStyles(s => ({ ...s, [key]: e.target.value }))}/></label>)}<p className="hint">Пустые поля сохраняют оформление. Для отступов — до четырёх значений px, em, rem или %.</p></fieldset> : null}
 <button className="primary" type="submit" disabled={busy || Object.keys(patch).length === 1}>Сохранить в черновик</button></form>;
}
