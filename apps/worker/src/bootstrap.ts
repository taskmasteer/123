import type { Readable } from 'node:stream';
import {nativePersistencePermit,type NativePersistencePermit} from '../../../packages/adapters/src/native-persistence.js';
/** Native grants this fixed pipe message only after attaching process containment. */
export async function waitForNativeStart(input: Readable, enabled: boolean): Promise<NativePersistencePermit|undefined> {
  if (!enabled) return;
  await new Promise<void>((resolve, reject) => {
    let pending = Buffer.alloc(0);
    const timer = setTimeout(() => done(new Error('Native process containment was not acknowledged.')), 5000);
    function done(error?: Error, rest?: Buffer) {
      clearTimeout(timer); input.pause(); input.off('data', data); input.off('end', ended); input.off('close', ended); input.off('error', done);
      if (rest?.length) input.unshift(rest);
      if (error) reject(error); else resolve();
    }
    function ended() { done(new Error('Native owner closed before containment.')); }
    function data(chunk: Buffer) {
      pending = Buffer.concat([pending, chunk]); const end = pending.indexOf(10);
      if (pending.length > 64064 || end > 64 || end < 0 && pending.length > 64) return done(new Error('Invalid native start grant.'));
      if (end < 0) return;
      if (pending.subarray(0, end + 1).toString('ascii') !== 'SF_NATIVE_START_V1\n') return done(new Error('Invalid native start grant.'));
      done(undefined, pending.subarray(end + 1));
    }
    input.on('data', data); input.once('end', ended); input.once('close', ended); input.once('error', done);
  });
  return nativePersistencePermit();
}
