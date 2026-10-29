import {runNode} from './lib/launcher.mjs';
const args=process.argv.slice(2);if(!args.some(arg=>arg.startsWith('--maxWorkers')))args.push('--maxWorkers=1');
try{runNode('node_modules/vitest/vitest.mjs',['run','--pool=threads',...args]);}catch(error){console.error(error.message);process.exitCode=1;}
