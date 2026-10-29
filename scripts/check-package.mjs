import { checkRuntime } from './lib/package-runtime.mjs';
import { resolve } from 'node:path';
try {
  const value = name => process.argv[process.argv.indexOf(name) + 1];
  if (!process.argv.includes('--root') || !process.argv.includes('--expected-manifest-sha256')) throw new Error('Supply --root and independent --expected-manifest-sha256 from the trusted build receipt');
  console.log(JSON.stringify(await checkRuntime(resolve(value('--root')), value('--expected-manifest-sha256'), { target: value('--target') })));
} catch (error) { console.error(error.message); process.exitCode = 1; }
