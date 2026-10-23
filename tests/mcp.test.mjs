import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig, VERSION } from '../dist/config.js';
import { CrmClient } from '../dist/crm-client.js';
import { createMcpServer } from '../dist/server.js';
import { createHttpHandler, createHttpServer, authenticate } from '../dist/http.js';

// All credentials exist only in memory and are randomly generated for each test run.
const crmToken = randomBytes(32).toString('hex');
const readToken = randomBytes(32).toString('hex');
const writeToken = randomBytes(32).toString('hex');
const hash = token => createHash('sha256').update(token).digest('hex');
const env = { EVOCRM_BASE_URL: 'https://crm.example.invalid', EVOCRM_API_TOKEN: crmToken,
  MCP_TOKEN_SHA256_READ: hash(readToken), MCP_TOKEN_SHA256_WRITE: hash(writeToken) };
const config = loadConfig(env, 'http');
const writes = ['contact_create', 'contact_update', 'contact_note_add', 'message_send', 'conversation_assign',
  'conversation_set_status', 'labels_add', 'pipeline_item_create', 'pipeline_item_move', 'pipeline_item_update', 'task_create', 'task_complete'];
const reads = ['contacts_list', 'contacts_search', 'contact_get', 'conversations_list', 'conversation_get', 'messages_list',
  'pipelines_list', 'pipeline_get', 'pipeline_items_list', 'tasks_list', 'inboxes_list', 'agents_list'];
const json = data => Response.json({ success: true, data });
const parsed = result => JSON.parse(result.content[0].text);

async function connect(t, scope = 'read', fetcher = async () => json([]), timeout = 15000) {
  const server = createMcpServer(config, scope, new CrmClient(config, fetcher, timeout));
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(a);
  await client.connect(b);
  return client;
}

test('configuração valida origem fixa, escopo padrão e hashes HTTP', () => {
  assert.equal(loadConfig(env).scope, 'read');
  for (const base of ['https://user:password@example.invalid', 'https://example.invalid/api', 'file:///tmp', 'https://example.invalid/?x=1']) {
    assert.throws(() => loadConfig({ ...env, EVOCRM_BASE_URL: base }));
  }
  assert.throws(() => loadConfig({ ...env, MCP_SCOPE: 'admin' }));
  assert.throws(() => loadConfig({ EVOCRM_BASE_URL: env.EVOCRM_BASE_URL }));
  assert.throws(() => loadConfig({ ...env, MCP_TOKEN_SHA256_READ: '', MCP_TOKEN_SHA256_WRITE: '' }, 'http'));
  assert.throws(() => loadConfig({ ...env, MCP_TOKEN_SHA256_READ: 'hash-invalido' }, 'http'));
  assert.throws(() => loadConfig({ ...env, MCP_TOKEN_SHA256_WRITE: env.MCP_TOKEN_SHA256_READ }, 'http'));
  assert.throws(() => loadConfig({ ...env, MCP_ALLOWED_ORIGINS: '*' }, 'http'));
});

test('read registra somente 12 leituras e impede chamada de escrita', async t => {
  let calls = 0;
  const client = await connect(t, 'read', async () => { calls++; return json([]); });
  const list = await client.listTools();
  assert.deepEqual(list.tools.map(x => x.name).sort(), [...reads].sort());
  const result = await client.callTool({ name: 'message_send', arguments: { conversation_id: 'synthetic-1', content: 'teste sintético' } });
  assert.equal(result.isError, true);
  assert.equal(calls, 0);
});

test('write registra 24 tools com schemas descritos e annotations conservadoras', async t => {
  const client = await connect(t, 'write');
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(x => x.name).sort(), [...reads, ...writes].sort());
  for (const tool of tools) {
    assert.match(tool.name, /^[a-z]+(?:_[a-z]+)+$/);
    assert.ok(tool.description);
    assert.equal(tool.annotations.readOnlyHint, reads.includes(tool.name));
    assert.equal(tool.annotations.idempotentHint, reads.includes(tool.name));
    assert.equal(tool.annotations.openWorldHint, true);
    for (const field of Object.values(tool.inputSchema.properties)) assert.ok(field.description);
  }
  assert.equal(tools.find(x => x.name === 'task_complete').annotations.destructiveHint, true);
});

