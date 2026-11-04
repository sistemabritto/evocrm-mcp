// Equipe interna: alertas por WhatsApp com lista fixa de destinos, escalonamento e aprovações (#código).
// Tudo opcional: só liga com TEAM_INBOX_ID e TEAM_MEMBERS configurados.
//
//   TEAM_INBOX_ID            caixa de WhatsApp usada para falar com a equipe
//   TEAM_MEMBERS             chave:número:Nome, separados por vírgula (ex.: ana:5511999990000:Ana Souza)
//   TEAM_BLOCKED_NUMBERS     números que nunca recebem nada (ex.: o número de pré-venda)
//   TEAM_DEFAULT             membro padrão (alertas do monitor, resumo diário); padrão: o primeiro
//   TEAM_APPROVER            quem aprova respostas (padrão: TEAM_DEFAULT)
//   TEAM_ESCALATE_FROM / TEAM_ESCALATE_TO / TEAM_ESCALATE_MINUTES (padrão 15)
//   TEAM_LABEL               etiqueta dos contatos internos (padrão: equipe) — use-a em "ignored labels" do agente
//   TEAM_STATE_FILE          padrão /data/equipe.json
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { collection, CrmError, record, type CrmClient } from '../crm-client.js';

const env = process.env;
const digits = (s: string) => s.replace(/\D/g, '');
/** Forma canônica para comparar celulares brasileiros com ou sem o nono dígito (o WhatsApp costuma gravar sem). */
export const canon = (n: string) => { const d = digits(n); return d.length === 13 && d.startsWith('55') && d[4] === '9' ? d.slice(0, 4) + d.slice(5) : d; };
export type Membro = { chave: string; numero: string; nome: string };

export const team = (() => {
  const bloqueados = new Set((env.TEAM_BLOCKED_NUMBERS || '').split(',').map(canon).filter(Boolean));
  const membros: Membro[] = (env.TEAM_MEMBERS || '').split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const [chave = '', numero = '', ...nome] = s.split(':');
    return { chave: chave.trim().toLowerCase(), numero: digits(numero), nome: nome.join(':').trim() || chave.trim() };
  }).filter(m => /^[a-z][a-z0-9_-]{0,30}$/.test(m.chave) && m.numero.length >= 12 && !bloqueados.has(canon(m.numero)));
  const padrao = (env.TEAM_DEFAULT || membros[0]?.chave || '').toLowerCase();
  return {
    inbox: env.TEAM_INBOX_ID || '', membros, bloqueados, padrao,
    aprovador: (env.TEAM_APPROVER || padrao).toLowerCase(),
    escalaDe: (env.TEAM_ESCALATE_FROM || '').toLowerCase(), escalaPara: (env.TEAM_ESCALATE_TO || padrao).toLowerCase(),
    escalaMin: Math.max(1, Number(env.TEAM_ESCALATE_MINUTES || 15)),
    label: env.TEAM_LABEL || 'equipe', stateFile: env.TEAM_STATE_FILE || '/data/equipe.json',
    ativo: !!(env.TEAM_INBOX_ID && membros.length),
  };
})();
export const membro = (chave: string) => team.membros.find(m => m.chave === chave.toLowerCase());

// ---------------- Estado ----------------
type Escala = { id: string; texto: string; enviado_em: string; ciente_em?: string; escalado_em?: string };
type Aprovacao = { codigo: string; conversation_id: string; contact_id: string; cliente: string; texto: string; resumo: string;
  pedido_em: string; status: 'pendente' | 'enviada' | 'ajustada' | 'humano' | 'expirada'; decidido_em?: string; texto_final?: string };
type Estado = { conversas: Record<string, string>; escalas: Escala[]; aprovacoes: Aprovacao[]; lido_ate: Record<string, string> };
let st: Estado = { conversas: {}, escalas: [], aprovacoes: [], lido_ate: {} };
try { if (existsSync(team.stateFile)) st = { ...st, ...JSON.parse(readFileSync(team.stateFile, 'utf8')) }; } catch { console.error('equipe: estado ilegível; começando vazio'); }
function salvar() {
  try { writeFileSync(team.stateFile + '.tmp', JSON.stringify(st), { mode: 0o600 }); renameSync(team.stateFile + '.tmp', team.stateFile); }
  catch (e) { console.error('equipe: não consegui gravar o estado', (e as Error).message); }
}
export const estadoEquipe = () => st;

