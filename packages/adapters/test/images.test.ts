import { expect, test } from 'vitest';
import { createImageGenerator } from '../src/openai/images.js';
import type { ImageState } from '../src/openai/images.js';
import type { ArtifactFile } from '../../contracts/src/model.js';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
test('persists selection and pending before the paid call, reuses bytes for the same seed', async () => {
    let state: ImageState | undefined, file: ArtifactFile | undefined, calls = 0;
    const transport = (async (_url, init) => { calls++; expect(state?.status).toBe('pending'); expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'configured-image', n: 1 }); expect(String(init?.body)).not.toContain('seed'); return Response.json({ data: [{ b64_json: png }] }); }) as typeof fetch;
    const config = { apiKey: 'synthetic', model: 'configured-text', imageModel: 'configured-image' };
    const generator = createImageGenerator(config, transport, { async checkpoint(s, f) { state = s; file = f; } });
    const first = await generator.generateImage('data pipelines', 3);
    expect(first?.mediaType).toBe('image/png');
    expect(await generator.generateImage('data pipelines', 3)).toEqual(first);
    expect(calls).toBe(1);
    const resumed = createImageGenerator(config, transport, { state: state!, file: file!, async checkpoint() { } });
    expect(await resumed.generateImage('data pipelines', 3)).toEqual(first);
    expect(calls).toBe(1);
});
test('missing image model and unselected seed make no image HTTP requests', async () => {
    const forbidden = (async () => { throw new Error('HTTP forbidden'); }) as typeof fetch;
    expect(await createImageGenerator({ apiKey: 'synthetic', model: 'text' }, forbidden).generateImage('description', 3)).toBeNull();
    expect(await createImageGenerator({ apiKey: 'synthetic', model: 'text', imageModel: 'image' }, forbidden).generateImage('description', 17)).toBeNull();
});
test('pending image outcome is ambiguous and is never automatically paid for twice', async () => {
    let saved: ImageState | undefined, calls = 0;
    const config = { apiKey: 'synthetic', model: 'text', imageModel: 'image' };
    const transport = (async () => { calls++; throw new Error('Connection lost after sending'); }) as typeof fetch;
    await expect(createImageGenerator(config, transport, { async checkpoint(s) { saved = s; } }).generateImage('description', 3)).rejects.toThrow('ambiguous');
    await expect(createImageGenerator(config, transport, { state: saved!, async checkpoint() { } }).generateImage('description', 3)).rejects.toThrow('ambiguous');
    expect(calls).toBe(1);
});
