import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { loadConfig, type Config, type Scope } from './config.js';
import { createMcpServer } from './server.js';
import type { CrmClient } from './crm-client.js';

const BODY_LIMIT = 1024 * 1024;
export function authenticate(authorization: string | null, config: Config): Scope | null {
  const token = authorization?.match(/^Bearer ([A-Za-z0-9._~+\/-]+=*)$/i)?.[1];
  if (!token || token.length > 4096) return null;
  const digest = createHash('sha256').update(token).digest();
  const matches = (hash?: string) => timingSafeEqual(digest, hash && /^[a-f0-9]{64}$/i.test(hash) ? Buffer.from(hash, 'hex') : Buffer.alloc(32));
  const read = matches(config.tokenHashRead) && !!config.tokenHashRead;
  const write = matches(config.tokenHashWrite) && !!config.tokenHashWrite;
  return read ? 'read' : write ? 'write' : null;
}

export function createHttpHandler(config: Config, crm?: CrmClient) {
  return async (request: Request): Promise<Response> => {
    const reply = (error: string, status: number, headers: HeadersInit = {}) =>
      Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
    if (new URL(request.url).pathname !== '/mcp') return reply('Rota não encontrada.', 404);
    const origin = request.headers.get('origin');
    if (origin && !config.allowedOrigins.includes(origin)) return reply('Origem não autorizada.', 403);
    const cors: Record<string, string> = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
      ...cors, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, MCP-Protocol-Version',
    } });
    if (request.method !== 'POST') return reply('Use POST com um cliente MCP Streamable HTTP.', 405, { ...cors, Allow: 'POST' });
    const scope = authenticate(request.headers.get('authorization'), config);
    if (!scope) return reply('Token MCP ausente ou inválido.', 401, { ...cors, 'WWW-Authenticate': 'Bearer realm="evocrm-mcp"' });
    const server = createMcpServer(config, scope, crm);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: BODY_LIMIT,
    });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(request);
      response.headers.set('Cache-Control', 'no-store');
      for (const [key, value] of Object.entries(cors)) response.headers.set(key, value);
      return response;
    } catch { return reply('Não foi possível processar a solicitação MCP.', 500, cors); }
    finally { await server.close(); }
  };
}

export function createHttpServer(config: Config, crm?: CrmClient): Server {
  const handler = createHttpHandler(config, crm);
  const server = createServer(async (req, res) => {
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) {
        if (Array.isArray(value)) for (const item of value) headers.append(key, item);
        else headers.set(key, value);
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > BODY_LIMIT) {
          res.writeHead(413, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ error: 'Corpo da solicitação excede 1 MiB.' }));
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const request = new Request(new URL(req.url ?? '/', 'http://localhost'), {
        method: req.method, headers,
        ...(!['GET', 'HEAD'].includes(req.method ?? 'GET') && size ? { body: Buffer.concat(chunks) } : {}),
      });
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Falha ao processar a solicitação HTTP.' }));
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = loadConfig(process.env, 'http');
    const server = createHttpServer(config);
    server.listen(config.port, '0.0.0.0', () => console.error(`MCP HTTP iniciado na porta ${config.port}.`));
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close());
    server.on('error', () => { console.error('Não foi possível iniciar o servidor HTTP.'); process.exitCode = 1; });
  } catch {
    console.error('Não foi possível iniciar o MCP HTTP. Verifique a configuração de ambiente e os hashes de autenticação.');
    process.exitCode = 1;
  }
}
