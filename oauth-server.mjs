// OAuth 2.1 (DCR + CIMD + PKCE S256) front for evocrm-mcp, for Claude custom connectors.
// Single-owner login: one connector password (scrypt hash in env). Tokens are opaque, stored hashed.
import { createServer } from 'node:http';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { loadConfig } from './dist/config.js';
import { createMcpServer } from './dist/server.js';
import { CrmClient } from './dist/crm-client.js';
import { iniciarMonitor } from './dist/legal/monitor.js';

const env = process.env;
if (env.EVOCRM_API_TOKEN_FILE) env.EVOCRM_API_TOKEN = readFileSync(env.EVOCRM_API_TOKEN_FILE, 'utf8').trim();
const PUBLIC = (env.PUBLIC_URL || '').replace(/\/$/, '');           // https://mcp.example.com
const RESOURCE = PUBLIC + '/mcp';
const ORG = env.MCP_ORG_NAME || 'Evo CRM';                            // nome exibido na tela de login
const STATE = env.STATE_FILE || '/data/state.json';
const PASS_HASH = (env.CONNECTOR_PASSWORD_SCRYPT_FILE ? readFileSync(env.CONNECTOR_PASSWORD_SCRYPT_FILE, 'utf8') : env.CONNECTOR_PASSWORD_SCRYPT || '').trim(); // salt_hex:hash_hex
const DISABLED = (env.MCP_DISABLED_TOOLS || '').split(',').map(s => s.trim()).filter(Boolean);
const ACCESS_TTL = 3600, REFRESH_TTL = 30 * 86400, CODE_TTL = 300;
if (!PUBLIC.startsWith('https://') || !/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(PASS_HASH)) { console.error('Config inválida (PUBLIC_URL/senha).'); process.exit(1); }
const config = loadConfig({ ...env, MCP_SCOPE: 'write' }, 'stdio');
delete env.EVOCRM_API_TOKEN;

const sha = s => createHash('sha256').update(s).digest('hex');
const rnd = (n = 32) => randomBytes(n).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);
let db = { clients: {}, access: {}, refresh: {} };
try { if (existsSync(STATE)) db = { ...db, ...JSON.parse(readFileSync(STATE, 'utf8')) }; } catch { console.error('state ilegível; iniciando vazio'); }
const save = () => { const t = now();
  for (const [k, v] of Object.entries(db.access)) if (v.exp < t) delete db.access[k];
  for (const [k, v] of Object.entries(db.refresh)) if (v.exp < t) delete db.refresh[k];
  writeFileSync(STATE + '.tmp', JSON.stringify(db), { mode: 0o600 }); renameSync(STATE + '.tmp', STATE); };
const codes = new Map(), txns = new Map(), fails = new Map();

// Callbacks aceitos: Claude, ChatGPT/Codex, Grok Bot (grok.com / cursor.com) e loopback (Codex CLI, apps desktop).
const EXACT_REDIRECTS = new Set([
  'https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback',
  'https://chatgpt.com/connector_platform_oauth_redirect', 'https://chatgpt.com/connector/oauth',
  'https://grok.com/connectors-oauth-exchange-code/', 'https://grok.com/connectors/oauth/callback',
  'https://www.cursor.com/bot/mcp/oauth/callback', 'https://www.cursor.com/agents/mcp/oauth/callback',
  'cursor://anysphere.cursor-mcp/oauth/callback',
]);
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
const isLoopback = x => x.protocol === 'http:' && LOOPBACK.includes(x.hostname) && /^\/callback(\/[A-Za-z0-9_-]{1,64})?$/.test(x.pathname) && !x.search && !x.hash;
const okRedirect = (u) => { try { const x = new URL(u);
  if (EXACT_REDIRECTS.has(x.href)) return true;
  if (x.protocol === 'https:' && x.hostname === 'chatgpt.com' && /^\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/.test(x.pathname) && !x.search && !x.hash) return true;
  return isLoopback(x);
} catch { return false; } };
// RFC 8252 §7.3: em loopback a porta pode variar; host e caminho precisam bater exatamente.
const redirectMatches = (registered, given) => registered.some(r => { if (r === given) return true;
  try { const a = new URL(r), b = new URL(given); return isLoopback(a) && isLoopback(b) && a.hostname === b.hostname && a.pathname === b.pathname; } catch { return false; } });
