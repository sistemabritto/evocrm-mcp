// Intentionally opt-in. Only these four GET endpoints may reach the real CRM.
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../dist/config.js';
import { CrmClient } from '../dist/crm-client.js';
import { createMcpServer } from '../dist/server.js';

const local = {};
for (const line of (await readFile(new URL('../.env', import.meta.url), 'utf8')).split(/\r?\n/)) {
  const match = line.match(/^\s*(?:export\s+)?(EVOCRM_BASE_URL|EVOCRM_API_TOKEN)\s*=\s*(.*?)\s*$/);
  if (match) local[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
}
const config = loadConfig({ ...local, MCP_SCOPE: 'read' });
const paths = new Set(['/api/v1/inboxes', '/api/v1/pipelines', '/api/v1/contacts', '/api/v1/agents']);
const crm = new CrmClient(config, (url, init) => {
  const target = new URL(url);
  if (init.method !== 'GET' || target.origin !== config.baseUrl || !paths.has(target.pathname)) throw new Error('Consulta bloqueada.');
  return fetch(url, init);
});
const server = createMcpServer(config, 'read', crm);
const client = new Client({ name: 'live-read-check', version: '1.0.0' });
const [a, b] = InMemoryTransport.createLinkedPair();
try {
  await server.connect(a);
  await client.connect(b);
  for (const name of ['inboxes_list', 'pipelines_list', 'contacts_list', 'agents_list']) {
    const result = await client.callTool({ name, arguments: { limit: name === 'contacts_list' ? 2 : 20 } });
    const data = JSON.parse(result.content[0].text);
    // Never print raw tool results, exceptions, identifiers, URLs or credentials.
    console.log(JSON.stringify({ tool: name, status: result.isError ? 'erro' : 'ok',
      ...(result.isError ? { http_status: data.status ?? null } : { count: data.items.length }) }));
    if (result.isError) process.exitCode = 1;
  }
} catch {
  console.error('Teste de leitura não concluído; detalhes omitidos para preservar dados e credenciais.');
  process.exitCode = 1;
} finally { await client.close(); await server.close(); }
