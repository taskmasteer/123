// Adds provider-assigned addresses without changing the primary address or routes.
import { readFile, writeFile } from 'node:fs/promises';
import { isIPv4 } from 'node:net';
import { randomBytes } from 'node:crypto';
import { connectHost, execute, loadHost } from './lib/linux-ssh.mjs';

const [hostFile, inventoryFile, iface] = process.argv.slice(2);
if (!/^[a-zA-Z0-9_-]{1,15}$/.test(iface ?? '')) throw new Error('Explicit validated interface required');
const config = await loadHost(hostFile);
const inventory = JSON.parse(await readFile(inventoryFile, 'utf8'));
if (inventory.primaryIPv4 !== config.host) throw new Error('Inventory/SSH host mismatch');
const addresses = inventory.additionalIPv4.map(record => {
  if (!isIPv4(record.address) || record.providerState !== 'Assigned' || record.linkedService !== inventory.serviceName) throw new Error('Only provider-assigned IPv4 can be configured');
  return record.address;
});
if (!addresses.length || addresses.includes(config.host) || new Set(addresses).size !== addresses.length) throw new Error('Invalid address pool');
const yaml = `network:\n  version: 2\n  ethernets:\n    ${iface}:\n      addresses:\n${addresses.map(ip => `        - ${ip}/32`).join('\n')}\n`;
const target = '/etc/netplan/60-site-factory-ipv4.yaml';
const token = randomBytes(6).toString('hex');
const rollback = `/run/site-factory-network-${token}.sh`;
const unit = `site-factory-network-${token}`;
const backup = `/var/backups/site-factory/network-${token}`;
const script = `set -eu
test -d /sys/class/net/${iface}
test ! -e ${target} || { echo 'Managed overlay already exists; inspect it before replacing'; exit 1; }
install -d -m 700 ${backup}
cp -a /etc/netplan ${backup}/
cat > ${rollback} <<'ROLLBACK'
#!/bin/sh
rm -f ${target}
${addresses.map(ip => `ip address del ${ip}/32 dev ${iface} 2>/dev/null || true`).join('\n')}
netplan apply
ROLLBACK
chmod 700 ${rollback}
umask 077
echo '${Buffer.from(yaml).toString('base64')}' | base64 -d > ${target}
umask 022
if ! netplan generate; then rm -f ${target}; exit 1; fi
systemd-run --quiet --unit=${unit} --on-active=180 /bin/sh ${rollback}
netplan apply
ip -brief -4 address show dev ${iface}
`;
let client = await connectHost(config);
try {
  const result = await execute(client, 'sudo -n bash -se', script);
  if (result.code !== 0) throw new Error(`Network preparation failed: ${result.error || result.output}`);
  console.log(result.output);
} finally { client.end(); }
// Independent connections prove the primary SSH path and every added route before cancelling rollback.
for (const host of [config.host, ...addresses]) {
  client = await connectHost({ ...config, host });
  try {
    const result = await execute(client, 'sudo -n true && echo SSH_OK');
    if (result.code !== 0 || !result.output.includes('SSH_OK')) throw new Error(`SSH failed for ${host}; timed rollback remains armed`);
    console.log(`${host}: key authentication and sudo verified`);
  } finally { client.end(); }
}
client = await connectHost(config);
try {
  const result = await execute(client, `sudo -n systemctl stop ${unit}.timer && sudo -n rm -f ${rollback}`);
  if (result.code !== 0) throw new Error('Could not disarm rollback');
} finally { client.end(); }
for (const record of inventory.additionalIPv4) record.guestConfigurationVerified = true;
inventory.guestNetworkConfiguration = { interface: iface, overlay: target, backup, verifiedAt: new Date().toISOString(), rebootTested: false };
await writeFile(inventoryFile, JSON.stringify(inventory, null, 2) + '\n');
console.log('IPv4 configuration saved and independently verified; rollback disarmed.');
