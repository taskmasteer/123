import type { ElementPatch, Projection, SaveView } from '../../../../../packages/contracts/src/visual.js';
import type { Revision, Principal } from '../../../../../packages/contracts/src/model.js';
import type { Client } from '../../lib/desktop-client.js';
export async function loadProjection(client: Client, siteId: string, expectedRevision: number): Promise<Projection> {
    const descriptor = await client.request<{
        mapId: string;
        sha256: string;
        size: number;
    }>('visual.projection', { siteId, expectedRevision });
    if (!Number.isSafeInteger(descriptor.size) || descriptor.size < 1 || descriptor.size > 12000000)
        throw new Error('Некорректный размер проекции.');
    const bytes = new Uint8Array(descriptor.size);
    let offset = 0;
    for (let index = 0; offset < bytes.length; index++) {
        const { base64 } = await client.request<{
            base64: string;
        }>('visual.projection.chunk', { siteId, expectedRevision, mapId: descriptor.mapId, index });
        const chunk = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        if (!chunk.length || chunk.length > 24000 || offset + chunk.length > bytes.length)
            throw new Error('Некорректный фрагмент.');
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    if (hash !== descriptor.sha256)
        throw new Error('Хеш проекции не совпадает.');
    const projection = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Projection;
    if (projection.version !== 1 || projection.binding.mapId !== descriptor.mapId || projection.binding.siteId !== siteId || !Array.isArray(projection.elements) || !Array.isArray(projection.documents))
        throw new Error('Некорректная проекция.');
    return projection;
}
export async function openSelectionWindow(client: Client, projection: Projection, documentPath: string) {
    const bytes = new TextEncoder().encode(JSON.stringify(projection));
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    const { id } = await client.request<{
        id: string;
    }>('visual.selection.begin', { size: bytes.length, sha256 });
    for (let offset = 0, index = 0; offset < bytes.length; offset += 24000, index++) {
        let binary = '';
        for (const byte of bytes.subarray(offset, offset + 24000))
            binary += String.fromCharCode(byte);
        await client.request('visual.selection.chunk', { id, index, base64: btoa(binary) });
    }
    return client.request<{
        sessionId: string;
        token: string;
    }>('visual.selection.open', { id, documentPath });
}
/** Renderer-level orchestration; every underlying dispatch finishes quickly. */
export function createVisualClient(client: Client, context: {
    mapId: string;
    requestKey: string;
    signal: AbortSignal;
    onPending?: (save: SaveView) => void;
}) {
    return { async applyElementPatch(_actor: Principal, siteId: string, expectedRevision: number, patch: ElementPatch): Promise<Revision> {
            const save = await client.request<SaveView>('visual.submit', { siteId, expectedRevision, mapId: context.mapId, requestKey: context.requestKey, patch });
            context.onPending?.(save);
            return waitForSave(client, siteId, save.saveId, context.signal, context.onPending);
        } };
}
export async function waitForSave(client: Client, siteId: string, saveId: string, signal: AbortSignal, onPending?: (save: SaveView) => void): Promise<Revision> {
    while (true) {
        signal.throwIfAborted();
        const save = await client.request<SaveView>('visual.status', { siteId, saveId });
        signal.throwIfAborted();
        onPending?.(save);
        if (save.status === 'completed' && save.revision)
            return save.revision;
        if (['failed', 'conflict', 'rejected'].includes(save.status))
            throw new Error(save.error ?? 'Сохранение не завершено. Черновик сохранён.');
        await new Promise<void>((resolve, reject) => { const cancel = () => { clearTimeout(timer); reject(signal.reason); }; const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, 700); signal.addEventListener('abort', cancel, { once: true }); });
    }
}
