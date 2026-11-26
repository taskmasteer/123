import {runNode} from './lib/launcher.mjs';
try {
  runNode('node_modules/typescript/bin/tsc',['--noEmit','-p','tsconfig.json']);
  runNode('scripts/test-unit.mjs');
  for (const file of ['package-runtime','package-download']) runNode(`scripts/test/${file}.test.mjs`);
  runNode('scripts/test/api-release.test.mjs');
  runNode('scripts/test/api-upgrade.test.mjs');
  runNode('scripts/test-integration.mjs');
  runNode('node_modules/typescript/bin/tsc',['-p','tsconfig.build.json']);
  runNode('scripts/test-server.mjs',['--isolated']);
  runNode('node_modules/vite/bin/vite.js',['build','--config','vite.web.config.ts'],{cwd:new URL('../apps/desktop',import.meta.url)});
}catch(error){console.error(error.message);process.exitCode=1;}
