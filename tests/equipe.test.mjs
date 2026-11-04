import test from 'node:test';
import assert from 'node:assert/strict';
process.env.TEAM_INBOX_ID = 'inbox-suporte';
process.env.TEAM_MEMBERS = 'chefe:5511900000001:Dra. Chefe,ana:5511900000002:Ana,bloq:5511900000009:Pré-venda';
process.env.TEAM_BLOCKED_NUMBERS = '5511900000009';
process.env.TEAM_DEFAULT = 'chefe';
process.env.TEAM_ESCALATE_FROM = 'ana';
process.env.TEAM_ESCALATE_TO = 'chefe';
process.env.TEAM_STATE_FILE = '/tmp/equipe-test-' + process.pid + '.json';
const { team, alertarEquipe, enviarParaMembro, pedirAprovacao, verificarEquipe, interpretarDecisao, estadoEquipe } = await import('../dist/team/team.js');

const agora = () => Math.floor(Date.now() / 1000);
const enviados = []; const msgs = { 'conv-chefe': [], 'conv-ana': [], 'conv-cliente': [] };
const contatos = { '00000001': 'k-chefe', '00000002': 'k-ana' };
const crm = { async request(m, p, q = {}, b) {
  // o CRM guarda sem o nono dígito (formato do WhatsApp): +5511000000xx
  if (m === 'GET' && p === '/contacts/search') return { data: contatos[q.q] ? [{ id: contatos[q.q], phone_number: '+5511' + q.q }] : [] };
  if (m === 'GET' && /^\/contacts\/k-[a-z]+\/labels$/.test(p)) return { data: [] };
  if (m === 'POST' && /\/labels$/.test(p)) return { data: {} };
  if (m === 'GET' && p === '/contacts/k-chefe/conversations') return { data: [{ id: 'conv-chefe', inbox_id: 'inbox-suporte', status: 'open' }] };
  if (m === 'GET' && p === '/contacts/k-ana/conversations') return { data: [{ id: 'conv-ana', inbox_id: 'inbox-suporte', status: 'open' }] };
  if (m === 'GET' && p === '/contacts/cli-1') return { data: { id: 'cli-1', name: 'Cliente Teste', phone_number: '+5511988887777' } };
  if (m === 'GET' && p === '/contacts/cli-1/conversations') return { data: [{ id: 'conv-cliente', inbox_id: 'inbox-suporte', status: 'pending' }, { id: 'outra', inbox_id: 'outra-caixa' }] };
  const mm = p.match(/^\/conversations\/([^/]+)\/messages$/);
  if (mm && m === 'GET') return { data: msgs[mm[1]] ?? [] };
  if (mm && m === 'POST') { enviados.push({ conv: mm[1], ...b }); return { data: { id: 'm' + enviados.length } }; }
  if (/toggle_status$/.test(p)) { enviados.push({ conv: p.split('/')[2], status: b.status }); return { data: {} }; }
  return { data: {} };
} };

test('canon compara celular com e sem o nono dígito', async () => {
  const { canon } = await import('../dist/team/team.js');
  assert.equal(canon('+55 71 98240-0000'), canon('557182400000'));
  assert.notEqual(canon('5571982400000'), canon('5571982400001'));
});

test('configuração: membro bloqueado fica fora da lista; destino fora da lista é recusado', async () => {
  assert.deepEqual(team.membros.map(m => m.chave), ['chefe', 'ana']);
  await assert.rejects(enviarParaMembro(crm, 'bloq', 'oi'), /fora da lista/);
  await assert.rejects(enviarParaMembro(crm, 'qualquer', 'oi'), /fora da lista/);
});

test('interpreta decisões com e sem código', () => {
  assert.deepEqual(interpretarDecisao('1 #C1234', ['C1234', 'C5678']), { codigo: 'C1234', opcao: 1 });
  assert.deepEqual(interpretarDecisao('2 #C5678 Olá, tudo certo.', ['C1234', 'C5678']), { codigo: 'C5678', opcao: 2, ajuste: 'Olá, tudo certo.' });
  assert.deepEqual(interpretarDecisao('3', ['C1234']), { codigo: 'C1234', opcao: 3 });
  assert.equal(interpretarDecisao('1', ['C1234', 'C5678']), null, 'sem código e com 2 pendentes: ambíguo');
  assert.equal(interpretarDecisao('2 #C1234', ['C1234']), null, 'opção 2 sem texto');
  assert.equal(interpretarDecisao('ok obrigado', ['C1234']), null);
  assert.equal(interpretarDecisao('1 #C9999', ['C1234']), null, 'código inexistente');
});

