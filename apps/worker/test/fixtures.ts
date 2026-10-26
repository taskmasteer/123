import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { ArtifactFile } from '../../../packages/contracts/src/model.js';
export const directories: string[] = [];
export async function directory() { const path = await mkdtemp(join(tmpdir(), 'site-factory-artifacts-')); directories.push(path); return path; }
export async function cleanDirectories() {
  for (const path of directories.splice(0)) {
    if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe cleanup target');
    await rm(path, { recursive: true, force: true });
  }
}
export function file(path: string, text: string): ArtifactFile {
  return { path, bytes: new TextEncoder().encode(text), mediaType: path.endsWith('.css') ? 'text/css' : path.endsWith('.js') ? 'text/javascript' : 'text/html' };
}
export function site(body = '<h1>Clear product information</h1><p>Useful tools for growing teams.</p>', css = '') {
  return [file('index.html', '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Product tools</title><link rel="stylesheet" href="style.css"></head><body>' + body + '</body></html>'),
    file('style.css', 'body{margin:0;padding:20px;font:18px sans-serif;color:#111;background:#fff}*{box-sizing:border-box}img{max-width:100%}' + css)];
}
