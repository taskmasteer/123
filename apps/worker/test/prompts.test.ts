import { expect, test } from 'vitest';
import { generatePrompt } from '../src/prompts/generate.js';
import { editPrompt } from '../src/prompts/edit.js';
import type { ModelRequest } from '../../../packages/contracts/src/model.js';
const request = { site: {input: {about:'Test topic',mentionedUrl:'https://example.com/'}}, instruction: 'Изменить только цвет', baseManifestId: 'immutable-base', styleId: 'editorial' } as ModelRequest;
test('generation requires English static content and forbids external requests', () => {
    expect(generatePrompt(request)).toContain('English');
    expect(generatePrompt(request)).toContain('HTML, CSS');
    expect(generatePrompt(request)).toContain('external');
});
test('editing explicitly preserves manually edited text outside the requested change', () => {
    expect(editPrompt(request)).toContain('manual');
    expect(editPrompt(request)).toContain('immutable-base');
    expect(editPrompt(request)).toContain('only');
    expect(editPrompt(request)).toContain('English');
});
