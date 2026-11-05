import { Client } from 'ssh2';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { protectSecret } from '../../dist/apps/server/src/secrets.js';

export function fingerprint(key) {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

export async function connectHost(config, credentials) {
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(config.hostFingerprint ?? '')) throw new Error('Pinned host fingerprint required');
  const auth = credentials ?? { privateKey: await protectSecret(config.privateKeyEncrypted, true) };
  const client = new Client();
  await new Promise((resolve, reject) => {
    client.once('ready', resolve).once('error', reject).connect({
      host: config.host, port: config.port ?? 22, username: config.username,
      ...auth, hostVerifier: key => fingerprint(key) === config.hostFingerprint,
      readyTimeout: 20000, keepaliveInterval: 15000, keepaliveCountMax: 3,
    });
  });
  return client;
}

export async function execute(client, command, input = '', timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let output = '', error = '';
    const timer = setTimeout(() => { client.destroy(); reject(new Error('SSH operation timed out')); }, timeoutMs);
    client.exec(command, (err, stream) => {
      if (err) { clearTimeout(timer); return reject(err); }
      const append = (chunk, stderr) => {
        if (stderr) error += chunk; else output += chunk;
        if (output.length + error.length > 2 * 1024 * 1024) { clearTimeout(timer); client.destroy(); reject(new Error('SSH output limit exceeded')); }
      };
      stream.on('data', data => append(data, false));
      stream.stderr.on('data', data => append(data, true));
      stream.on('error', err => { clearTimeout(timer); reject(err); });
      stream.on('close', code => { clearTimeout(timer); resolve({ code, output, error }); });
      stream.end(input);
    });
  });
}

export async function loadHost(file) { return JSON.parse(await readFile(file, 'utf8')); }
