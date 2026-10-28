import { BlockList, isIP } from 'node:net';
/** Conservative policy v1, reviewed 2026-10-27 against both IANA special-purpose
 * registries (2025-10-09). Excludes even globally reachable special assignments.
 * IPv4 multicast: RFC1112. IPv6 accepts only global unicast 2000::/3 (RFC4291).
 * https://www.iana.org/assignments/iana-ipv4-special-registry/
 * https://www.iana.org/assignments/iana-ipv6-special-registry/
 */
const special = new BlockList();
for (const cidr of ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
    '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
    '192.31.196.0/24', '192.52.193.0/24', '192.88.99.0/24', '192.168.0.0/16',
    '192.175.48.0/24', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24',
    '224.0.0.0/4', '240.0.0.0/4']) {
    const [address, prefix] = cidr.split('/');
    special.addSubnet(address!, Number(prefix), 'ipv4');
}
for (const cidr of ['2001::/23', '2001:db8::/32', '2002::/16', '2620:4f:8000::/48', '3fff::/20']) {
    const [address, prefix] = cidr.split('/');
    special.addSubnet(address!, Number(prefix), 'ipv6');
}
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
export function isPublicAddress(address: string): boolean {
    if (address.includes('%'))
        return false;
    const family = isIP(address);
    return family === 4 ? !special.check(address, 'ipv4') :
        family === 6 && globalV6.check(address, 'ipv6') && !special.check(address, 'ipv6');
}
