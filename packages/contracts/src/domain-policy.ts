import { AppError } from './model.js';

const excluded = ['esmartsoft.com'];
/** Pure policy. Never resolve or contact excluded names. */
export function assertAllowedHost(host: string, blocked: readonly string[] = excluded): void {
  const normalized = host.toLowerCase().replace(/\.+$/, '');
  if (blocked.some(domain => normalized === domain || normalized.endsWith('.' + domain)))
    throw new AppError('FORBIDDEN', 'Этот домен исключён из конвейера.');
}
export function mentionedUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError('INVALID_INPUT', 'Укажите полную HTTP(S)-ссылку.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || value.length > 2048 || /[\u0000-\u0020\\]/.test(value))
    throw new AppError('INVALID_INPUT', 'Ссылка должна вести на публичную HTTP(S)-страницу без пароля и нестандартного порта.');
  assertAllowedHost(url.hostname);
  if (!url.hostname.includes('.') || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local') || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':'))
    throw new AppError('INVALID_INPUT', 'Укажите публичное доменное имя.');
  return value;
}