// ---------------- Envio ----------------
const MIN_INTERVALO_MS = 4_000;
const TETO_DIA = Number(env.TEAM_DAILY_MAX || 60);
let ultimoEnvio = 0, dia = '', enviadosHoje = 0;

async function garantirEtiqueta(crm: CrmClient, contactId: string) {
  try {
    const atuais = collection(await crm.request('GET', `/contacts/${contactId}/labels`)).filter(l => typeof l === 'string') as string[];
    if (!atuais.includes(team.label)) await crm.request('POST', `/contacts/${contactId}/labels`, {}, { labels: [...atuais, team.label] });
  } catch { /* etiqueta é proteção extra; não bloqueia o envio */ }
}

async function conversaDoMembro(crm: CrmClient, m: Membro): Promise<string> {
  if (st.conversas[m.chave]) return st.conversas[m.chave]!;
  const busca = collection(await crm.request('GET', '/contacts/search', { q: m.numero.slice(-8), page: 1, per_page: 25 })).map(record);
  let contactId = String(busca.find(c => c && canon(String(c.phone_number ?? '')) === canon(m.numero))?.id ?? '');
  if (!contactId) {
    const novo = record((await crm.request('POST', '/contacts', {}, { name: m.nome, phone_number: `+${m.numero}` })).data);
    contactId = String(novo?.id ?? record(novo?.contact)?.id ?? '');
  }
  if (!contactId) throw new CrmError('operation_failed', 'Não consegui criar o contato do membro da equipe.');
  await garantirEtiqueta(crm, contactId);
  const convs = collection(await crm.request('GET', `/contacts/${contactId}/conversations`)).map(record)
    .filter(c => c && String(c.inbox_id ?? record(c.inbox)?.id ?? '') === team.inbox) as Record<string, unknown>[];
  let convId = String((convs.find(c => c.status !== 'resolved') ?? convs[0])?.id ?? '');
  if (!convId) {
    const nova = record((await crm.request('POST', '/conversations', {}, { contact_id: contactId, inbox_id: team.inbox, status: 'open' })).data);
    convId = String(nova?.id ?? '');
  }
  if (!convId) throw new CrmError('operation_failed', 'Não consegui abrir a conversa com o membro da equipe.');
  st.conversas[m.chave] = convId; salvar();
  return convId;
}

/** Envia texto a um membro da equipe (lista fixa). Nunca a outro número. */
export async function enviarParaMembro(crm: CrmClient, chave: string, texto: string) {
  if (!team.ativo) throw new CrmError('not_configured', 'Equipe não configurada no servidor.');
  const m = membro(chave);
  if (!m || team.bloqueados.has(canon(m.numero))) throw new CrmError('forbidden_destination', 'Destino fora da lista fixa da equipe.');
  const hoje = new Date().toISOString().slice(0, 10);
  if (hoje !== dia) { dia = hoje; enviadosHoje = 0; }
  if (enviadosHoje >= TETO_DIA) throw new CrmError('rate_limited', `Limite de ${TETO_DIA} mensagens internas por dia atingido. Agrupe os avisos.`);
  const espera = ultimoEnvio + MIN_INTERVALO_MS - Date.now();
  if (espera > 0) await new Promise(r => setTimeout(r, espera));
  const convId = await conversaDoMembro(crm, m);
  ultimoEnvio = Date.now(); enviadosHoje++;
  const r = record((await crm.request('POST', `/conversations/${convId}/messages`, {}, { content: texto, message_type: 'outgoing', private: false })).data);
  return { enviado: true, destino: m.chave, nome: m.nome, conversation_id: convId, message_id: r?.id ?? null };
}

// ---------------- Escalonamento ----------------
export async function alertarEquipe(crm: CrmClient, chave: string, texto: string) {
  const escalar = !!team.escalaDe && chave.toLowerCase() === team.escalaDe && !!membro(team.escalaPara);
  const corpo = escalar ? `${texto}\n\nResponda *CIENTE* para confirmar.` : texto;
  const r = await enviarParaMembro(crm, chave, corpo);
  if (escalar) { st.escalas.push({ id: String(r.message_id ?? Date.now()), texto, enviado_em: new Date().toISOString() }); st.escalas = st.escalas.slice(-200); salvar(); }
  return { ...r, escalonamento: escalar ? `se ${membro(chave)!.nome} não responder CIENTE em ${team.escalaMin} min, vai para ${membro(team.escalaPara)!.nome}` : null };
}

