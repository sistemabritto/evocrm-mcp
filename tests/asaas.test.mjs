import test from 'node:test';
import assert from 'node:assert/strict';
process.env.ASAAS_API_KEY = 'chave-teste';
process.env.ASAAS_BASE_URL = 'https://asaas.example.invalid/v3';
const { registerAsaas, registerAsaasAgente } = await import('../dist/tools/asaas.js');

const db = { customers: [{ id: 'cus_A', name: 'Cliente A', cpfCnpj: '12345678909' }, { id: 'cus_B', name: 'Cliente B', cpfCnpj: '98765432100' }],
  payments: [{ id: 'pay_1', customer: 'cus_A', value: 500, dueDate: '2026-12-10', status: 'PENDING', billingType: 'BOLETO', invoiceUrl: 'https://x/i/1', bankSlipUrl: 'https://x/b/1' },
             { id: 'pay_2', customer: 'cus_B', value: 900, dueDate: '2026-12-01', status: 'PENDING', billingType: 'PIX' }] };
const chamadas = [];
const fakeFetch = async (url, init) => {
  const u = new URL(String(url)); chamadas.push(`${init.method} ${u.pathname}${u.search}`);
  assert.equal(init.headers.access_token, 'chave-teste');
  const p = u.pathname.replace('/v3', '');
  if (p === '/customers' && init.method === 'GET') return Response.json({ data: db.customers.filter(c => !u.searchParams.get('cpfCnpj') || c.cpfCnpj === u.searchParams.get('cpfCnpj')) });
  if (p === '/payments' && init.method === 'GET') return Response.json({ data: db.payments.filter(x => !u.searchParams.get('customer') || x.customer === u.searchParams.get('customer')) });
  const m = p.match(/^\/payments\/(pay_\d)(\/.*)?$/);
  if (m && !m[2]) return Response.json(db.payments.find(x => x.id === m[1]));
  if (m && m[2] === '/identificationField') return Response.json({ identificationField: '34191.79001 01043.510047' });
  if (m && m[2] === '/pixQrCode') return Response.json({ payload: '00020126...', expirationDate: '2026-12-11' });
  if (p === '/payments' && init.method === 'POST') return Response.json({ id: 'pay_9', customer: 'cus_A', value: JSON.parse(init.body).value, dueDate: '2026-12-20', status: 'PENDING', billingType: 'UNDEFINED' });
  return new Response('{}', { status: 404 });
};

test('agente: só cobranças do próprio CPF; nada de escrita', async () => {
  const t = {}; registerAsaasAgente((n, d, s, w, run) => { t[n] = { w, run }; });
  assert.deepEqual(Object.keys(t).sort(), ['asaas_minhas_cobrancas', 'asaas_segunda_via']);
  assert.ok(Object.values(t).every(x => x.w === false));
  const orig = globalThis.fetch; globalThis.fetch = fakeFetch;
  try {
    const r = await t.asaas_minhas_cobrancas.run({ cpf_cnpj: '123.456.789-09' });
    assert.deepEqual(r.cobrancas.map(c => c.id), ['pay_1']);
    const v = await t.asaas_segunda_via.run({ payment_id: 'pay_1', cpf_cnpj: '12345678909' });
    assert.equal(v.linha_digitavel, '34191.79001 01043.510047'); assert.equal(v.pix_copia_e_cola, '00020126...');
    await assert.rejects(t.asaas_segunda_via.run({ payment_id: 'pay_2', cpf_cnpj: '12345678909' }), /não pertence/);
    await assert.rejects(t.asaas_minhas_cobrancas.run({ cpf_cnpj: '123' }), /CPF \(11/);
    assert.ok(!chamadas.some(c => c.startsWith('POST') || c.startsWith('DELETE')));
  } finally { globalThis.fetch = orig; }
});

test('conector: cria cobrança; sem transferência, estorno ou exclusão', async () => {
  const t = {}; registerAsaas((n, d, s, w, run) => { t[n] = { w, run }; });
  assert.ok(!Object.keys(t).some(n => /transf|refund|estorn|delete|excluir|remover/.test(n)));
  const orig = globalThis.fetch; globalThis.fetch = fakeFetch;
  try {
    const c = await t.asaas_cobranca_criar.run({ customer_id: 'cus_A', valor: 300, vencimento: '2026-12-20', forma: 'UNDEFINED', descricao: 'Honorários' });
    assert.equal(c.id, 'pay_9'); assert.equal(c.valor, 300);
  } finally { globalThis.fetch = orig; }
});
