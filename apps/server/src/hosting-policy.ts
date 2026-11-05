import { normalizeDomain } from '../../../packages/core/src/sites.js';
import { AppError } from '../../../packages/contracts/src/model.js';

export const pilotDomains = ['chinazes.space','gucci777.shop','wunderwaffe.online','wunderwaffe.shop','wunderwaffe.site','wunderwaffe.space','wunderwaffe.store','wunderwaffe.website'] as const;
export function publicationDomain(value:string, allowed?:readonly string[]){
  const domain=normalizeDomain(value);
  if(allowed&&!allowed.includes(domain))throw new AppError('FORBIDDEN','Домен не разрешён для этого подключения DNS.');
  return domain;
}
