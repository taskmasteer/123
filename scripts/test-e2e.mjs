import {runNode} from './lib/launcher.mjs';
// Pinned Playwright test workers force FORCE_COLOR=1 internally. Select that
// policy at this test-only launcher so NO_COLOR is not sent in contradiction.
// Other launchers continue honoring NO_COLOR; no warning handler is disabled.
const environment={...process.env,FORCE_COLOR:'1'};delete environment.NO_COLOR;
try{runNode('node_modules/playwright/cli.js',['test',...process.argv.slice(2)],{env:environment});}catch(error){console.error(error.message);process.exitCode=1;}