test('requisição CRM envia token, User-Agent, Accept, timeout e redirect manual', async t => {
  const client = await connect(t, 'read', async (url, options) => {
    assert.equal(url.origin, config.baseUrl);
    assert.equal(url.pathname, '/api/v1/contacts');
    assert.equal(url.searchParams.get('page'), '2');
    assert.equal(url.searchParams.get('per_page'), '2');
    assert.equal(options.headers.api_access_token === crmToken, true);
    assert.equal(options.headers['User-Agent'], `evocrm-mcp/${VERSION}`);
    assert.equal(options.headers.Accept, 'application/json');
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
    return json([{ id: 'synthetic-1' }, { id: 'synthetic-2' }, { id: 'synthetic-3' }]);
  });
  const result = parsed(await client.callTool({ name: 'contacts_list', arguments: { page: 2, limit: 2 } }));
  assert.equal(result.items.length, 2);
  assert.equal(result.pagination.truncated, true);
});

test('paginação rejeita limite acima de 100 antes de fetch e recorta coleções locais', async t => {
  let calls = 0;
  const client = await connect(t, 'read', async () => { calls++; return json(Array.from({ length: 5 }, (_, i) => ({ id: `synthetic-${i}` }))); });
  for (const args of [{ limit: 101 }, { limit: 0 }, { page: 0 }]) {
    assert.equal((await client.callTool({ name: 'contacts_list', arguments: args })).isError, true);
  }
  assert.equal(calls, 0);
  const page = parsed(await client.callTool({ name: 'pipelines_list', arguments: { page: 2, limit: 2 } }));
  assert.deepEqual(page.items.map(x => x.id), ['synthetic-2', 'synthetic-3']);
  assert.equal(page.pagination.total, 5);
  assert.equal(page.pagination.next_page, 3);
});

test('timeout de escrita retorna resultado desconhecido, sem retry e com recuperação', async t => {
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const client = await connect(t, 'write', async (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), 5);
  const result = await client.callTool({ name: 'message_send', arguments: { conversation_id: 'synthetic-1', content: 'teste sintético' } });
  assert.equal(result.isError, true);
  assert.equal(parsed(result).error, 'operation_outcome_unknown');
  assert.equal(parsed(result).retryable, false);
  assert.deepEqual(parsed(result).recoveryTools, ['messages_list']);
  assert.match(parsed(result).note, /Não repita/);
});

test('erro HTTP e success=false viram isError sem refletir corpo remoto', async t => {
  for (const response of [new Response('CORPO_REMOTO_OMITIDO', { status: 403 }), Response.json({ success: false, error: 'CORPO_REMOTO_OMITIDO' })]) {
    const client = await connect(t, 'read', async () => response);
    const result = await client.callTool({ name: 'contact_get', arguments: { contact_id: 'synthetic-1' } });
    assert.equal(result.isError, true);
    assert.doesNotMatch(JSON.stringify(result), /CORPO_REMOTO_OMITIDO/);
    assert.match(parsed(result).message, /CRM/);
  }
});

test('redirect não é seguido e IDs não podem alterar a origem ou caminho', async t => {
  let calls = 0;
  const client = await connect(t, 'read', async (_url, init) => { calls++; assert.equal(init.redirect, 'manual'); return new Response(null, { status: 302, headers: { Location: 'https://other.example.invalid' } }); });
  assert.equal((await client.callTool({ name: 'contact_get', arguments: { contact_id: 'https://other.example.invalid' } })).isError, true);
  assert.equal(calls, 0);
  const result = await client.callTool({ name: 'contact_get', arguments: { contact_id: 'synthetic-1' } });
  assert.equal(parsed(result).status, 302);
  assert.equal(calls, 1);
});

