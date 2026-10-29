import {runNode} from './lib/launcher.mjs';
import {fileURLToPath} from 'node:url';
const mode=process.argv[2];
if(!['dev','build'].includes(mode))throw new Error('Expected dev or build');
runNode(fileURLToPath(new URL('../node_modules/vite/bin/vite.js',import.meta.url)),mode==='dev'?['--host','127.0.0.1','--port','1420','--strictPort']:['build'],{cwd:new URL('../apps/desktop',import.meta.url)});
