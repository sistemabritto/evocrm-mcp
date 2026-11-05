import test from 'node:test';
import assert from 'node:assert/strict';
process.env.ASAAS_API_KEY = 'chave-teste';
process.env.ASAAS_BASE_URL = 'https://asaas.example.invalid/v3';
process.env.TRACKING_ENABLED = 'true';
process.env.TRACKING_WEBHOOK_TOKEN = 'token-de-teste-com-mais-de-20';
const { registerTrafego } = await import('../dist/tools/trafego.js');
const { webhookAsaas, webhookDocuseal, tokenValido, webhooksAtivos } = await import('../dist/tracking/webhooks.js');

const UUID = '11111111-2222-4333-8444-555555555555';
function fakeCrm(naoAcha = () => false) {
  const calls = [];
  return { calls, request: async (method, path, query = {}, body) => {
    calls.push({ method, path, query, body });
    if (path === '/tracking/events' && naoAcha(body)) { const e = new Error('404'); e.status = 404; throw e; }
    return { data: { ok: true } };
  } };
}

test('ferramentas: leitura sem escrita; escrita só em origem e marco', async () => {
  const t = {}; const crm = fakeCrm();
  registerTrafego((n, d, s, w, run) => { t[n] = { w, run }; }, crm);
  assert.deepEqual(Object.keys(t).sort(), ['trafego_campanhas', 'trafego_funil', 'trafego_links', 'trafego_marco_registrar', 'trafego_origem_definir', 'trafego_status']);
  assert.deepEqual(Object.entries(t).filter(([, v]) => v.w).map(([k]) => k).sort(), ['trafego_marco_registrar', 'trafego_origem_definir']);
  await t.trafego_funil.run({ canal: 'meta', de: '2026-10-01', ate: '2026-10-31' });
  assert.deepEqual(crm.calls.at(-1), { method: 'GET', path: '/tracking/funnel', query: { channel: 'meta', from: '2026-10-01', to: '2026-10-31' }, body: undefined });
  await t.trafego_origem_definir.run({ contact_id: UUID, canal: 'google', campanha: 'ginv1' });
  assert.equal(crm.calls.at(-1).path, `/tracking/contacts/${UUID}/origin`);
});

test('token do webhook é conferido', () => {
  assert.ok(webhooksAtivos());
  assert.ok(tokenValido('token-de-teste-com-mais-de-20'));
  assert.ok(!tokenValido('outro')); assert.ok(!tokenValido(undefined));
});

test('Asaas: pagamento recebido vira marco; outros eventos são ignorados', async () => {
  const crm = fakeCrm();
  assert.deepEqual(await webhookAsaas(crm, { event: 'PAYMENT_CREATED', payment: { id: 'pay_1' } }), { ignorado: 'PAYMENT_CREATED' });
  const r = await webhookAsaas(crm, { event: 'PAYMENT_RECEIVED', payment: { id: 'pay_1', value: 1500, paymentDate: '2026-11-04', externalReference: UUID } });
  assert.equal(r.resultado, 'registrado');
  assert.deepEqual(crm.calls.at(-1).body, { stage: 'pagamento_efetuado', value: 1500, external_id: 'pay_1', occurred_at: '2026-11-04T12:00:00-03:00', contact_id: UUID, source: 'asaas' });
});

test('Asaas: sem referência, casa pelo telefone do cliente no Asaas', async () => {
  const crm = fakeCrm();
  const orig = globalThis.fetch;
  globalThis.fetch = async url => (new URL(String(url)).pathname.endsWith('/customers/cus_A')
    ? Response.json({ id: 'cus_A', mobilePhone: '71999990000', email: 'a@exemplo.com' }) : new Response('{}', { status: 404 }));
  try {
    const r = await webhookAsaas(crm, { event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_2', value: 300, customer: 'cus_A' } });
    assert.equal(r.por, 'telefone/e-mail');
    assert.equal(crm.calls.at(-1).body.phone, '71999990000');
  } finally { globalThis.fetch = orig; }
});

test('DocuSeal: envio concluído marca contrato para cada signatário encontrado', async () => {
  const crm = fakeCrm(b => b.email === 'escritorio@exemplo.com');
  const r = await webhookDocuseal(crm, { event_type: 'submission.completed', data: { id: 77, submitters: [
    { email: 'cliente@exemplo.com', phone: '+5571999990000', completed_at: '2026-11-04T15:00:00Z' }, { email: 'escritorio@exemplo.com' }] } });
  assert.deepEqual(r.resultados, ['registrado', 'contato_nao_encontrado']);
  assert.equal(crm.calls[0].body.stage, 'contrato_assinado'); assert.equal(crm.calls[0].body.external_id, 'docuseal-77');
  assert.deepEqual(await webhookDocuseal(crm, { event_type: 'form.viewed', data: {} }), { ignorado: 'form.viewed' });
});