test('mapeamentos de escrita seguem os payloads e métodos do upstream', async t => {
  const observed = [];
  const client = await connect(t, 'write', async (url, init) => {
    observed.push({ path: url.pathname, method: init.method, body: JSON.parse(init.body ?? '{}') });
    return json({ id: 'synthetic-result' });
  });
  const cases = [
    ['contact_create', { name: 'Contato sintético' }, 'POST', '/contacts', { name: 'Contato sintético' }],
    ['contact_update', { contact_id: 'synthetic-contact', name: 'Contato sintético' }, 'PUT', '/contacts/synthetic-contact', { name: 'Contato sintético' }],
    ['contact_note_add', { contact_id: 'synthetic-contact', content: 'Nota sintética' }, 'POST', '/contacts/synthetic-contact/notes', { note: { content: 'Nota sintética' } }],
    ['message_send', { conversation_id: 'synthetic-conversation', content: 'Mensagem sintética' }, 'POST', '/conversations/synthetic-conversation/messages', { content: 'Mensagem sintética', private: false, message_type: 'outgoing' }],
    ['conversation_assign', { conversation_id: 'synthetic-conversation', assignee_id: null }, 'POST', '/conversations/synthetic-conversation/assignments', { assignee_id: null }],
    ['conversation_set_status', { conversation_id: 'synthetic-conversation', status: 'resolved' }, 'POST', '/conversations/synthetic-conversation/toggle_status', { status: 'resolved' }],
    ['pipeline_item_create', { pipeline_id: 'synthetic-pipeline', type: 'contact', item_id: 'synthetic-contact', pipeline_stage_id: 'synthetic-stage' }, 'POST', '/pipelines/synthetic-pipeline/pipeline_items', { type: 'contact', item_id: 'synthetic-contact', pipeline_stage_id: 'synthetic-stage' }],
    ['pipeline_item_move', { pipeline_id: 'synthetic-pipeline', pipeline_item_id: 'synthetic-item', new_stage_id: 'synthetic-stage' }, 'PATCH', '/pipelines/synthetic-pipeline/pipeline_items/synthetic-item/move_to_stage', { new_stage_id: 'synthetic-stage' }],
    ['pipeline_item_update', { pipeline_id: 'synthetic-pipeline', pipeline_item_id: 'synthetic-item', notes: 'Nota sintética' }, 'PATCH', '/pipelines/synthetic-pipeline/pipeline_items/synthetic-item', { notes: 'Nota sintética' }],
    ['task_create', { pipeline_id: 'synthetic-pipeline', pipeline_item_id: 'synthetic-item', title: 'Tarefa sintética' }, 'POST', '/pipelines/synthetic-pipeline/pipeline_items/synthetic-item/tasks', { task: { title: 'Tarefa sintética', task_type: 'follow_up', priority: 'low' } }],
    ['task_complete', { pipeline_id: 'synthetic-pipeline', task_id: 'synthetic-task' }, 'POST', '/pipelines/synthetic-pipeline/pipeline_tasks/synthetic-task/complete', {}],
  ];
  for (const [name, args, method, path, body] of cases) {
    assert.notEqual((await client.callTool({ name, arguments: args })).isError, true, name);
    assert.deepEqual(observed.at(-1), { method, path: `/api/v1${path}`, body });
  }
});

test('labels_add consulta a lista existente antes de adicionar, sem remover labels', async t => {
  let calls = 0;
  const client = await connect(t, 'write', async (url, init) => {
    assert.equal(url.pathname, '/api/v1/contacts/synthetic-1/labels');
    calls++;
    if (init.method === 'GET') return Response.json({ payload: ['sintetica-a'] });
    assert.deepEqual(JSON.parse(init.body), { labels: ['sintetica-a', 'sintetica-b'] });
    return Response.json({ payload: ['sintetica-a', 'sintetica-b'] });
  });
  assert.notEqual((await client.callTool({ name: 'labels_add', arguments: { entity: 'contact', entity_id: 'synthetic-1', labels: ['sintetica-b'] } })).isError, true);
  assert.equal(calls, 2);
});

test('leituras usam os caminhos upstream, inclusive recuperação paginada de notas', async t => {
  const calls = [];
  const client = await connect(t, 'read', async (url, init) => {
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    calls.push(new URL(url));
    if (url.pathname.endsWith('/notes')) return json([{ id: 'synthetic-note-1' }, { id: 'synthetic-note-2' }]);
    return json([]);
  });
  const cases = [
    ['contacts_search', { q: 'consulta sintética', limit: 2 }, '/contacts/search'],
    ['conversations_list', { status: 'all', limit: 2 }, '/conversations'],
    ['conversation_get', { conversation_id: 'synthetic-conversation' }, '/conversations/synthetic-conversation'],
    ['pipeline_get', { pipeline_id: 'synthetic-pipeline' }, '/pipelines/synthetic-pipeline'],
    ['pipeline_items_list', { pipeline_id: 'synthetic-pipeline' }, '/pipelines/synthetic-pipeline/pipeline_items'],
    ['tasks_list', { pipeline_id: 'synthetic-pipeline', pipeline_item_id: 'synthetic-item' }, '/pipelines/synthetic-pipeline/pipeline_items/synthetic-item/tasks'],
    ['inboxes_list', { page: 2, limit: 2 }, '/inboxes'],
    ['agents_list', { page: 2, limit: 2 }, '/agents'],
  ];
  for (const [name, args, path] of cases) {
    assert.notEqual((await client.callTool({ name, arguments: args })).isError, true, name);
    const url = calls.at(-1);
    assert.equal(url.pathname, `/api/v1${path}`);
    if (['inboxes_list', 'agents_list'].includes(name)) {
      assert.equal(url.searchParams.get('page'), '2');
      assert.equal(url.searchParams.get('per_page'), '2');
    }
    if (name === 'agents_list') assert.equal(url.searchParams.get('skip'), '2');
  }
  const result = parsed(await client.callTool({ name: 'contact_get', arguments: { contact_id: 'synthetic-contact', include_notes: true, page: 2, limit: 1 } }));
  assert.equal(calls.at(-1).pathname, '/api/v1/contacts/synthetic-contact/notes');
  assert.deepEqual(result.notes.items.map(x => x.id), ['synthetic-note-2']);
});