// ---------------- Aprovações ----------------
async function conversaDoCliente(crm: CrmClient, contactId: string) {
  const convs = collection(await crm.request('GET', `/contacts/${contactId}/conversations`)).map(record)
    .filter(c => c && String(c.inbox_id ?? record(c.inbox)?.id ?? '') === team.inbox) as Record<string, unknown>[];
  const conv = convs.find(c => c.status !== 'resolved') ?? convs[0];
  if (!conv) throw new CrmError('not_found', 'Este contato não tem conversa nesta caixa. Confira o contact_id (vem em "Contact Information").');
  return String(conv.id);
}

export async function pedirAprovacao(crm: CrmClient, contactId: string, texto: string, resumo: string) {
  if (!membro(team.aprovador)) throw new CrmError('not_configured', 'Aprovador não configurado.');
  const contato = record((await crm.request('GET', `/contacts/${contactId}`)).data) ?? {};
  if (team.membros.some(m => canon(m.numero) === canon(String(contato.phone_number ?? '')))) throw new CrmError('invalid_arguments', 'Aprovação é só para clientes, não para a equipe.');
  const conversationId = await conversaDoCliente(crm, contactId);
  let codigo = '';
  do { codigo = `C${randomInt(1000, 10000)}`; } while (st.aprovacoes.some(a => a.codigo === codigo && a.status === 'pendente'));
  const cliente = `${String(contato.name || 'Cliente')} (${String(contato.phone_number || 'sem telefone')})`;
  st.aprovacoes.push({ codigo, conversation_id: conversationId, contact_id: contactId, cliente, texto, resumo, pedido_em: new Date().toISOString(), status: 'pendente' });
  st.aprovacoes = st.aprovacoes.slice(-300); salvar();
  await enviarParaMembro(crm, team.aprovador, `*🟡 Aprovação #${codigo}*\nCliente: ${cliente}\nResumo: ${resumo}\n\nResposta proposta:\n«${texto}»\n\n` +
    `Responda:\n*1 #${codigo}* enviar como está\n*2 #${codigo} seu texto* enviar com ajuste\n*3 #${codigo}* eu respondo`);
  await crm.request('POST', `/conversations/${conversationId}/messages`, {}, { content: `⏳ Aguardando aprovação #${codigo} do ${membro(team.aprovador)!.nome}.\nProposta: ${texto}`, message_type: 'outgoing', private: true }).catch(() => undefined);
  return { codigo, conversation_id: conversationId, cliente, status: 'pendente', instrucao: 'Não envie nada ao cliente sobre esse assunto até a decisão; o envio aprovado sai automaticamente.' };
}

// ---------------- Leitura das respostas da equipe ----------------
const iso = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && String(v) !== '' ? new Date(n * 1000).toISOString() : new Date(String(v)).toISOString(); };
async function novasDoMembro(crm: CrmClient, chave: string) {
  const convId = st.conversas[chave]; if (!convId) return [];
  const desde = st.lido_ate[chave] || new Date(Date.now() - 3600e3).toISOString();
  const msgs = collection(await crm.request('GET', `/conversations/${convId}/messages`)).map(record).filter(Boolean) as Record<string, unknown>[];
  const novas = msgs.filter(m => (Number(m.message_type) === 0 || m.message_type === 'incoming') && !m.private && iso(m.created_at) > desde)
    .map(m => ({ texto: String(m.content || '').trim(), em: iso(m.created_at) }));
  if (novas.length) { st.lido_ate[chave] = novas[novas.length - 1]!.em; salvar(); }
  return novas;
}

