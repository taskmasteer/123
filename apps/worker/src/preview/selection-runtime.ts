import { randomUUID } from 'node:crypto';
import { AppError } from '../../../../packages/contracts/src/model.js';
import { digest } from '../../../../packages/core/src/visual/editable-map.js';
import { verifiedProjection } from '../../../../packages/core/src/visual/projection.js';
import { openSelection, type SelectionDriver } from './selection.js';
/** One bounded ephemeral projection and one isolated renderer; no enrollment/model/credential dependency. */
export function createSelectionRuntime() {
    let upload: {
        id: string;
        size: number;
        sha256: string;
        parts: Buffer[];
        received: number;
        expires: number;
    } | null = null, driver: SelectionDriver | null = null;
    return { async close() { upload = null; await driver?.close(); driver = null; }, async request(method: string, p: Record<string, unknown>) {
            if (upload && upload.expires < Date.now())
                upload = null;
            if (method === 'visual.selection.begin') {
                upload = { id: randomUUID(), size: Number(p.size), sha256: String(p.sha256), parts: [], received: 0, expires: Date.now() + 120000 };
                return { id: upload.id };
            }
            if (method === 'visual.selection.chunk') {
                if (!upload || upload.id !== p.id)
                    throw new AppError('NOT_FOUND', 'Проекция закрыта.');
                const bytes = Buffer.from(String(p.base64), 'base64');
                if (bytes.toString('base64') !== p.base64 || bytes.length > 24000 || Number(p.index) !== upload.parts.length || upload.received + bytes.length > upload.size)
                    throw new AppError('INVALID_INPUT', 'Недопустимый фрагмент проекции.');
                upload.parts.push(bytes);
                upload.received += bytes.length;
                return { ok: true };
            }
            if (method === 'visual.selection.open') {
                if (!upload || upload.id !== p.id || upload.received !== upload.size)
                    throw new AppError('CONFLICT', 'Проекция загружена не полностью.');
                const bytes = Buffer.concat(upload.parts);
                if (digest(bytes) !== upload.sha256)
                    throw new AppError('INVALID_INPUT', 'Хеш проекции не совпадает.');
                upload = null;
                await driver?.close();
                driver = await openSelection(verifiedProjection(JSON.parse(bytes.toString('utf8'))), p.documentPath as string | undefined);
                return { sessionId: driver.sessionId, token: driver.token };
            }
            if (!driver || driver.sessionId !== p.sessionId)
                throw new AppError('NOT_FOUND', 'Окно выделения закрыто.');
            if (method === 'visual.selection.status')
                return driver.status();
            if (method === 'visual.selection.close') {
                await driver.close();
                driver = null;
                return { ok: true };
            }
            throw new AppError('INVALID_INPUT', 'Неизвестный запрос выделения.');
        } };
}
