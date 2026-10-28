import type { Projection } from '../../../contracts/src/visual.js';
import { digest } from './editable-map.js';
import { AppError } from '../../../contracts/src/model.js';
/** Read optimization only: callers reauthorize/current-revision-check on every chunk. */
export function createProjectionCache() {
    const entries = new Map<string, {
        expires: number;
        value: Promise<ReturnType<typeof projectionResource>>;
    }>();
    return (key: string, load: () => Promise<Projection>) => {
        for (const [id, entry] of entries)
            if (entry.expires < Date.now())
                entries.delete(id);
        const old = entries.get(key);
        if (old)
            return old.value;
        while (entries.size >= 4)
            entries.delete(entries.keys().next().value!);
        const value = load().then(projectionResource);
        entries.set(key, { expires: Date.now() + 60000, value });
        void value.catch(() => { if (entries.get(key)?.value === value)
            entries.delete(key); });
        return value;
    };
}
export function projectionResource(projection: Projection) {
    const bytes = Buffer.from(JSON.stringify(projection));
    if (bytes.length > 12000000)
        throw new AppError('INVALID_INPUT', 'Проекция превышает лимит.');
    return { descriptor: { mapId: projection.binding.mapId, sha256: digest(bytes), size: bytes.length }, chunk(index: number) {
            if (!Number.isSafeInteger(index) || index < 0 || index * 24000 >= bytes.length)
                throw new AppError('NOT_FOUND', 'Фрагмент не найден.');
            return { base64: bytes.subarray(index * 24000, (index + 1) * 24000).toString('base64') };
        } };
}
