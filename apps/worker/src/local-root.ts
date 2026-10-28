import { join } from 'node:path';
import { privateDirectory, safeFile, readRegular, missing } from '../../../packages/adapters/src/safe-files.js';
import { AppError } from '../../../packages/contracts/src/model.js';
export async function activeLocalRoot(base: string, source: string) { await privateDirectory(base); let bytes: Uint8Array; try {
    bytes = await readRegular(await safeFile(base, '.active-root.json'), 1000);
}
catch (error) {
    if (missing(error))
        return { root: base, sourceRoot: source };
    throw error;
} const value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)); if (!value || value.version !== 1 || typeof value.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.id) || Object.keys(value).sort().join(',') !== 'id,version')
    throw new AppError('INVALID_INPUT', 'Указатель восстановленной установки повреждён.'); const root = await privateDirectory(join(base, '.restored', value.id), false), catalog = await privateDirectory(join(root, '.catalog'), false); return { root, sourceRoot: catalog }; }
