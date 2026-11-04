// Fontes gratuitas do monitor jurídico: DJEN (API pública do CNJ) e e-mails do Jusbrasil / PJe push.
import { readFileSync } from 'node:fs';
import { CrmClient, record, collection } from '../crm-client.js';
import { getState, saveState, bahiaNow, legalSettings } from './state.js';
import { extrairCnjs } from './classify.js';
import { registrarEvento, chaveEvento, type Evento, type EventoSalvo } from './process.js';

const env = process.env;
const fileOrEnv = (f: string, v: string) => (env[f] ? readFileSync(env[f] as string, 'utf8') : env[v] || '').trim();

// ---------------- DJEN ----------------
// Precisa de saída pelo Brasil (o CNJ recusa IP de fora: 403). DJEN_PROXY_URL: proxy no Brasil (ex.: função na Vercel, região gru1).
export const djenConfig = {
  oab: env.DJEN_OAB || '', uf: env.DJEN_UF || '',
  proxyUrl: (env.DJEN_PROXY_URL || '').replace(/\/$/, ''), proxyKey: fileOrEnv('DJEN_PROXY_KEY_FILE', 'DJEN_PROXY_KEY'),
};
export const djenAtivo = () => !!(djenConfig.proxyUrl && djenConfig.oab && djenConfig.uf);

