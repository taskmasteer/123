import {defineConfig} from 'vitest/config';
export default defineConfig({test:{
  include:['packages/**/test/**/*.test.ts','apps/**/test/**/*.test.ts'],
  // Hosted runners can take several seconds to flush a single durable SQLite fixture.
  // Keep assertions unchanged while allowing I/O and cleanup to finish in CI.
  testTimeout:process.env.CI ? 30000 : 5000,
  hookTimeout:process.env.CI ? 30000 : 10000,
}});
