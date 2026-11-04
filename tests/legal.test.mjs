import test from 'node:test';
import assert from 'node:assert';
process.env.LEGAL_STATE_FILE = '/tmp/legal-test-' + process.pid + '.json';
const { classificar, extrairCnjs } = await import('../dist/legal/classify.js');
const { chaveEvento } = await import('../dist/legal/process.js');

test('classifica por tipo de ato com precedência', () => {
  assert.equal(classificar('Intimação — Sentença Tipo A', 'JULGO PROCEDENTE o pedido').etapa, 'sentenca');
  assert.equal(classificar('Intimação', 'Fica designada audiência de conciliação para o dia 10/12').etapa, 'audiencia');
  assert.equal(classificar('Publicação', 'Processos que deverão ser julgados pela Segunda Câmara Criminal em Sessão Plenária Virtual').etapa, 'recurso');
  assert.equal(classificar('Intimação', 'Expeça-se RPV em favor do autor').etapa, 'cumprimento');
  assert.equal(classificar('Expedição de intimação.', '').etapa, 'andamento');
  assert.equal(classificar('Acórdão', 'sentença mantida; audiência').etapa, 'recurso');
  assert.equal(classificar('Intimação', 'designada perícia médica').urgente, true);
});

test('extrai CNJ com e sem pontuação, sem duplicar', () => {
  assert.deepEqual(extrairCnjs('proc 0000001-11.2025.8.05.0001 e 00000011120258050001 e 0000002-22.2026.4.01.0002'),
    ['0000001-11.2025.8.05.0001', '0000002-22.2026.4.01.0002']);
});

test('chave de deduplicação ignora formatação e acentos', () => {
  const a = chaveEvento({ processo: '0000001-11.2025.8.05.0001', data: '2026-11-04', tipo: 'Intimação — Sentença' });
  const b = chaveEvento({ processo: '00000011120258050001', data: '2026-11-04', tipo: 'intimacao - sentenca' });
  assert.equal(a, b);
  assert.notEqual(a, chaveEvento({ processo: '00000011120258050001', data: '2026-11-05', tipo: 'Intimação — Sentença' }));
});