type ItemDjen = Record<string, unknown>;
export async function buscarDjen(dias = 3): Promise<{ itens: ItemDjen[]; erro?: string }> {
  const fim = bahiaNow().date;
  const ini = new Date(Date.now() - dias * 86400e3 - 3 * 3600e3).toISOString().slice(0, 10);
  const itens: ItemDjen[] = [];
  for (let pagina = 1; pagina <= 20; pagina++) {
    const q = new URLSearchParams({ numeroOab: djenConfig.oab, ufOab: djenConfig.uf, dataDisponibilizacaoInicio: ini,
      dataDisponibilizacaoFim: fim, itensPorPagina: '100', pagina: String(pagina) });
    let r: Response;
    try {
      r = await fetch(`${djenConfig.proxyUrl}/api/v1/comunicacao?${q}`,
        { headers: { 'x-proxy-key': djenConfig.proxyKey, Accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
    } catch (e) { return { itens, erro: `sem conexão com o DJEN (${(e as Error).name})` }; }
    if (r.status === 403) return { itens, erro: 'DJEN recusou (403): a saída não é do Brasil ou a chave do proxy está errada' };
    if (!r.ok) return { itens, erro: `DJEN respondeu HTTP ${r.status}` };
    const d = (await r.json()) as { items?: ItemDjen[]; count?: number };
    const lote = d.items ?? [];
    itens.push(...lote);
    if (lote.length < 100 || itens.length >= (d.count ?? 0)) break;
  }
  return { itens };
}

function eventoDjen(i: ItemDjen): Evento | null {
  const processo = String(i.numeroprocessocommascara || '') || extrairCnjs(String(i.numero_processo || ''))[0] || '';
  if (!processo) return null;
  const nomes = [...(Array.isArray(i.destinatarios) ? i.destinatarios : [])].map(d => String(record(d)?.nome ?? '')).filter(Boolean);
  const texto = String(i.texto || '').replace(/<[^>]+>/g, ' ');
  return {
    fonte: 'djen', processo, data: String(i.data_disponibilizacao || i.datadisponibilizacao || '').slice(0, 10),
    tipo: [i.tipoComunicacao, i.tipoDocumento].filter(Boolean).join(' — ') || 'Comunicação',
    tribunal: String(i.siglaTribunal || ''), orgao: String(i.nomeOrgao || ''), texto,
    link: i.hash ? `https://comunica.pje.jus.br/consulta/certidao/${i.hash}` : (i.link ? String(i.link) : undefined), nomes,
  };
}

export async function coletarDjen(crm: CrmClient, dias = 3): Promise<{ novos: EventoSalvo[]; lidos: number; erro?: string }> {
  const { itens, erro } = await buscarDjen(dias);
  const novos: EventoSalvo[] = [];
  for (const i of itens) {
    if (i.ativo === false) continue;
    const e = eventoDjen(i); if (!e || !e.data) continue;
    const s = await registrarEvento(crm, e); if (s) novos.push(s);
  }
  const st = getState(); st.djen_ultima = { em: new Date().toISOString(), lidos: itens.length, novos: novos.length, erro }; saveState();
  return { novos, lidos: itens.length, erro };
}

// ---------------- E-mails (caixa "E-mail do escritório" no CRM) ----------------
// Remetentes automáticos sem conteúdo jurídico: a conversa é resolvida (arquivada) direto.
const RUIDO = /(^|@)(sso@cnj\.jus\.br|nao-responda@jusbrasil|.*idealista\.|.*@accounts\.google\.com|.*@google\.com|.*mail\.instagram\.com|.*facebookmail\.com|.*metricool\.com|.*certisign\.com\.br|.*info\.xpi\.com\.br|.*emdonline\.com\.br|.*@intima\.ai)/i;

function linkDe(texto: string, rotulo: RegExp): string | undefined {
  for (const m of texto.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) if (rotulo.test(m[1]!)) return m[2];
  return undefined;
}

const CNJ_RE = String.raw`\d{7}-?\d{2}\.?\d{4}\.?\d\.?\d{2}\.?\d{4}`;
const dataIso = (d: string, m: string, a: string) => `${a.length === 2 ? '20' + a : a}-${m}-${d}`;
const dominio = (email: string) => (email.split('@')[1] || '').toLowerCase();
/** Fontes jurídicas automáticas (o texto delas pode citar processos). */
const FONTE_JURIDICA = /(jusbrasil|escavador\.com|recortedigital|\.jus\.br$|pje@)/i;
/** Endereços do próprio escritório (relatórios internos): nunca viram publicação nova. */
export const PROPRIOS = new Set((process.env.LEGAL_OWN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean));

export function eventosDoEmail(remetente: string, assunto: string, texto: string, recebido: string): Evento[] {
  const data = recebido.slice(0, 10);
  if (PROPRIOS.has(remetente.toLowerCase())) return [];          // resumo interno: nunca vira publicação nova
  if (/jusbrasil/i.test(remetente) && /publica/i.test(`${assunto} ${texto.slice(0, 200)}`)) {
    const link = linkDe(texto, /ler publica|na integra|na íntegra/i);
    return extrairCnjs(texto).map(processo => ({ fonte: 'jusbrasil' as const, processo, data, tipo: 'Publicação',
      tribunal: (texto.match(/\b(TJ[A-Z]{2}|TRF\d|TRT\d{1,2}|STJ|STF|TST)\b/) || [])[1], texto, link }));
  }
  if (/pje@/i.test(remetente) && /movimenta/i.test(assunto + texto)) {
    const processo = extrairCnjs(texto)[0]; if (!processo) return [];
    const movs = [...texto.matchAll(/(\d{2})\/(\d{2})\/(\d{4}) \d{2}:\d{2} - ([^\n]+)/g)];
    const ult = movs[movs.length - 1];
    const polos = [...texto.matchAll(/Polo (?:Ativo|Passivo):\s*([^\n]+)/g)].map(m => m[1]!.replace(/\s+E OUTROS$/i, '').trim());
    return [{ fonte: 'pje-push' as const, processo, data: ult ? `${ult[3]}-${ult[2]}-${ult[1]}` : data,
      tipo: ult ? ult[4]!.trim() : 'Movimentação processual', tribunal: (texto.match(/\b(TJ[A-Z]{2}|TRF\d)\b/) || ['', 'TJBA'])[1],
      orgao: (texto.match(/Órgão:\s*([^\n]+)/) || [])[1], texto, nomes: polos }];
  }
  if (/escavador\.com/i.test(remetente)) {
    const out: Evento[] = [];
    const re = new RegExp(String.raw`\[Movimenta[çc][ãa]o do processo (${CNJ_RE}) do dia (\d{2})\/(\d{2})\/(\d{4})([^\]]*)\]\((https?:[^)\s]+)\)`, 'gi');
    for (const m of texto.matchAll(re)) {
      const processo = extrairCnjs(m[1]!)[0]; if (!processo) continue;
      out.push({ fonte: 'escavador', processo, data: dataIso(m[2]!, m[3]!, m[4]!), tipo: 'Movimentação (Escavador)',
        orgao: m[5]!.replace(/^\s*-\s*/, '').trim() || undefined, texto, link: m[6] });
    }
    if (out.length) return out;
  }
  if (/\.jus\.br$/i.test(dominio(remetente)) && /movimenta/i.test(assunto + texto)) {
    const out: Evento[] = [];
    const re = new RegExp(String.raw`Num\.?\s*Processo:\s*(${CNJ_RE})\s*Movimenta[çc][ãa]o:\s*([^\n]+?)(?:\s+-\s+Evento|\n|$)`, 'gi');
    for (const m of texto.matchAll(re)) {
      const processo = extrairCnjs(m[1]!)[0]; if (!processo) continue;
      out.push({ fonte: 'tribunal', processo, data, tipo: m[2]!.trim().slice(0, 120), tribunal: dominio(remetente).split('.')[0]!.toUpperCase(), texto });
    }
    if (out.length) return out;
  }
  if (FONTE_JURIDICA.test(remetente)) {
    // Recorte Digital da OAB/BA e demais fontes jurídicas: um evento por processo citado.
    const dm = assunto.match(/(\d{2})\/(\d{2})\/(\d{2,4})/);
    const fonte = /recortedigital/i.test(remetente) ? 'recorte-oab' as const : /escavador/i.test(remetente) ? 'escavador' as const : 'tribunal' as const;
    return extrairCnjs(texto).map(processo => ({ fonte, processo, data: dm ? dataIso(dm[1]!, dm[2]!, dm[3]!) : data,
      tipo: 'Publicação', texto }));
  }
  return [];
}

/** Remetente automático (sem pessoa do outro lado). Governo, tribunal e OAB nunca entram aqui: ficam para a equipe. */
const AUTOMATICO = /^(no-?reply|noreply|nao-?respond[ae]r?|do-?not-?reply|news|newsletter|marketing|comunicado|notifications?(-noreply)?|messages-noreply|todomundo|reply-[^@]*|mailer|bounce[^@]*|info|verify)@/i;
const INSTITUCIONAL = /(\.gov\.br|\.jus\.br|\.mp\.br|oab-?[a-z]{0,3}\.org\.br)$/i;
export function ehRuido(remetente: string, assunto: string, texto: string): boolean {
  if (RUIDO.test(remetente)) return true;
  if (/recortedigital/i.test(remetente) && /n[ãa]o foi localizada qualquer publica/i.test(texto)) return true;
  const dom = dominio(remetente);
  if (INSTITUCIONAL.test(dom)) return false;
  return AUTOMATICO.test(remetente) && !extrairCnjs(`${assunto} ${texto}`).length;
}

export type TipoEmail = 'juridico' | 'ruido' | 'pessoa' | 'interno';
export type ResumoEmail = {
  conversation_id: string; remetente: string; assunto: string; tipo: TipoEmail;
  eventos: { processo: string; tipo: string; chave: string; novo: boolean; cliente?: string }[]; acao: string;
};

const iso = (v: unknown) => {
  if (typeof v === 'number') return new Date(v * 1000).toISOString();
  const n = Number(v); if (v !== '' && Number.isFinite(n)) return new Date(n * 1000).toISOString();
  const d = new Date(String(v)); return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
};

/**
 * Varre a caixa de e-mail (conversas pendentes e abertas) e processa o que for novo desde a última passada.
 * simular=true: só classifica e calcula as chaves, sem gravar nada (usado no replay do QA).
 */
export async function varrerEmails(crm: CrmClient, opts: { simular?: boolean; incluirResolvidas?: boolean; maxPaginas?: number } = {}) {
  const st = getState();
  const resumos: ResumoEmail[] = [];
  const status = opts.incluirResolvidas ? ['pending', 'open', 'resolved'] : ['pending', 'open'];
  for (const s of status) {
    for (let page = 1; page <= (opts.maxPaginas ?? 10); page++) {
      const res = await crm.request('GET', '/conversations', { inbox_id: legalSettings.emailInbox, status: s, page });
      const convs = collection(res).map(record).filter(Boolean) as Record<string, unknown>[];
      if (!convs.length) break;
      for (const c of convs) {
        const id = String(c.id);
        const visto = st.emails_vistos[id];
        const ultima = c.last_activity_at ?? c.timestamp ?? c.updated_at;
        if (!opts.simular && visto && ultima !== undefined && iso(ultima) <= visto) continue;
        const r = await processarConversa(crm, c, visto, !!opts.simular);
        if (r) resumos.push(r);
        if (!opts.simular) { st.emails_vistos[id] = new Date().toISOString(); saveState(); }
      }
      if (convs.length < 20) break;
    }
  }
  return resumos;
}

async function processarConversa(crm: CrmClient, c: Record<string, unknown>, visto: string | undefined, simular: boolean): Promise<ResumoEmail | null> {
  const id = String(c.id);
  const sender = record(record(c.meta)?.sender) ?? record(c.contact) ?? {};
  const remetente = String(sender.email || '');
  const msgs = collection(await crm.request('GET', `/conversations/${id}/messages`)).map(record).filter(Boolean) as Record<string, unknown>[];
  const entrada = msgs.filter(m => (Number(m.message_type) === 0 || m.message_type === 'incoming') && !m.private);
  const novas = visto && !simular ? entrada.filter(m => iso(m.created_at) > visto) : entrada;
  if (!novas.length && visto && !simular) return null;
  let assunto = String(record(c.additional_attributes)?.mail_subject || '');
  const eventos: ResumoEmail['eventos'] = [];
  for (const m of novas.length ? novas : entrada) {
    const em = record(record(m.content_attributes)?.email) ?? {};
    assunto = String(em.subject || assunto);
    for (const e of eventosDoEmail(remetente, assunto, String(m.content || ''), iso(m.created_at))) {
      const chave = chaveEvento(e);
      if (simular) { eventos.push({ processo: e.processo, tipo: e.tipo, chave, novo: !getState().eventos[chave] }); continue; }
      const salvo = await registrarEvento(crm, e);
      const reg = salvo ?? getState().eventos[chave];
      eventos.push({ processo: e.processo, tipo: e.tipo, chave, novo: !!salvo, cliente: reg?.cliente });
    }
  }
  const textoTodo = (novas.length ? novas : entrada).map(m => String(m.content || '')).join('\n');
  const tipo: TipoEmail = PROPRIOS.has(remetente.toLowerCase()) ? 'interno' : eventos.length ? 'juridico'
    : ehRuido(remetente, assunto, textoTodo) ? 'ruido' : 'pessoa';
  let acao = 'nenhuma (simulação)';
  if (!simular) {
    const status = String(c.status || '');
    try {
      const paraEquipe = tipo === 'pessoa' || tipo === 'interno';   // interno: relatório do próprio escritório, fica visível
      if (!paraEquipe && status !== 'resolved') {
        await crm.request('POST', `/conversations/${id}/toggle_status`, {}, { status: 'resolved' }); acao = 'arquivada (resolvida)';
      } else if (paraEquipe && status === 'pending') {
        await crm.request('POST', `/conversations/${id}/toggle_status`, {}, { status: 'open' }); acao = 'aberta para a equipe';
      } else acao = paraEquipe ? 'continua aberta para a equipe' : 'já estava arquivada';
    } catch { acao = 'não consegui mudar o status (fica como está)'; }
  }
  return { conversation_id: id, remetente, assunto: assunto.slice(0, 160), tipo, eventos, acao };
}
