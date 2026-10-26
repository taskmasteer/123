import { describe, expect, it } from 'vitest';
import { normalizeDomain } from '../src/sites.js';
import { authorize } from '../src/permissions.js';
import type { Action, Principal, Site } from '../../contracts/src/model.js';

const ownedSite: Site = {
  id: '00000000-0000-4000-8000-000000000001', domain: 'example.com', ownerId: 'owner',
  assignedUserIds: ['assigned'], input: { domain: 'example.com' }, revision: 0,
  draftId: null, publishedId: null, generationStatus: 'queued', domainStatus: 'pending',
};

describe('normalizeDomain', () => {
  // Catches missing canonicalization, including IDNA and case handling.
  it.each([
    [' HTTPS://EXAMPLE.COM/ ', 'example.com'], ['example.com', 'example.com'],
    ['пример.рф', 'xn--e1afmkfd.xn--p1ai'], ['http://Sub.Example.com/', 'sub.example.com'],
  ])('normalizes %s', (input, wanted) => expect(normalizeDomain(input)).toBe(wanted));

  // Catches URL parser conveniences that could silently discard unsafe input.
  it.each([
    '', 'https://example.com/page', 'https://user:pass@example.com', 'example.com:443',
    'https://example.com:443/', 'https://example.com?', 'https://example.com#',
    'example.com?q=1', 'example.com#foo', 'localhost', 'localhost.localdomain', 'app.localhost',
    '127.0.0.1', '0x7f000001', '2130706433', '[::1]', 'https://[2001:db8::1]',
    'ftp://example.com', 'https://example.com\\page', 'exam ple.com',
    '-bad.example', 'bad_.example', 'example..com', '.example.com', 'example.com.',
    'https://@example.com', 'example.com//', 'example.com/%2e',
  ])('rejects %s', (input) => expect(() => normalizeDomain(input)).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' })));
});

describe('authorize', () => {
  // Catches escalation and cross-owner reads/edits through direct service calls.
  const actions: Action[] = ['site:create', 'site:read', 'site:edit', 'site:publish', 'site:export', 'admin:manage'];
  it.each([
    ['user', 'owner', ['site:create', 'site:read']],
    ['user', 'assigned', ['site:create', 'site:read']],
    ['spec-user', 'owner', ['site:create', 'site:read', 'site:edit', 'site:publish']],
    ['spec-user', 'assigned', ['site:create', 'site:read', 'site:edit', 'site:publish']],
    ['spec-user', 'stranger', ['site:create']],
    ['admin', 'stranger', actions],
  ] as const)('enforces %s access for %s', (role, userId, allowed) => {
    const principal: Principal = { role, userId };
    for (const action of actions) {
      if ((allowed as readonly string[]).includes(action)) expect(() => authorize(principal, action, ownedSite)).not.toThrow();
      else expect(() => authorize(principal, action, ownedSite)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
    }
  });
  it('requires a scoped site for non-admin reads', () => {
    expect(() => authorize({ userId: 'owner', role: 'user' }, 'site:read')).toThrow();
  });
});
