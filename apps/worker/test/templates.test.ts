import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createLocalCatalog } from '../../../packages/adapters/src/local-catalog.js';
import { validateSite } from '../src/validation/browser.js';
import { cleanDirectories, directory } from './fixtures.js';

afterEach(cleanDirectories);
// Uses the same hardened browser validation as generated sites, at 375 and 1440px.
// Screenshot index is private review evidence, never part of a website manifest.
test('all five original styles render readable English pages with working local anchors', async () => {
  const catalog = await createLocalCatalog(process.cwd(), await directory()); const listing = await catalog.list();
  expect(listing.styles).toHaveLength(5);
  const evidence: Record<string, string[]> = {};
  for (const style of listing.styles) {
    const files = await catalog.load(style.id, style.version); const report = await validateSite(files);
    expect(report.issues, style.id).toEqual([]); expect(report.ok, style.id).toBe(true);
    expect(report.screenshotIds, style.id).toHaveLength(2); evidence[style.id] = report.screenshotIds;
  }
  await mkdir(join(process.cwd(), '.local-state'), { recursive: true });
  await writeFile(join(process.cwd(), '.local-state', 'template-screenshots.json'), JSON.stringify(evidence, null, 2));
}, 60_000);