const appName = host => /claude|anthropic/.test(host) ? 'Claude' : /chatgpt|openai/.test(host) ? 'ChatGPT / Codex' : /grok|cursor|x\.ai/.test(host) ? 'Grok Bot' : host;

// CIMD (client_id = URL do documento): Claude, ChatGPT/Codex e Grok Bot. Cache de 10 min.
const CIMD_HOSTS = /(^|\.)(claude\.ai|claude\.com|anthropic\.com|chatgpt\.com|openai\.com|cursor\.com|grok\.com|x\.ai)$/;
const cimdCache = new Map();
async function getClient(id) {
  if (db.clients[id]) return db.clients[id];
  let u; try { u = new URL(id); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || !CIMD_HOSTS.test(u.hostname)) return null;
  const hit = cimdCache.get(id); if (hit && hit.exp > Date.now()) return hit.client;
  try { const r = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } });
    if (!r.ok) return null; const txt = await r.text(); if (txt.length > 20000) return null; const m = JSON.parse(txt);
    if (m.client_id !== id || !Array.isArray(m.redirect_uris)) return null;
    const client = { client_id: id, redirect_uris: m.redirect_uris.filter(okRedirect), client_name: String(m.client_name || appName(u.hostname)).slice(0, 80), cimd: true };
    if (!client.redirect_uris.length) return null;
    cimdCache.set(id, { client, exp: Date.now() + 600e3 }); return client;
  } catch { return null; }
}

const ipOf = req => (req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean).pop() || req.socket.remoteAddress || '?';
const limited = ip => { const t = Date.now(); const f = (fails.get(ip) || []).filter(x => t - x < 15 * 60e3); fails.set(ip, f);
  const g = [...fails.values()].flat().filter(x => t - x < 3600e3).length; return f.length >= 5 || g >= 30; };
const checkPass = p => { const [s, h] = PASS_HASH.split(':'); const d = scryptSync(String(p || ''), Buffer.from(s, 'hex'), 64);
  return timingSafeEqual(d, Buffer.from(h, 'hex')); };

