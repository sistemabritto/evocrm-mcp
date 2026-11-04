// Registro de "eventos jurídicos" (DJEN, e-mails de Jusbrasil/PJe/Escavador/Recorte/tribunais) no CRM, sem duplicar.
import { CrmClient, record, collection } from '../crm-client.js';
import { getState, saveState, legalSettings as settings, processDigits } from './state.js';
import { linkFor, addNote, ensurePosvendaItem, createTask } from './ops.js';
import { classificar, ETAPA_STAGE, ETAPA_ROTULO, semAcento, type Etapa } from './classify.js';
import { garantirFunilPrazos, cardPrazos, moverCard, atualizarCamposCard } from './prazos.js';
import { prazoNaAgenda } from './agenda.js';

export type Evento = {
  fonte: 'djen' | 'jusbrasil' | 'pje-push' | 'escavador' | 'recorte-oab' | 'tribunal' | 'intima';
  processo: string;           // CNJ formatado
  data: string;               // AAAA-MM-DD da disponibilização/movimentação
  tipo: string;               // tipo do ato (ex.: Intimação, Sentença, Expedição de intimação)
  tribunal?: string; orgao?: string; texto: string; link?: string;
  nomes?: string[];           // partes/destinatários (para achar o cliente)
};
export type EventoSalvo = {
  chave: string; fontes: string[]; processo: string; data: string; tipo: string; etapa: Etapa;
  contact_id?: string; cliente?: string; criado_em: string; link?: string; resumo: string; tribunal?: string;
  conferir?: boolean;          // movimentação sem intimação: tarefa "Conferir no PJe", sem prazo
  item_prazos_id?: string; task_id?: string;
  prazo_final?: string; base_legal?: string; revisar?: boolean; agenda_evento_id?: string;
};

/** Chave de deduplicação: CNJ + data de disponibilização + tipo do ato. */
export function chaveEvento(e: Pick<Evento, 'processo' | 'data' | 'tipo'>) {
  return `${processDigits(e.processo)}|${e.data}|${semAcento(e.tipo).replace(/[^a-z]/g, '').slice(0, 40)}`;
}

/** Movimentação (push/tribunal/Escavador) só vira prazo se o texto falar em intimação; senão é "conferir no PJe". */
export function soConferir(e: Pick<Evento, 'fonte' | 'tipo' | 'texto'>) {
  if (!['pje-push', 'tribunal', 'escavador'].includes(e.fonte)) return false;
  return !/intima[çc][ãa]o|intimad[oa]|intime-se|cita[çc][ãa]o/i.test(`${e.tipo}\n${e.texto.slice(0, 4000)}`);
}

// Índice de clientes por nome completo (só nomes únicos), renovado a cada 6 h.
let indice: { em: number; mapa: Map<string, { id: string; nome: string }> } | null = null;
const normNome = (s: string) => semAcento(s).replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
async function indiceClientes(crm: CrmClient) {
  if (indice && Date.now() - indice.em < 6 * 3600e3) return indice.mapa;
  const contagem = new Map<string, number>(); const mapa = new Map<string, { id: string; nome: string }>();
  for (let page = 1; page <= 30; page++) {
    const res = await crm.request('GET', '/contacts', { page, per_page: 100 });
    const itens = collection(res).map(record).filter(Boolean) as Record<string, unknown>[];
    for (const c of itens) {
      const attrs = record(c.custom_attributes) ?? {};
      const nome = String(attrs.nome_completo || c.name || '');
      const n = normNome(nome);
      if (n.split(' ').length < 2) continue;
      contagem.set(n, (contagem.get(n) ?? 0) + 1);
      mapa.set(n, { id: String(c.id), nome });
    }
    if (itens.length < 100) break;
  }
  for (const [n, k] of contagem) if (k > 1) mapa.delete(n);   // homônimos: não vincula sozinho
  indice = { em: Date.now(), mapa };
  return mapa;
}

async function acharCliente(crm: CrmClient, e: Evento): Promise<{ id: string; nome: string; por: string } | null> {
  const l = linkFor(e.processo);
  if (l) return { id: l.contact_id, nome: l.contact_name || '', por: 'processo' };
  if (!e.nomes?.length) return null;
  const mapa = await indiceClientes(crm);
  const achados = new Map<string, { id: string; nome: string }>();
  for (const nome of e.nomes) { const hit = mapa.get(normNome(nome)); if (hit) achados.set(hit.id, hit); }
  if (achados.size !== 1) return null;            // nenhum ou mais de um cliente na mesma publicação
  const hit = [...achados.values()][0]!;
  return { ...hit, por: 'nome' };
}


