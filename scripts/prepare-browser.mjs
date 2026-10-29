import { argumentsFor, prepareBrowsers } from './lib/package-stage.mjs';
try { console.log(JSON.stringify(await prepareBrowsers(argumentsFor()))); } catch (error) { console.error(error.message); process.exitCode = 1; }
