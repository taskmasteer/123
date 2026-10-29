import { argumentsFor, prepareRuntime } from './lib/package-stage.mjs';
try { console.log(JSON.stringify(await prepareRuntime(argumentsFor()))); } catch (error) { console.error(error.message); process.exitCode = 1; }