async function moverPosvenda(crm: CrmClient, itemId: string, etapa: Etapa) {
  const stage = ETAPA_STAGE[etapa]; if (!stage) return;
  try {
    const item = record((await crm.request('GET', `/pipelines/${settings.posvendaPipeline}/pipeline_items/${itemId}`)).data) ?? {};
    const atual = String(item.pipeline_stage_id ?? record(item.pipeline_stage)?.id ?? record(item.stage)?.id ?? '');
    if (atual === stage) return;
  } catch { /* sem leitura do item: tenta mover assim mesmo */ }
  await crm.request('PATCH', `/pipelines/${settings.posvendaPipeline}/pipeline_items/${itemId}/move_to_stage`, {}, { new_stage_id: stage, notes: `Monitor jurídico (${ETAPA_ROTULO[etapa]}).` });
}

const cut = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/** Registra um evento. Devolve null se já existia (só acrescenta a fonte). */
export async function registrarEvento(crm: CrmClient, e: Evento): Promise<EventoSalvo | null> {
  const st = getState();
  const chave = chaveEvento(e);
  const existente = st.eventos[chave];
  if (existente) {
    if (!existente.fontes.includes(e.fonte)) { existente.fontes.push(e.fonte); saveState(); }
    return null;
  }
  const { etapa } = classificar(e.tipo, e.texto);
  const salvo: EventoSalvo = { chave, fontes: [e.fonte], processo: e.processo, data: e.data, tipo: e.tipo, etapa,
    criado_em: new Date().toISOString(), link: e.link, resumo: cut(e.texto, 500), tribunal: e.tribunal, conferir: soConferir(e) || undefined };
  st.eventos[chave] = salvo; saveState();
  const cliente = await acharCliente(crm, e).catch(() => null);
  await registrarNoCrm(crm, salvo, cliente, e);
  return salvo;
}

/** Depois de vincular um processo, leva as publicações sem cliente para o card do cliente. */
export async function reprocessarProcesso(crm: CrmClient, processo: string): Promise<number> {
  const l = linkFor(processo); if (!l) return 0;
  const st = getState(); let n = 0;
  for (const s of Object.values(st.eventos)) {
    if (s.contact_id || processDigits(s.processo) !== processDigits(processo)) continue;
    if (s.task_id && st.prazos?.pipeline_id) {
      await crm.request('POST', `/pipelines/${st.prazos.pipeline_id}/pipeline_tasks/${s.task_id}/cancel`, {}, {}).catch(() => undefined);
    }
    const antigoCard = s.item_prazos_id; s.task_id = undefined; s.item_prazos_id = undefined;
    await registrarNoCrm(crm, s, { id: l.contact_id, nome: l.contact_name || '' },
      { fonte: s.fontes[0] as Evento['fonte'], processo: s.processo, data: s.data, tipo: s.tipo, texto: s.resumo, link: s.link, tribunal: s.tribunal });
    if (antigoCard && st.prazos) await atualizarCamposCard(crm, st.prazos.sem_cliente_id).catch(() => undefined);
    n++;
  }
  return n;
}

async function registrarNoCrm(crm: CrmClient, salvo: EventoSalvo, cliente: { id: string; nome: string } | null, e: Evento, opts: { semNota?: boolean } = {}) {
  const etapa = salvo.etapa;
  const fonteRotulo = ({ djen: 'DJEN (CNJ)', jusbrasil: 'Jusbrasil', 'pje-push': 'PJe push', escavador: 'Escavador', 'recorte-oab': 'Recorte Digital OAB', tribunal: 'E-mail do tribunal', intima: 'intima.ai' } as Record<string, string>)[e.fonte] ?? e.fonte;
  const corpo = [
    `${e.tipo} — processo ${e.processo}${e.tribunal ? ` (${e.tribunal})` : ''}`,
    e.orgao ? `Órgão: ${cut(e.orgao, 160)}` : '', `Disponibilização: ${e.data.split('-').reverse().join('/')} · Fonte: ${fonteRotulo}`,
    `Teor: ${salvo.resumo}`, e.link ? `Original: ${e.link}` : '',
    salvo.conferir ? 'Movimentação sem menção a intimação: conferir no PJe (não gera prazo sozinha).'
      : `Prazo: calcular no documento original (CPC dias úteis; DJEN conta do 1º dia útil após a publicação). Registrar com prazo_registrar.`,
  ].filter(Boolean).join('\n');
  try {
    if (cliente) {
      salvo.contact_id = cliente.id; salvo.cliente = cliente.nome;
      if (!opts.semNota) await addNote(crm, cliente.id, `Monitor jurídico\n${corpo}`);
      if (settings.posvendaPipeline) {
        const item = await ensurePosvendaItem(crm, cliente.id);
        await moverPosvenda(crm, item, etapa).catch(() => undefined);
      }
    }
    const f = await garantirFunilPrazos(crm);
    const contato = cliente?.id ?? f.sem_cliente_id;
    const itemId = await cardPrazos(crm, contato);
    salvo.item_prazos_id = itemId;
    const titulo = salvo.conferir ? `Conferir no PJe: ${e.tipo} — ${e.processo}` : `Calcular prazo: ${e.tipo} — ${e.processo}`;
    const tarefa = record((await crm.request('POST', `/pipelines/${f.pipeline_id}/pipeline_items/${itemId}/tasks`, {}, { task: {
      title: cut(titulo, 250), description: corpo, task_type: 'follow_up',
      priority: salvo.conferir ? 'low' : etapa === 'sentenca' || etapa === 'audiencia' || etapa === 'recurso' ? 'high' : 'medium' } })).data);
    salvo.task_id = String(tarefa?.id ?? record(tarefa?.task)?.id ?? '') || undefined;
    await moverCard(crm, itemId, 'nova', ['protocolado', 'arquivado']).catch(() => undefined);
    saveState();
    await atualizarCamposCard(crm, contato).catch(() => undefined);
  } catch (err) {
    console.error('monitor: falha ao registrar no CRM', (err as Error).message);
  }
  saveState();
}

