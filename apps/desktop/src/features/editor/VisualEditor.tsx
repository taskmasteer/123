import React, { useEffect, useRef, useState } from 'react';
import type { Site, Principal } from '../../../../../packages/contracts/src/model.js';
import type { ElementPatch, Projection, Selection, SaveView } from '../../../../../packages/contracts/src/visual.js';
import { desktopClient } from '../../lib/desktop-client.js';
import { ElementInspector } from './ElementInspector.js';
import { acceptSelection, type SelectionSession } from './preview-bridge.js';
import { loadProjection, openSelectionWindow, createVisualClient, waitForSave } from './visual-client.js';
export function VisualEditor({ site, principal, pendingSaveId, blocked, onChanged }: {
    site: Site;
    principal?: Principal;
    pendingSaveId?: string;
    blocked: boolean;
    onChanged: () => void;
}) {
    const [projection, setProjection] = useState<Projection | null>(null), [documentPath, setDocument] = useState(''), [selected, setSelected] = useState(''), [error, setError] = useState(''), [status, setStatus] = useState(''), [busy, setBusy] = useState(false), [driverReady, setDriverReady] = useState(false);
    const session = useRef<SelectionSession | null>(null), lifetime = useRef(new AbortController());
    const [trackedSaveId, setTrackedSaveId] = useState<string | null>(null);
    const close = async () => {
        const old = session.current;
        session.current = null;
        setDriverReady(false);
        if (old) {
            old.active = false;
            await desktopClient.request('visual.selection.close', { sessionId: old.sessionId }).catch(() => { });
        }
    };
    useEffect(() => {
        const abort = new AbortController();
        lifetime.current = abort;
        return () => { abort.abort(); void close(); };
    }, [site.id, principal?.userId]);
    useEffect(() => {
        setProjection(null);
        setSelected('');
        setDocument('');
        setError('');
        void close();
    }, [site.id, site.revision]);
    useEffect(() => {
        if (pendingSaveId)
            setTrackedSaveId(pendingSaveId);
    }, [pendingSaveId]);
    useEffect(() => {
        if (!trackedSaveId)
            return;
        let stopped = false;
        const abort = new AbortController();
        const signal = AbortSignal.any([abort.signal, lifetime.current.signal]);
        if (trackedSaveId) {
            setBusy(true);
            setStatus('Сохранение ожидает рабочего устройства.');
            void waitForSave(desktopClient, site.id, trackedSaveId, signal, s => {
                if (!stopped)
                    setStatus(s.status === 'queued' ? 'В очереди. Включите рабочее устройство.' : 'Проверяем и сохраняем правку.');
            }).then(() => {
                if (!stopped) {
                    setStatus('Черновик сохранён.');
                    setTrackedSaveId(null);
                    onChanged();
                }
            }).catch(e => {
                if (!stopped)
                    setError((e as Error).message);
            }).finally(() => {
                if (!stopped)
                    setBusy(false);
            });
        }
        return () => { stopped = true; abort.abort(); };
    }, [site.id, trackedSaveId, principal?.userId]);
    async function open() {
        setBusy(true);
        setError('');
        try {
            await close();
            const p = await loadProjection(desktopClient, site.id, site.revision);
            if (lifetime.current.signal.aborted)
                return;
            setProjection(p);
            setDocument(p.documents[0]!.path);
            setSelected('');
            setStatus('Выберите элемент в отдельном окне или в списке.');
            await selectDocument(p, p.documents[0]!.path);
        }
        catch (e) {
            setError((e as Error).message);
        }
        finally {
            setBusy(false);
        }
    }
    async function selectDocument(p: Projection, path: string) {
        await close();
        setDocument(path);
        setSelected('');
        try {
            const opened = await openSelectionWindow(desktopClient, p, path);
            if (lifetime.current.signal.aborted) {
                await desktopClient.request('visual.selection.close', { sessionId: opened.sessionId });
                return;
            }
            session.current = { ...opened, projection: p, active: true, sequence: 0 };
            setDriverReady(true);
        }
        catch (e) {
            setError((e as Error).message);
        }
    }
    useEffect(() => {
        if (!driverReady)
            return;
        let stopped = false, timer: ReturnType<typeof setTimeout>;
        async function poll() {
            const active = session.current;
            if (!active)
                return;
            try {
                const next = await desktopClient.request<{
                    active: boolean;
                    selection: Selection | null;
                }>('visual.selection.status', { sessionId: active.sessionId });
                if (stopped || active !== session.current)
                    return;
                if (!next.active) {
                    void close();
                    setSelected('');
                    setStatus('Окно выделения закрыто.');
                    return;
                }
                const selection = acceptSelection(next.selection, active, active, active);
                if (selection)
                    setSelected(selection.elementId);
            }
            catch (e) {
                if (!stopped) {
                    setError((e as Error).message);
                    void close();
                }
            }
            finally {
                if (!stopped)
                    timer = setTimeout(() => void poll(), 150);
            }
        }
        void poll();
        return () => { stopped = true; clearTimeout(timer); };
    }, [driverReady]);
    async function save(patch: ElementPatch) {
        if (!projection)
            return;
        const saveSignal = lifetime.current.signal;
        setBusy(true);
        setError('');
        await close();
        try {
            await createVisualClient(desktopClient, { mapId: projection.binding.mapId, requestKey: crypto.randomUUID(), signal: lifetime.current.signal, onPending: () => setStatus('Проверяем и сохраняем правку. Если устройства выключены, сохранение останется в очереди.') }).applyElementPatch(principal ?? { userId: site.ownerId, role: 'admin' }, site.id, site.revision, patch);
            setProjection(null);
            setSelected('');
            setStatus('Черновик сохранён.');
            onChanged();
        }
        catch (e) {
            if (!lifetime.current.signal.aborted)
                setError((e as Error).message);
        }
        finally {
            if (lifetime.current.signal === saveSignal && !saveSignal.aborted)
                setBusy(false);
        }
    }
    const element = projection?.elements.find(e => e.elementId === selected);
    return <section className="visual-editor" aria-label="Визуальные правки"><div className="row-actions"><h3>Визуальные правки</h3><button disabled={busy || blocked || !(site.draftId ?? site.publishedId)} onClick={() => void open()}>Выбрать элемент</button>{driverReady ? <button onClick={() => void close()}>Закрыть выделение</button> : null}</div><p className="hint">Простые правки существующего текста и оформления. Выделение показывает исходный HTML без сценариев сайта. Сложные изменения отправьте через чат.</p>
 {error ? <p role="alert">{error}</p> : null}{status ? <p role="status">{status}</p> : null}
 {projection ? <><label>Документ<select aria-label="Документ" disabled={busy} value={documentPath} onChange={e => void selectDocument(projection, e.target.value)}>{projection.documents.map(d => <option key={d.path}>{d.path}</option>)}</select></label><label>Элемент<select aria-label="Элемент" disabled={busy} value={selected} onChange={e => setSelected(e.target.value)}><option value="">Выберите элемент</option>{projection.elements.filter(e => e.documentPath === documentPath).map((e, i) => <option key={e.elementId} value={e.elementId}>{i + 1}. &lt;{e.tag}&gt; {(e.text ?? '').slice(0, 60)}</option>)}</select></label>{element ? <ElementInspector key={element.elementId} element={element} busy={busy || blocked} {...(site.input.logoAssetId ? { logoAssetId: site.input.logoAssetId } : {})} onSave={patch => void save(patch)}/> : <p>Этот элемент не выбран или не поддерживает простые правки.</p>}</> : null}</section>;
}
