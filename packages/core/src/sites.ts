import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { AppError } from '../../contracts/src/model.js';
import { assertAllowedHost } from '../../contracts/src/domain-policy.js';

export function normalizeDomain(value: string): string {
  const invalid = () => new AppError('INVALID_INPUT', 'Enter a public domain without credentials, port, path, query or fragment.');
  if (typeof value !== 'string') throw invalid();
  // Validate the original authority before URL canonicalization can discard a default
  // port, empty query/fragment, credentials, or a dot-segment path.
  const match = /^(?:https?:\/\/)?([^/?#\\]+)\/?$/i.exec(value.trim());
  const authority = match?.[1];
  if (!authority || /[:@%\s\u0000-\u001f\u007f]/u.test(authority)) throw invalid();
  const domain = domainToASCII(authority).toLowerCase();
  assertAllowedHost(domain);
  const labels = domain.split('.');
  if (!domain || domain.length > 253 || isIP(domain) || labels.length < 2 ||
      domain === 'localhost.localdomain' || domain.endsWith('.localhost') || labels.some((label) =>
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw invalid();
  return domain;
}