const json = (res, status, obj, extra = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra }); res.end(JSON.stringify(obj)); };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
  // form-action também vale para o redirect depois do POST: liste todos os destinos de retorno.
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://claude.ai https://claude.com https://chatgpt.com https://grok.com https://www.cursor.com cursor: http://localhost:* http://127.0.0.1:* http://[::1]:*; frame-ancestors 'none'", 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
  res.end(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(ORG)} — CRM</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f1ea;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}main{background:#fff;padding:28px;border-radius:12px;max-width:380px;width:90%;box-shadow:0 4px 20px #0002}h1{font-size:20px;margin:0 0 8px;color:#1f2a44}p{color:#444;font-size:14px}input{width:100%;box-sizing:border-box;padding:12px;font-size:16px;border:1px solid #bbb;border-radius:8px;margin:8px 0 14px}button{width:100%;padding:12px;font-size:16px;background:#1f2a44;color:#fff;border:0;border-radius:8px;cursor:pointer}.e{color:#b00020}</style></head><body><main>${body}</main></body></html>`); };

async function readBody(req, max = 65536) { const ch = []; let n = 0; for await (const c of req) { n += c.length; if (n > max) throw new Error('big'); ch.push(c); } return Buffer.concat(ch); }
const form = buf => Object.fromEntries(new URLSearchParams(buf.toString('utf8')));

function loginPage(res, txn, client, redirectHost, err) {
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(redirectHost) || redirectHost === 'anysphere.cursor-mcp';
  const app = local ? (client.client_name || 'app no computador') : appName(redirectHost);
  page(res, err ? 401 : 200, `<h1>Conectar ${esc(app)} ao CRM</h1><p><b>${esc(client.client_name || app)}</b> quer acessar o CRM de ${esc(ORG)} (contatos, conversas, funil, tarefas e modelos de WhatsApp).</p><p>Retorno para: <b>${esc(redirectHost)}</b></p>
${err ? `<p class="e">${esc(err)}</p>` : ''}<form method="post" action="/authorize"><input type="hidden" name="txn" value="${esc(txn)}"><label>Senha do conector<input type="password" name="password" autocomplete="current-password" required autofocus></label><button type="submit">Autorizar</button></form>`);
}

function issueTokens(client_id, family = rnd(16)) {
  const at = rnd(), rt = rnd(); const t = now();
  db.access[sha(at)] = { client_id, exp: t + ACCESS_TTL };
  db.refresh[sha(rt)] = { client_id, exp: t + REFRESH_TTL, family };
  save();
  return { access_token: at, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: rt, scope: 'crm' };
}

const prm = { resource: RESOURCE, authorization_servers: [PUBLIC], scopes_supported: ['crm'], bearer_methods_supported: ['header'], resource_name: `CRM ${ORG}` };
const asm = { issuer: PUBLIC, authorization_endpoint: PUBLIC + '/authorize', token_endpoint: PUBLIC + '/token', registration_endpoint: PUBLIC + '/register',
  response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'], scopes_supported: ['crm'], client_id_metadata_document_supported: true,
  authorization_response_iss_parameter_supported: true };   // RFC 9207: o /authorize sempre devolve iss

// Proteção contra DNS rebinding: navegador só de origens conhecidas (o token Bearer continua obrigatório).
const ALLOWED_ORIGINS = new Set(['https://claude.ai', 'https://claude.com', 'https://chatgpt.com', 'https://grok.com', 'https://www.cursor.com', 'https://cursor.com']);
async function handleMcp(req, res) {
  if (req.headers.origin && !ALLOWED_ORIGINS.has(req.headers.origin)) return json(res, 403, { error: 'Origem não autorizada.' });
  const m = (req.headers.authorization || '').match(/^Bearer ([A-Za-z0-9_-]{20,200})$/);
  const rec = m && db.access[sha(m[1])];
  if (!rec || rec.exp < now()) return json(res, 401, { error: 'invalid_token' }, { 'WWW-Authenticate': `Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource", scope="crm"` });
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' }, { Allow: 'POST' });
  let body; try { body = await readBody(req, 1024 * 1024); } catch { return json(res, 413, { error: 'Corpo grande demais.' }); }
  const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  const request = new Request(new URL(req.url, 'http://localhost'), { method: 'POST', headers, body });
  const server = createMcpServer(config, 'write');
  for (const name of DISABLED) server._registeredTools?.[name]?.disable?.();
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try { await server.connect(transport); const r = await transport.handleRequest(request);
    res.writeHead(r.status, { ...Object.fromEntries(r.headers), 'Cache-Control': 'no-store' }); res.end(Buffer.from(await r.arrayBuffer()));
  } catch { if (!res.headersSent) json(res, 500, { error: 'Falha MCP.' }); } finally { await server.close(); }
}

// Endpoints internos para agentes nativos do CRM: Bearer estático por endpoint e só pela rede interna
// (pelo proxy reverso, com X-Forwarded-For, é sempre recusado).
//   /agente/mcp       AGENT_TOKEN_FILE       ferramentas do agente de e-mails (monitor jurídico)
//   /atendimento/mcp  ATTENDANCE_TOKEN_FILE  ferramentas do agente de atendimento (equipe, aprovações, notas)
const tokenSha = f => (f && existsSync(f) ? createHash('sha256').update(readFileSync(f, 'utf8').trim()).digest() : null);
const INTERNOS = { '/agente/mcp': { sha: tokenSha(env.AGENT_TOKEN_FILE), toolset: 'emails' }, '/atendimento/mcp': { sha: tokenSha(env.ATTENDANCE_TOKEN_FILE), toolset: 'atendimento' } };
async function handleAgentMcp(req, res, alvo) {
  if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers.origin) return json(res, 403, { error: 'Só pela rede interna.' });
  const m = (req.headers.authorization || '').match(/^Bearer ([A-Za-z0-9_-]{20,200})$/);
  if (!alvo.sha || !m || !timingSafeEqual(createHash('sha256').update(m[1]).digest(), alvo.sha)) return json(res, 401, { error: 'invalid_token' });
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' }, { Allow: 'POST' });
  let body; try { body = await readBody(req, 1024 * 1024); } catch { return json(res, 413, { error: 'Corpo grande demais.' }); }
  const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  const request = new Request(new URL(req.url, 'http://localhost'), { method: 'POST', headers, body });
  const server = createMcpServer(config, 'write', new CrmClient(config), alvo.toolset);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try { await server.connect(transport); const r = await transport.handleRequest(request);
    res.writeHead(r.status, { ...Object.fromEntries(r.headers), 'Cache-Control': 'no-store' }); res.end(Buffer.from(await r.arrayBuffer()));
  } catch { if (!res.headersSent) json(res, 500, { error: 'Falha MCP.' }); } finally { await server.close(); }
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, PUBLIC); const p = url.pathname;
    if (p === '/healthz') return json(res, 200, { ok: true });
    if (p === '/.well-known/oauth-protected-resource' || p === '/.well-known/oauth-protected-resource/mcp') return json(res, 200, prm);
    if (p === '/.well-known/oauth-authorization-server' || p === '/.well-known/oauth-authorization-server/mcp' || p === '/.well-known/openid-configuration') return json(res, 200, asm);
    if (p === '/mcp') return await handleMcp(req, res);
    if (Object.hasOwn(INTERNOS, p)) return await handleAgentMcp(req, res, INTERNOS[p]);
    if (p === '/register' && req.method === 'POST') {
      let m; try { m = JSON.parse((await readBody(req)).toString('utf8')); } catch { return json(res, 400, { error: 'invalid_client_metadata' }); }
      // Clientes como o Grok Bot registram vários callbacks de uma vez; guardamos só os permitidos.
      const uris = (Array.isArray(m.redirect_uris) ? m.redirect_uris : []).filter(u => typeof u === 'string' && okRedirect(u)).slice(0, 10);
      if (!uris.length) return json(res, 400, { error: 'invalid_redirect_uri', error_description: 'Somente callbacks do Claude, ChatGPT/Codex, Grok Bot ou loopback são aceitos.' });
      if (Object.keys(db.clients).length > 500) return json(res, 400, { error: 'invalid_client_metadata', error_description: 'limite de clientes' });
      const id = 'c_' + rnd(16); const method = ['client_secret_post', 'client_secret_basic'].includes(m.token_endpoint_auth_method) ? m.token_endpoint_auth_method : 'none';
      const c = { client_id: id, redirect_uris: uris, client_name: String(m.client_name || 'Claude').slice(0, 80), token_endpoint_auth_method: method, created: now() };
      let secret; if (method !== 'none') { secret = rnd(); c.secret_hash = sha(secret); }
      db.clients[id] = c; save();
      return json(res, 201, { client_id: id, ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}), client_id_issued_at: c.created,
        redirect_uris: uris, client_name: c.client_name, token_endpoint_auth_method: method, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
    }
    if (p === '/authorize' && req.method === 'GET') {
      const q = Object.fromEntries(url.searchParams); const client = await getClient(q.client_id || '');
      if (!client) return page(res, 400, '<h1>Cliente desconhecido</h1><p>Remova e adicione o conector de novo no app (Claude, ChatGPT/Codex ou Grok).</p>');
      if (!q.redirect_uri || !redirectMatches(client.redirect_uris, q.redirect_uri) || !okRedirect(q.redirect_uri)) return page(res, 400, '<h1>Endereço de retorno inválido</h1>');
      if (q.response_type !== 'code' || q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge || '')) return page(res, 400, '<h1>Pedido inválido (PKCE S256 obrigatório)</h1>');
      const txn = rnd(); txns.set(txn, { client, q, exp: Date.now() + 10 * 60e3 });
      return loginPage(res, txn, client, new URL(q.redirect_uri).host);
    }
    if (p === '/authorize' && req.method === 'POST') {
      const f = form(await readBody(req)); const t = txns.get(f.txn || '');
      if (!t || t.exp < Date.now()) return page(res, 400, '<h1>Sessão expirada</h1><p>Volte ao app e clique em conectar de novo.</p>');
      const ip = ipOf(req);
      if (limited(ip)) return page(res, 429, '<h1>Muitas tentativas</h1><p>Aguarde 15 minutos e tente de novo.</p>');
      if (!checkPass(f.password)) { fails.get(ip).push(Date.now()); console.error(`login falhou ip=${ip}`); return loginPage(res, f.txn, t.client, new URL(t.q.redirect_uri).host, 'Senha incorreta.'); }
      txns.delete(f.txn); const code = rnd();
      codes.set(code, { client_id: t.client.client_id, redirect_uri: t.q.redirect_uri, challenge: t.q.code_challenge, exp: Date.now() + CODE_TTL * 1000 });
      console.error(`autorizado client=${t.client.client_id} ip=${ip}`);
      const back = new URL(t.q.redirect_uri); back.searchParams.set('code', code); if (t.q.state) back.searchParams.set('state', t.q.state); back.searchParams.set('iss', PUBLIC);
      res.writeHead(302, { Location: back.href, 'Cache-Control': 'no-store' }); return res.end();
    }
    if (p === '/token' && req.method === 'POST') {
      const f = form(await readBody(req)); let cid = f.client_id, csec = f.client_secret;
      const basic = (req.headers.authorization || '').match(/^Basic (.+)$/i);
      if (basic) { const [a, b] = Buffer.from(basic[1], 'base64').toString().split(':'); cid = decodeURIComponent(a || ''); csec = decodeURIComponent(b || ''); }
      const client = await getClient(cid || ''); if (!client) return json(res, 401, { error: 'invalid_client' });
      if (client.secret_hash && !(csec && sha(csec) === client.secret_hash)) return json(res, 401, { error: 'invalid_client' });
      if (f.grant_type === 'authorization_code') {
        const c = codes.get(f.code || ''); codes.delete(f.code || '');
        if (!c || c.exp < Date.now() || c.client_id !== client.client_id || c.redirect_uri !== f.redirect_uri) return json(res, 400, { error: 'invalid_grant' });
        if (createHash('sha256').update(f.code_verifier || '').digest('base64url') !== c.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE' });
        return json(res, 200, issueTokens(client.client_id));
      }
      if (f.grant_type === 'refresh_token') {
        const h = sha(f.refresh_token || ''); const r = db.refresh[h];
        if (!r || r.exp < now() || r.client_id !== client.client_id) return json(res, 400, { error: 'invalid_grant' });
        delete db.refresh[h]; return json(res, 200, issueTokens(client.client_id, r.family));
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    if (p === '/' ) return page(res, 200, '<h1>CRM ' + esc(ORG) + ' — MCP</h1><p>Endereço do conector (Claude, ChatGPT/Codex, Grok Bot): <b>' + esc(RESOURCE) + '</b></p>');
    return json(res, 404, { error: 'not_found' });
  } catch (e) { console.error('erro', e?.message); if (!res.headersSent) json(res, 500, { error: 'server_error' }); }
}).listen(Number(env.PORT || 3000), '0.0.0.0', () => { console.error('MCP OAuth no ar; ferramentas desativadas: ' + (DISABLED.join(',') || 'nenhuma')); iniciarMonitor(config); });
setInterval(() => { const t = Date.now(); for (const [k, v] of codes) if (v.exp < t) codes.delete(k); for (const [k, v] of txns) if (v.exp < t) txns.delete(k); }, 60e3).unref();
