import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DOCUSEAL_URL = 'https://assinatura.example.invalid';
process.env.DOCUSEAL_MCP_TOKEN = 'mcp-token-teste-1234567890';
process.env.DOCUSEAL_API_TOKEN = 'api-token-teste';
const { registerAssinatura } = await import('../dist/tools/assinatura.js');

test('assinatura: repassa ao MCP do DocuSeal e monta links de assinatura', async () => {
  const tools = {};
  registerAssinatura((name, d, schema, write, run) => { tools[name] = { write, run }; });
  assert.deepEqual(Object.keys(tools).sort(), ['assinatura_documentos_buscar', 'assinatura_enviar', 'assinatura_links', 'assinatura_modelo_carregar', 'assinatura_modelo_criar', 'assinatura_modelos_buscar']);
  assert.equal(tools.assinatura_enviar.write, true); assert.equal(tools.assinatura_modelos_buscar.write, false);
  const original = globalThis.fetch; const vistos = [];
  globalThis.fetch = async (url, init) => {
    vistos.push({ url: String(url), headers: init.headers, body: init.body && JSON.parse(init.body) });
    if (String(url).endsWith('/mcp')) return Response.json({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ id: 7, status: 'pending' }) }] } });
    return Response.json({ id: 7, status: 'pending', template: { name: 'Contrato' }, submitters: [{ name: 'Cliente', email: 'c@x.com', role: 'Contratante', status: 'sent', slug: 'abc123' }] });
  };
  try {
    const r = await tools.assinatura_enviar.run({ template_id: 3, submitters: [{ role: 'Contratante', name: 'Cliente', email: 'c@x.com' }] });
    assert.deepEqual(r, { id: 7, status: 'pending' });
    assert.equal(vistos[0].headers.Authorization, 'Bearer mcp-token-teste-1234567890');
    assert.equal(vistos[0].body.method, 'tools/call'); assert.equal(vistos[0].body.params.name, 'send_documents');
    const l = await tools.assinatura_links.run({ submission_id: 7 });
    assert.equal(l.signatarios[0].link, 'https://assinatura.example.invalid/s/abc123');
    assert.equal(vistos[1].headers['X-Auth-Token'], 'api-token-teste');
    globalThis.fetch = async () => new Response('{}', { status: 401 });
    await assert.rejects(tools.assinatura_modelos_buscar.run({ q: 'x', limit: 5 }), /recusou o token/);
  } finally { globalThis.fetch = original; }
});
