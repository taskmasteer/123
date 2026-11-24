import { AppError } from '../../contracts/src/model.js';
import type { ArtifactFile } from '../../contracts/src/model.js';

export const artifactLimits = { fileBytes: 2_000_000, totalBytes: 10_000_000, files: 100 } as const;
const media: Record<string, string> = {
  json: 'application/json', txt: 'text/plain', xml: 'application/xml', html: 'text/html', css: 'text/css', js: 'text/javascript', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2',
};
export function artifactPath(path: string): string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 240) throw new AppError('INVALID_INPUT', 'Invalid artifact path.');
  const parts = path.split('/');
  if (parts.some((part) => !/^[a-z0-9][a-z0-9._-]*$/i.test(part) || part.endsWith('.') ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part) ||
      /^(api|node_modules)$/i.test(part))) throw new AppError('INVALID_INPUT', 'Unsafe artifact path.');
  if(/^(?:package(?:-lock)?|vercel|tsconfig(?:\.[a-z0-9_-]+)?)\.json$/i.test(parts.at(-1)!))throw new AppError('INVALID_INPUT','Only static site files are allowed.');
  const extension = parts.at(-1)!.split('.').at(-1)!;
  if (!media[extension.toLowerCase()]) throw new AppError('INVALID_INPUT', 'Only static site files are allowed.');
  return path;
}
export function artifactMediaType(path: string): string {
  artifactPath(path); return media[path.split('.').at(-1)!.toLowerCase()]!;
}
export function checkArtifacts(files: ArtifactFile[]): void {
  if (!Array.isArray(files) || files.length > artifactLimits.files) throw new AppError('INVALID_INPUT', 'Too many artifact files.');
  let total = 0; const names = new Map<string, string>(); const fileNames = new Set<string>();
  for (const file of files) {
    if (!file || typeof file !== 'object') throw new AppError('INVALID_INPUT', 'Invalid artifact.');
    const path = artifactPath(file.path);
    // Check every prefix: Assets/a.css and assets/b.css also collide on Windows.
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/'); const key = prefix.toLowerCase(); const existing = names.get(key);
      if (fileNames.has(key) || (existing !== undefined && (existing !== prefix || i === parts.length))) throw new AppError('INVALID_INPUT', 'Duplicate or case-colliding artifact paths.');
      names.set(key, prefix);
    }
    fileNames.add(path.toLowerCase());
    if (!(file.bytes instanceof Uint8Array) || file.bytes.byteLength > artifactLimits.fileBytes ||
        file.mediaType !== artifactMediaType(path)) throw new AppError('INVALID_INPUT', 'Invalid artifact bytes or media type.');
    total += file.bytes.byteLength;
    if (total > artifactLimits.totalBytes) throw new AppError('INVALID_INPUT', 'Artifact exceeds the byte limit.');
  }
}
