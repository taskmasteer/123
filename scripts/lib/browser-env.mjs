// Load before Playwright or any worker module: its browser registry reads this
// setting at import time, not when Chromium is launched.
import {resolve} from 'node:path';
process.env.PLAYWRIGHT_BROWSERS_PATH??=resolve(import.meta.dirname,'../..','.local-state/browsers');