test('escrita com resposta JSON inválida ou falha de rede permanece incerta e nunca é repetida', async t => {
  for (const fetcher of [async () => new Response('resposta sintética inválida'), async () => { throw new Error('detalhe remoto omitido'); }]) {
    let calls = 0;
    const client = await connect(t, 'write', async (...args) => { calls++; return fetcher(...args); });
    const result = await client.callTool({ name: 'task_complete', arguments: { pipeline_id: 'synthetic-pipeline', task_id: 'synthetic-task' } });
    assert.equal(parsed(result).error, 'operation_outcome_unknown');
    assert.deepEqual(parsed(result).recoveryTools, ['tasks_list']);
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(result), /detalhe remoto/);
  }
});

test('mensagens usam cursor sem perder itens quando limit é menor que a janela', async t => {
  const client = await connect(t, 'read', async () => json(Array.from({ length: 20 }, (_, i) => ({ id: `synthetic-${i}` }))));
  const result = parsed(await client.callTool({ name: 'messages_list', arguments: { conversation_id: 'synthetic-1', limit: 2 } }));
  assert.deepEqual(result.items.map(x => x.id), ['synthetic-18', 'synthetic-19']);
  assert.equal(result.pagination.next_before, 'synthetic-18');
  const after = parsed(await client.callTool({ name: 'messages_list', arguments: { conversation_id: 'synthetic-1', limit: 2, after: 'synthetic-0' } }));
  assert.deepEqual(after.items.map(x => x.id), ['synthetic-0', 'synthetic-1']);
  assert.equal((await client.callTool({ name: 'messages_list', arguments: { conversation_id: 'synthetic-1', page: 2 } })).isError, true);
});

test('auth HTTP usa hashes por escopo e não aceita token do CRM como bearer MCP', () => {
  assert.equal(authenticate(`Bearer ${readToken}`, config), 'read');
  assert.equal(authenticate(`Bearer ${writeToken}`, config), 'write');
  assert.equal(authenticate(`Bearer ${crmToken}`, config), null);
  assert.equal(authenticate(null, config), null);
  assert.equal(authenticate(`Basic ${readToken}`, config), null);
  assert.equal(authenticate(`Bearer ${readToken}`, { ...config, tokenHashRead: undefined }), null);
});

test('HTTP rejeita bearer inválido, origem não permitida, GET e rota desconhecida', async () => {
  const handler = createHttpHandler(config);
  const request = (path = '/mcp', init = {}) => new Request(`http://localhost${path}`, { method: 'POST', ...init });
  const unauthorized = await handler(request());
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get('www-authenticate'), /Bearer/);
  assert.equal((await handler(request('/mcp', { headers: { origin: 'https://other.example.invalid' } }))).status, 403);
  const get = await handler(request('/mcp', { method: 'GET' }));
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
  assert.equal((await handler(request('/other'))).status, 404);
});

test('origem autorizada recebe CORS, mas continua exigindo bearer no POST', async () => {
  const origin = 'https://assistant.example.invalid';
  const handler = createHttpHandler({ ...config, allowedOrigins: [origin] });
  const response = await handler(new Request('http://localhost/mcp', { method: 'POST', headers: { Origin: origin } }));
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  const options = await handler(new Request('http://localhost/mcp', { method: 'OPTIONS', headers: { Origin: origin } }));
  assert.equal(options.status, 204);
  assert.match(options.headers.get('access-control-allow-headers'), /Authorization/);
});

test('HTTP real com SDK: initialize, chamadas stateless e isolamento read/write por requisição', async t => {
  const httpServer = createHttpServer(config, new CrmClient(config, async () => json([])));
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  t.after(() => new Promise(resolve => { httpServer.close(resolve); httpServer.closeAllConnections(); }));
  const url = new URL(`http://127.0.0.1:${httpServer.address().port}/mcp`);
  for (const [token, count] of [[writeToken, 24], [readToken, 12], [readToken, 12]]) {
    const client = new Client({ name: 'http-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    await client.connect(transport);
    assert.equal(transport.sessionId, undefined);
    assert.equal((await client.listTools()).tools.length, count);
    assert.equal(parsed(await client.callTool({ name: 'contacts_list', arguments: { limit: 2 } })).items.length, 0);
    await client.close();
  }
});

test('stdio real com SDK lista somente leituras sem fazer chamadas ao CRM', async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/stdio.js'], env: { ...env, MCP_SCOPE: 'read' }, stderr: 'pipe' });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 12);
  } finally { await client.close(); }
});
