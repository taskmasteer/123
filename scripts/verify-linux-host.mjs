import { connectHost, execute, loadHost } from './lib/linux-ssh.mjs';

const config = await loadHost(process.argv[2]);
const client = await connectHost(config);
try {
  const result = await execute(client, 'sudo -n true && whoami && sudo -n nginx -t && systemctl is-active nginx && ip -brief -4 address && sudo -n ufw status');
  if (result.code !== 0) throw new Error('Linux host verification failed');
  console.log(JSON.stringify({ verifiedAt: new Date().toISOString(), host: config.host, authenticatedByKey: true, output: result.output, diagnostics: result.error }, null, 2));
} finally { client.end(); }
