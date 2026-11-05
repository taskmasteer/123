// Bootstrap input JSON is received on stdin, including the one-time password.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isIPv4 } from 'node:net';
import ssh2 from 'ssh2';
const { utils } = ssh2;
import { connectHost, execute, fingerprint } from './lib/linux-ssh.mjs';
import { protectSecret } from '../dist/apps/server/src/secrets.js';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
input = '';
if (!isIPv4(request.sourceIPv4)) throw new Error('Controller IPv4 is required');
const destination = process.argv[2];
if (!destination) throw new Error('Encrypted host config path required');
await mkdir(dirname(destination), { recursive: true });
let config;
try { config = JSON.parse(await readFile(destination, 'utf8')); }
catch (err) {
  if (err.code !== 'ENOENT') throw err;
  const keys = utils.generateKeyPairSync('ed25519', { comment: 'site-factory-controller' });
  config = { ...request.host, sourceIPv4: request.sourceIPv4, publicKey: keys.public,
    keyFingerprint: fingerprint(utils.parseKey(keys.private).getPublicSSH()),
    privateKeyEncrypted: await protectSecret(keys.private), createdAt: new Date().toISOString() };
  await writeFile(destination, JSON.stringify(config, null, 2), { flag: 'wx' });
}
if (config.host !== request.host.host || config.username !== request.host.username || config.hostFingerprint !== request.host.hostFingerprint || config.sourceIPv4 !== request.sourceIPv4) throw new Error('Existing host identity differs');
const line = `from="${request.sourceIPv4}",restrict ${config.publicKey}`;
if (/[\r\n]/.test(line)) throw new Error('Invalid public key');
const client = await connectHost(config, { password: request.password });
request.password = undefined;
try {
  const result = await execute(client, 'umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; chmod 700 ~/.ssh; chmod 600 ~/.ssh/authorized_keys; IFS= read -r key; grep -qxF -- "$key" ~/.ssh/authorized_keys || printf "%s\n" "$key" >> ~/.ssh/authorized_keys', line + '\n');
  if (result.code !== 0) throw new Error('Public key installation failed');
} finally { client.end(); }
const verified = await connectHost(config);
try {
  const result = await execute(verified, 'whoami; sudo -n true && echo SUDO_OK');
  if (result.code !== 0) throw new Error('Key login or sudo verification failed');
  console.log(JSON.stringify({ authenticated: true, keyFingerprint: config.keyFingerprint, result: result.output }));
} finally { verified.end(); }