export function interpretarDecisao(texto: string, pendentes: string[]): { codigo: string; opcao: 1 | 2 | 3; ajuste?: string } | null {
  const t = texto.trim();
  const mc = t.match(/#?\s*C\s?(\d{4})\b/i);
  const codigo = mc ? `C${mc[1]}` : pendentes.length === 1 ? pendentes[0]! : '';
  if (!codigo || !pendentes.includes(codigo)) return null;
  const semCodigo = t.replace(/#?\s*C\s?\d{4}\b/i, ' ').trim();
  const mo = semCodigo.match(/^\*?([123])\*?(?:[\s.,:;)\-–—]+|$)([\s\S]*)$/);
  if (!mo) return null;
  const opcao = Number(mo[1]) as 1 | 2 | 3;
  const ajuste = mo[2]!.trim();
  if (opcao === 2 && !ajuste) return null;
  return { codigo, opcao, ...(opcao === 2 ? { ajuste } : {}) };
}

let rodando = false;
export async function verificarEquipe(crm: CrmClient) {
  if (!team.ativo || rodando) return;
  rodando = true;
  try {
    // CIENTE do responsável pelo primeiro atendimento
    if (team.escalaDe && st.conversas[team.escalaDe]) {
      for (const msg of await novasDoMembro(crm, team.escalaDe)) {
        if (/\bciente\b/i.test(msg.texto)) for (const e of st.escalas) if (!e.ciente_em && !e.escalado_em && e.enviado_em <= msg.em) e.ciente_em = msg.em;
      }
      salvar();
    }
    const limite = Date.now() - team.escalaMin * 60e3;
    for (const e of st.escalas.filter(x => !x.ciente_em && !x.escalado_em && Date.parse(x.enviado_em) <= limite)) {
      e.escalado_em = new Date().toISOString(); salvar();
      await enviarParaMembro(crm, team.escalaPara, `*⚠️ ${membro(team.escalaDe)?.nome ?? team.escalaDe} sem resposta em ${team.escalaMin} min*\n\n${e.texto}`)
        .catch(err => console.error('equipe: escalonamento falhou', (err as Error).message));
    }
    // Decisões do aprovador
    if (st.conversas[team.aprovador]) {
      for (const msg of await novasDoMembro(crm, team.aprovador)) {
        const pend = st.aprovacoes.filter(a => a.status === 'pendente').map(a => a.codigo);
        const d = interpretarDecisao(msg.texto, pend);
        if (!d) {
          if (/^\*?[123]\b/.test(msg.texto.trim()) && pend.length > 1) {
            await enviarParaMembro(crm, team.aprovador, `Qual pedido? Responda com o código, ex.: *1 #${pend[0]}*. Pendentes: ${pend.map(c => '#' + c).join(', ')}.`).catch(() => undefined);
          }
          continue;
        }
        const a = st.aprovacoes.find(x => x.codigo === d.codigo && x.status === 'pendente')!;
        try {
          if (d.opcao === 3) {
            a.status = 'humano';
            await crm.request('POST', `/conversations/${a.conversation_id}/messages`, {}, { content: `✋ #${a.codigo}: ${membro(team.aprovador)!.nome} vai responder pessoalmente. Nada foi enviado.`, message_type: 'outgoing', private: true });
            await crm.request('POST', `/conversations/${a.conversation_id}/toggle_status`, {}, { status: 'open' }).catch(() => undefined);
          } else {
            const final = d.opcao === 1 ? a.texto : d.ajuste!;
            await crm.request('POST', `/conversations/${a.conversation_id}/messages`, {}, { content: final, message_type: 'outgoing', private: false });
            a.status = d.opcao === 1 ? 'enviada' : 'ajustada'; a.texto_final = final;
            await crm.request('POST', `/conversations/${a.conversation_id}/messages`, {}, { content: `✅ #${a.codigo} aprovado (${d.opcao === 1 ? 'como proposto' : 'com ajuste'}) e enviado.`, message_type: 'outgoing', private: true }).catch(() => undefined);
          }
          a.decidido_em = new Date().toISOString(); salvar();
          await enviarParaMembro(crm, team.aprovador, d.opcao === 3 ? `✋ #${a.codigo}: ok, a conversa de ${a.cliente} ficou com você.` : `✅ #${a.codigo} enviado para ${a.cliente}.`).catch(() => undefined);
        } catch (err) {
          console.error('equipe: falha ao aplicar decisão', a.codigo, (err as Error).message);
          await enviarParaMembro(crm, team.aprovador, `❌ #${a.codigo}: não consegui aplicar a decisão (${(err as Error).message}). Responda de novo ou atenda pelo CRM.`).catch(() => undefined);
        }
      }
    }
    // Pedidos esquecidos expiram em 48 h (nada é enviado)
    const exp = Date.now() - 48 * 3600e3;
    for (const a of st.aprovacoes) if (a.status === 'pendente' && Date.parse(a.pedido_em) < exp) { a.status = 'expirada'; a.decidido_em = new Date().toISOString(); }
    salvar();
  } finally { rodando = false; }
}

export function iniciarEquipe(crm: CrmClient) {
  if (!team.ativo) return;
  setInterval(() => void verificarEquipe(crm).catch(e => console.error('equipe:', (e as Error).message)), 60_000).unref();
  console.error(`equipe: ${team.membros.map(m => m.chave).join(', ')}; aprovador ${team.aprovador}; escalonamento ${team.escalaDe || '—'} → ${team.escalaPara} em ${team.escalaMin} min`);
}
