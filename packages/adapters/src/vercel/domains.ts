import type { DomainSetup, DnsRecord } from '../../../contracts/src/publication.js';
export function domainSetup(domain: string, projectDomain: any, config: any): DomainSetup {
    if (projectDomain?.name !== domain || typeof projectDomain.verified !== 'boolean' || typeof config?.misconfigured !== 'boolean')
        throw new Error('Invalid domain response.');
    const records: DnsRecord[] = [];
    for (const c of projectDomain.verification ?? [])
        if (c.type === 'TXT' && typeof c.domain === 'string' && typeof c.value === 'string')
            records.push({ type: 'TXT', name: c.domain, value: c.value });
    const cname = [...(config.recommendedCNAME ?? [])].sort((a, b) => a.rank - b.rank)[0];
    if (projectDomain.apexName !== domain && cname && typeof cname.value === 'string')
        records.push({ type: 'CNAME', name: domain, value: cname.value });
    else {
        const preferred = [...(config.recommendedIPv4 ?? [])].sort((a, b) => a.rank - b.rank)[0];
        if (preferred)
            for (const value of preferred.value ?? [])
                if (typeof value === 'string')
                    records.push({ type: 'A', name: domain, value });
    }
    if (records.length > 20 || records.some(r => r.name.length > 253 || r.value.length > 2048))
        throw new Error('Invalid domain records.');
    return { records, verified: projectDomain.verified && !config.misconfigured };
}
