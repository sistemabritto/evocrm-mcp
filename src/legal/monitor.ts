// Orquestra o monitor jurídico: varredura de e-mails, DJEN em janelas (dias úteis) e resumo diário à equipe.
import { CrmClient } from '../crm-client.js';
import type { Config } from '../config.js';
import { getState, saveState, bahiaNow, legalSettings } from './state.js';
import { varrerEmails, coletarDjen, djenAtivo, type ResumoEmail } from './sources.js';
import { ETAPA_ROTULO } from './classify.js';
import { garantirFunilPrazos } from './prazos.js';
import { team, enviarParaMembro, iniciarEquipe } from '../team/team.js';

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const br = (d: string) => d.split('-').reverse().join('/');
const diaUtil = (wd: number) => !legalSettings.businessDaysOnly || (wd >= 1 && wd <= 5);

export type ResultadoMonitor = { motivo: string; emails: ResumoEmail[]; djen?: { lidos: number; novos: number; erro?: string }; aviso?: string };

let emAndamento: Promise<ResultadoMonitor> | null = null;
/** Execução única: chamadas concorrentes (rajada de e-mails, agente + agendador) reaproveitam a mesma rodada. */
export function rodarMonitor(crm: CrmClient, motivo: string, opts: { djenAgora?: boolean } = {}): Promise<ResultadoMonitor> {
  if (emAndamento) return emAndamento;
  emAndamento = executar(crm, motivo, opts).finally(() => { emAndamento = null; });
  return emAndamento;
}

function janelaDjen(now = bahiaNow()) {
  if (!diaUtil(now.weekday)) return '';
  const h = legalSettings.djenHours.filter(x => now.hour >= x).pop();
  return h === undefined ? '' : `${now.date}-${h}`;
}

async function executar(crm: CrmClient, motivo: string, opts: { djenAgora?: boolean }): Promise<ResultadoMonitor> {
  const st = getState();
  const emails = legalSettings.emailInbox ? await varrerEmails(crm) : [];
  const out: ResultadoMonitor = { motivo, emails };
  const janela = janelaDjen();
  if (djenAtivo() && (opts.djenAgora || (janela && !st.djen_janelas[janela]))) {
    const dj = await coletarDjen(crm);
    if (!dj.erro && janela) st.djen_janelas[janela] = true;
    out.djen = { lidos: dj.lidos, novos: dj.novos.length, erro: dj.erro };
    saveState();
  }
  if (legalSettings.immediateAlerts) out.aviso = await avisarImportantes(crm, bahiaNow().hour);
  const novosEventos = emails.reduce((n, e) => n + e.eventos.filter(x => x.novo).length, 0) + (out.djen?.novos ?? 0);
  st.ultima_varredura = { em: new Date().toISOString(), motivo,
    resumo: `${emails.length} e-mail(s) processado(s), ${novosEventos} publicação(ões) nova(s)${out.djen?.erro ? `; DJEN: ${out.djen.erro}` : ''}` };
  saveState();
  if (emails.length || novosEventos) console.error(`jurídico (${motivo}): ${st.ultima_varredura.resumo}`);
  return out;
}

/** (Opcional, LEGAL_IMMEDIATE_ALERTS=true) uma mensagem por rodada para sentença/audiência/recurso de cliente identificado. */
async function avisarImportantes(crm: CrmClient, hora: number): Promise<string | undefined> {
  if (hora < 7 || hora >= 21 || !team.ativo) return undefined;
  const st = getState(); const desde = Date.now() - 3 * 86400e3;
  const imp = Object.values(st.eventos).filter(e => e.contact_id && ['sentenca', 'audiencia', 'recurso'].includes(e.etapa)
    && !st.legal_avisados.includes(e.chave) && Date.parse(e.criado_em) >= desde);
  if (!imp.length) return undefined;
  const linhas = imp.slice(0, 8).map(e => `• ${ETAPA_ROTULO[e.etapa]}: ${e.processo}${e.cliente ? ` (${cut(e.cliente, 40)})` : ''} — ${cut(e.tipo, 60)}`);
  try {
    await enviarParaMembro(crm, team.padrao, `*⚖️ Movimentação importante (${imp.length})*\n${linhas.join('\n')}${imp.length > 8 ? `\n… e mais ${imp.length - 8}.` : ''}`);
    st.legal_avisados.push(...imp.map(e => e.chave)); st.legal_avisados = st.legal_avisados.slice(-500); saveState();
    return `aviso enviado (${imp.length})`;
  } catch (e) { return `aviso adiado: ${(e as Error).message}`; }
}

