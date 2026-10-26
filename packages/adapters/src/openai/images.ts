import type { ArtifactFile } from '../../../contracts/src/model.js';
import { AppError } from '../../../contracts/src/model.js';
import { record } from '../../../contracts/src/inputs.js';
import { checkArtifacts } from '../../../core/src/artifacts.js';
import { digest } from './tool-loop.js';
import type { ResponsesConfig } from './responses.js';
import { readProviderJson, validateModelConfig } from './responses.js';
export interface ImageState {
    key: string;
    status: 'skipped' | 'pending' | 'completed';
}
export interface ImageHooks {
    state?: ImageState;
    file?: ArtifactFile;
    checkpoint(state: ImageState, file?: ArtifactFile): Promise<void>;
}
export function createImageGenerator(config: ResponsesConfig, transport: typeof fetch = fetch, hooks?: ImageHooks, signal: AbortSignal = new AbortController().signal) {
    validateModelConfig(config);
    let state = hooks?.state, file = hooks?.file;
    async function save(next: ImageState, nextFile?: ArtifactFile) { state = next; file = nextFile; await hooks?.checkpoint(structuredClone(next), nextFile ? structuredClone(nextFile) : undefined); }
    return { async generateImage(description: string, seed: number): Promise<ArtifactFile | null> {
            if (!Number.isSafeInteger(seed) || seed < 0 || !description || description.length > 8000)
                throw new AppError('INVALID_INPUT', 'Invalid image selection.');
            const key = digest([seed, description, config.imageModel ?? null, 'png', '1024x1024', 1]);
            if (state && (!['skipped', 'pending', 'completed'].includes(state.status) || state.key !== key))
                throw new AppError('INVALID_INPUT', 'Image selection does not match its saved configuration.');
            if (state?.status === 'pending')
                throw new AppError('NEEDS_ATTENTION', 'Image request outcome is ambiguous; automatic regeneration is disabled.');
            if (state?.status === 'completed') {
                if (!file || file.path !== 'assets/illustration.png' || file.mediaType !== 'image/png')
                    throw new AppError('NEEDS_ATTENTION', 'Cached image is unavailable.');
                checkArtifacts([file]);
                return structuredClone(file);
            }
            if (!config.imageModel || seed % 100 >= 10) {
                if (!state)
                    await save({ key, status: 'skipped' });
                return null;
            }
            signal.throwIfAborted();
            await save({ key, status: 'pending' });
            signal.throwIfAborted();
            // Seed identifies the application selection/cache. It is deliberately NOT provider idempotency.
            let response: Response;
            try {
                response = await transport('https://api.openai.com/v1/images/generations', { method: 'POST', headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: config.imageModel, prompt: description, n: 1, size: '1024x1024', output_format: 'png' }), signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]) });
            }
            catch {
                throw new AppError('NEEDS_ATTENTION', 'Image request outcome is ambiguous; automatic regeneration is disabled.');
            }
            if (!response.ok)
                throw new AppError('NEEDS_ATTENTION', `Image request failed (HTTP ${response.status}); review before another paid request.`);
            let data: unknown;
            try {
                data = await readProviderJson(response, 2700000);
            }
            catch {
                throw new AppError('NEEDS_ATTENTION', 'Image result is invalid; automatic regeneration is disabled.');
            }
            if (!record(data) || !Array.isArray(data.data) || data.data.length !== 1 || !record(data.data[0]) || typeof data.data[0].b64_json !== 'string' || data.data[0].b64_json.length > 2666668 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.data[0].b64_json))
                throw new AppError('NEEDS_ATTENTION', 'Image result is invalid or too large.');
            const bytes = Buffer.from(data.data[0].b64_json, 'base64');
            if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.includes(Buffer.from(config.apiKey)))
                throw new AppError('NEEDS_ATTENTION', 'Invalid image bytes.');
            const result = { path: 'assets/illustration.png', bytes: new Uint8Array(bytes), mediaType: 'image/png' };
            checkArtifacts([result]);
            await save({ key, status: 'completed' }, result);
            return structuredClone(result);
        } };
}
