import { it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { waitForNativeStart } from '../src/bootstrap.js';
it('does not admit worker imports/descendants before the private native start grant', async () => {
  const input = new PassThrough(); let admitted = false;
  const ready = waitForNativeStart(input, true).then(() => { admitted = true; });
  await Promise.resolve(); await Promise.resolve(); expect(admitted).toBe(false);
  input.write('SF_NATIVE_START_V1\n'); await ready; expect(admitted).toBe(true); input.destroy();
});
it('rejects EOF or a forged grant rather than starting the worker', async () => {
  const ended = new PassThrough(), first = waitForNativeStart(ended, true); ended.end();
  await expect(first).rejects.toThrow();
  const forged = new PassThrough(), second = waitForNativeStart(forged, true); forged.write('not-authorized\n');
  await expect(second).rejects.toThrow(); forged.destroy();
});
