import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {verifyApiArchive} from './lib/api-release.mjs';
const path=process.argv[2];if(!path)throw Error('Usage: node scripts/verify-api-package.mjs ARCHIVE');
const result=await verifyApiArchive(resolve(path),await readFile(new URL('../apps/client/release-key.pem',import.meta.url)));
console.log(`Verified API ${result.version} (${result.target})`);