/** Grava o prazo calculado (pelo Claude ou pela equipe) na tarefa e no card. */
export async function registrarPrazo(crm: CrmClient, a: { processo: string; data?: string; prazo_final: string; hora?: string; base_legal: string; revisar?: boolean }) {
  const st = getState();
  const cands = Object.values(st.eventos).filter(e => processDigits(e.processo) === processDigits(a.processo) && (!a.data || e.data === a.data) && !e.conferir)
    .sort((x, y) => (x.prazo_final ? 1 : 0) - (y.prazo_final ? 1 : 0) || y.data.localeCompare(x.data));
  const ev = cands[0];
  if (!ev) throw new Error('Não achei publicação desse processo (confira o número e a data de disponibilização em publicacoes_listar).');
  const f = await garantirFunilPrazos(crm);
  ev.prazo_final = a.prazo_final; ev.base_legal = a.base_legal; ev.revisar = a.revisar || undefined; saveState();
  const venc = `${a.prazo_final}T${a.hora || '23:59'}:00-03:00`;
  const dias = Math.ceil((Date.parse(venc) - Date.now()) / 86400e3);
  const titulo = `Prazo: ${ev.tipo} — ${ev.processo} (vence ${a.prazo_final.split('-').reverse().join('/')})${a.revisar ? ' [REVISAR]' : ''}`;
  if (ev.task_id) {
    await crm.request('PATCH', `/pipelines/${f.pipeline_id}/pipeline_tasks/${ev.task_id}`, {}, { task: {
      title: cut(titulo, 250), due_date: venc, priority: dias <= 3 ? 'urgent' : dias <= 7 ? 'high' : 'medium',
      description: `Base legal: ${a.base_legal}${a.revisar ? '\n[REVISAR] cálculo com dúvida.' : ''}\nDisponibilização: ${ev.data.split('-').reverse().join('/')}\nResumo: ${ev.resumo}${ev.link ? `\nOriginal: ${ev.link}` : ''}` } });
  }
  if (ev.item_prazos_id) {
    await moverCard(crm, ev.item_prazos_id, 'calculado', ['nova']).catch(() => undefined);
    await atualizarCamposCard(crm, ev.contact_id ?? f.sem_cliente_id).catch(() => undefined);
  }
  const agenda = await prazoNaAgenda(ev);
  if (agenda.id) { ev.agenda_evento_id = agenda.id; saveState(); }
  return { processo: ev.processo, ato: ev.tipo, disponibilizacao: ev.data, prazo_final: a.prazo_final, tarefa_atualizada: !!ev.task_id, cliente: ev.cliente ?? null,
    google_agenda: agenda.status === 'sem_agenda'
      ? { status: 'não criado', motivo: agenda.erro ?? 'Google Agenda não configurado no CRM (agenda_google_configurar)', evento_sugerido: { titulo: `Prazo: ${ev.tipo} – ${ev.processo}`, dia_inteiro: a.prazo_final, lembretes: ['2 dias antes', '4 horas antes'] } }
      : { status: agenda.status, evento_id: agenda.id } };
}

/** Migração única: publicações registradas antes do funil de prazos ganham card/tarefa (sem repetir a nota). */
export async function levarAntigasParaPrazos(crm: CrmClient, dias = 30): Promise<number> {
  const st = getState() as ReturnType<typeof getState> & { migracao_prazos_v1?: string };
  if (st.migracao_prazos_v1) return 0;
  const desde = new Date(Date.now() - dias * 86400e3).toISOString();
  let n = 0;
  for (const s of Object.values(st.eventos)) {
    if (s.item_prazos_id || s.criado_em < desde) continue;
    if (s.conferir === undefined) s.conferir = soConferir({ fonte: s.fontes[0] as Evento['fonte'], tipo: s.tipo, texto: s.resumo }) || undefined;
    const cliente = s.contact_id ? { id: s.contact_id, nome: s.cliente || '' } : null;
    await registrarNoCrm(crm, s, cliente, { fonte: s.fontes[0] as Evento['fonte'], processo: s.processo, data: s.data, tipo: s.tipo, texto: s.resumo, link: s.link, tribunal: s.tribunal }, { semNota: true });
    n++;
  }
  st.migracao_prazos_v1 = new Date().toISOString(); saveState();
  return n;
}
