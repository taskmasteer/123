import { afterEach, expect, test } from 'vitest';
import { privateJson } from '../src/private-json.js';
import { cleanDirectories, directory } from '../../../apps/worker/test/fixtures.js';

afterEach(cleanDirectories);
interface Document { text: string }
function parse(value: unknown): Document {
  if (!value || typeof value !== 'object' || !('text' in value) || typeof value.text !== 'string') throw new Error('Invalid test document');
  return { text: value.text };
}

// Catches accepting more UTF-8 bytes than the reader can reopen, including multi-byte text.
test('an oversized transaction preserves the previous readable document after reopen', async () => {
  const root = await directory(); const storage = await privateJson(root, 'document.json', { text: '' }, parse);
  await storage.transaction(() => ({ value: { text: 'Previously committed state' }, result: undefined }));
  await expect(storage.transaction(() => ({ value: { text: '界'.repeat(700_000) }, result: undefined }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  const reopened = await privateJson(root, 'document.json', { text: '' }, parse);
  expect(await reopened.transaction((value) => ({ result: value }))).toEqual({ text: 'Previously committed state' });
  await reopened.transaction(() => ({ value: { text: 'A later small update' }, result: undefined }));
  expect(await storage.transaction((value) => ({ result: value }))).toEqual({ text: 'A later small update' });
});
