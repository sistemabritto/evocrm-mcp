import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createMcpServer } from './server.js';

try {
  const server = createMcpServer(loadConfig());
  await server.connect(new StdioServerTransport());
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { void server.close().finally(() => process.exit(0)); });
  }
} catch {
  console.error('Não foi possível iniciar o MCP stdio. Verifique a configuração de ambiente.');
  process.exitCode = 1;
}
