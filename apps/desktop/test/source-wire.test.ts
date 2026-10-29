import { describe, expect, it } from 'vitest';
import { recoveryResponse } from '../../../packages/contracts/src/recovery-wire.js';

describe('managed source chunks', () => {
  const chunk = { path: 'index.html', mediaType: 'text/html', size: 0, offset: 0, base64: '', nextOffset: null };
  it('accepts an empty source file and an EOF chunk', () => {
    expect(recoveryResponse('source.read', chunk)).toEqual(chunk);
    expect(recoveryResponse('source.read', { ...chunk, size: 3, offset: 3 })).toMatchObject({ base64: '', nextOffset: null });
  });
  it('accepts a correctly bounded ordinary chunk', () => {
    expect(recoveryResponse('source.read', { ...chunk, size: 3, base64: 'YWJj', nextOffset: null })).toMatchObject({ nextOffset: null });
  });
  it('rejects malformed, truncated, and inconsistent chunks', () => {
    for (const bad of [
      { ...chunk, base64: 'YQ=' },
      { ...chunk, size: 4, base64: 'YWJj', nextOffset: null },
      { ...chunk, size: 4, base64: '', nextOffset: null },
      { ...chunk, size: 3, base64: 'YWJj', nextOffset: 1 },
      { ...chunk, size: 1, base64: 'YR==', nextOffset: null },
      { ...chunk, size: 1, offset: 2 },
    ]) expect(() => recoveryResponse('source.read', bad)).toThrow();
  });
});