test('alerta para quem precisa dar CIENTE escala sozinho depois do prazo', async () => {
  const r = await alertarEquipe(crm, 'ana', 'Cliente X pediu retorno urgente');
  assert.match(enviados.at(-1).content, /Responda \*CIENTE\*/);
  assert.equal(enviados.at(-1).conv, 'conv-ana');
  assert.ok(r.escalonamento);
  estadoEquipe().escalas.at(-1).enviado_em = new Date(Date.now() - 16 * 60e3).toISOString();
  await verificarEquipe(crm);
  const ultimo = enviados.at(-1);
  assert.equal(ultimo.conv, 'conv-chefe'); assert.match(ultimo.content, /Ana sem resposta em 15 min/); assert.match(ultimo.content, /Cliente X/);
});

test('CIENTE dentro do prazo cancela o escalonamento', async () => {
  await alertarEquipe(crm, 'ana', 'Outro aviso');
  const enviadoEm = estadoEquipe().escalas.at(-1).enviado_em;
  msgs['conv-ana'].push({ message_type: 0, created_at: Math.floor(Date.parse(enviadoEm) / 1000) + 30, content: 'Ciente!' });
  estadoEquipe().escalas.at(-1).enviado_em = new Date(Date.now() - 20 * 60e3).toISOString();
  const antes = enviados.length;
  await verificarEquipe(crm);
  assert.equal(enviados.length, antes, 'nada foi escalado');
  assert.ok(estadoEquipe().escalas.at(-1).ciente_em);
});

test('aprovação: pedido com código, ajuste do aprovador sai na conversa do cliente', async () => {
  const r = await pedirAprovacao(crm, 'cli-1', 'Seu processo está em andamento.', 'Cliente perguntou do andamento');
  assert.match(r.codigo, /^C\d{4}$/); assert.equal(r.conversation_id, 'conv-cliente');
  const pedido = enviados.find(e => e.conv === 'conv-chefe' && e.content?.includes(`#${r.codigo}`));
  assert.ok(pedido); assert.match(pedido.content, /Cliente Teste/);
  assert.ok(enviados.some(e => e.conv === 'conv-cliente' && e.private === true), 'nota interna de "aguardando aprovação"');
  assert.ok(!enviados.some(e => e.conv === 'conv-cliente' && e.private === false), 'nada foi ao cliente ainda');
  msgs['conv-chefe'].push({ message_type: 0, created_at: agora() + 5, content: `2 #${r.codigo} Olá! Seu processo segue em andamento; avisaremos novidades.` });
  await verificarEquipe(crm);
  const aoCliente = enviados.filter(e => e.conv === 'conv-cliente' && e.private === false);
  assert.equal(aoCliente.length, 1);
  assert.equal(aoCliente[0].content, 'Olá! Seu processo segue em andamento; avisaremos novidades.');
  assert.equal(estadoEquipe().aprovacoes.find(a => a.codigo === r.codigo).status, 'ajustada');
  await verificarEquipe(crm);
  assert.equal(enviados.filter(e => e.conv === 'conv-cliente' && e.private === false).length, 1, 'não reenvia');
});

test('aprovação: opção 3 não envia nada ao cliente e abre a conversa para humano', async () => {
  const r = await pedirAprovacao(crm, 'cli-1', 'Proposta', 'Resumo');
  const antes = enviados.filter(e => e.conv === 'conv-cliente' && e.private === false).length;
  msgs['conv-chefe'].push({ message_type: 0, created_at: agora() + 10, content: `3 #${r.codigo}` });
  await verificarEquipe(crm);
  assert.equal(enviados.filter(e => e.conv === 'conv-cliente' && e.private === false).length, antes);
  assert.ok(enviados.some(e => e.conv === 'conv-cliente' && e.status === 'open'));
  assert.equal(estadoEquipe().aprovacoes.find(a => a.codigo === r.codigo).status, 'humano');
});

test('aprovação recusa contato da própria equipe', async () => {
  const crm2 = { ...crm, async request(m, p, q, b) { if (p === '/contacts/k-ana') return { data: { id: 'k-ana', phone_number: '+551100000002' } }; return crm.request(m, p, q, b); } };
  await assert.rejects(pedirAprovacao(crm2, 'k-ana', 'x', 'y'), /só para clientes/);
});