/** Texto do resumo diário. Devolve null se não houver novidade nem lembrete. */
export function montarResumo(now = bahiaNow()): string | null {
  const st = getState();
  const desde = st.resumo_desde ?? new Date(Date.now() - 86400e3).toISOString();
  const novas = Object.values(st.eventos).filter(e => e.criado_em > desde).sort((a, b) => a.processo.localeCompare(b.processo));
  const lembrete = legalSettings.pjeReminderWeekdays.includes(now.weekday);
  const limite = new Date(Date.parse(`${now.date}T00:00:00-03:00`) + 6 * 86400e3).toISOString().slice(0, 10);
  const proximos = Object.values(st.eventos).filter(e => e.prazo_final && e.prazo_final >= now.date && e.prazo_final <= limite)
    .sort((a, b) => a.prazo_final!.localeCompare(b.prazo_final!));
  if (!novas.length && !lembrete) return null;
  const partes: string[] = [`*⚖️ Publicações — ${br(now.date)}*`];
  if (novas.length) {
    const comCli = novas.filter(e => e.contact_id), semCli = novas.filter(e => !e.contact_id);
    partes.push(`Novas: ${novas.length} (${comCli.length} com cliente, ${semCli.length} sem cliente)`);
    partes.push(...novas.slice(0, 12).map(e => `• ${e.processo} — ${cut(e.tipo, 50)}${e.cliente ? ` — ${cut(e.cliente, 30)}` : ' — sem cliente'}${e.conferir ? ' (conferir no PJe)' : ''}`));
    if (novas.length > 12) partes.push(`… e mais ${novas.length - 12}.`);
  } else partes.push('Sem publicações novas desde o último resumo.');
  if (proximos.length) partes.push('', '*Prazos nos próximos dias*', ...proximos.slice(0, 10).map(e => `• ${br(e.prazo_final!)} — ${e.processo} — ${cut(e.tipo, 40)}${e.revisar ? ' [REVISAR]' : ''}`));
  if (lembrete) partes.push('', '📌 Lembrete: conferir o painel do PJe. Intimação feita só no portal (Lei 11.419/2006, art. 5º) pode não sair no DJEN.');
  partes.push('', 'Detalhes no CRM (funil Prazos e publicações) e no Claude.');
  return partes.join('\n');
}

async function talvezResumo(crm: CrmClient) {
  if (!team.ativo) return;
  const now = bahiaNow(); const st = getState();
  const [hh, mm] = legalSettings.digestTime.split(':').map(Number);
  if (!diaUtil(now.weekday) || st.ultimo_resumo === now.date || now.hour * 60 + now.minute < (hh ?? 7) * 60 + (mm ?? 30)) return;
  const texto = montarResumo(now);
  st.ultimo_resumo = now.date;
  if (texto) {
    try { await enviarParaMembro(crm, team.padrao, texto); st.resumo_desde = new Date().toISOString(); }
    catch (e) { st.ultimo_resumo = undefined; console.error('jurídico: resumo não enviado', (e as Error).message); }
  }
  saveState();
}

export function iniciarMonitor(config: Pick<Config, 'baseUrl' | 'apiToken'>) {
  const crm = new CrmClient(config);
  iniciarEquipe(crm);
  if (!legalSettings.enabled) return;
  const rodar = (m: string) => void rodarMonitor(crm, m).catch(e => console.error('jurídico:', (e as Error).message));
  setTimeout(() => {
    void garantirFunilPrazos(crm).then(f => console.error(`jurídico: funil de prazos ${f.pipeline_id}`)).catch(e => console.error('jurídico: funil de prazos', (e as Error).message));
    rodar('início');
  }, 20_000).unref();
  setInterval(() => rodar('agendado'), legalSettings.sweepMinutes * 60e3).unref();
  setInterval(() => {
    const j = janelaDjen();
    if (djenAtivo() && j && !getState().djen_janelas[j]) rodar('janela DJEN');
    void talvezResumo(crm).catch(e => console.error('jurídico: resumo', (e as Error).message));
  }, 5 * 60e3).unref();
}
