import { AppError } from '../../contracts/src/model.js';
import type { Action, Principal, Site } from '../../contracts/src/model.js';
export function authorize(principal: Principal, action: Action, site?: Site): void {
  const knownAction = ['site:create', 'site:read', 'site:edit', 'site:publish', 'site:export', 'admin:manage'].includes(action);
  const knownRole = ['user', 'spec-user', 'admin'].includes(principal?.role);
  if (knownAction && knownRole && typeof principal.userId === 'string' && principal.userId.trim()) {
    if (principal.role === 'admin' || action === 'site:create') return;
    const inScope = site && (site.ownerId === principal.userId || site.assignedUserIds.includes(principal.userId));
    if (inScope && (action === 'site:read' || (principal.role === 'spec-user' &&
      (action === 'site:edit' || action === 'site:publish')))) return;
  }
  throw new AppError('FORBIDDEN', 'This action is outside the principal’s permissions.');
}
