// Google Agenda direto pela API (mesmo modelo de um sync OAuth "instalado": client_id + client_secret + refresh_token).
// Idempotente: cada prazo leva a marca privada crmChave=<chave do evento>; reenviar atualiza, nunca duplica.
// Configuração: ferramenta agenda_google_configurar (gravada no estado, arquivo 0600) ou GOOGLE_CALENDAR_CONFIG_FILE (JSON).
import { readFileSync, existsSync } from 'node:fs';
import { getState, saveState } from './state.js';
import type { EventoSalvo } from './process.js';

export type AgendaConfig = { clientId: string; clientSecret: string; refreshToken: string; calendarId: string };
type Estado = ReturnType<typeof getState> & { agenda?: AgendaConfig & { configurado_em: string; calendario?: string } };

export function agendaConfig(): AgendaConfig | null {
  const st = getState() as Estado;
  if (st.agenda?.refreshToken) return st.agenda;
  const f = process.env.GOOGLE_CALENDAR_CONFIG_FILE;
  if (f && existsSync(f)) {
    try {
      const c = JSON.parse(readFileSync(f, 'utf8')) as Partial<AgendaConfig>;
      if (c.clientId && c.clientSecret && c.refreshToken) return { clientId: c.clientId, clientSecret: c.clientSecret, refreshToken: c.refreshToken, calendarId: c.calendarId || 'primary' };
    } catch { /* arquivo inválido: agenda desligada */ }
  }
  return null;
}

let token: { valor: string; ate: number; de: string } | null = null;
async function accessToken(c: AgendaConfig): Promise<string> {
  if (token && token.de === c.refreshToken && token.ate > Date.now() + 60e3) return token.valor;
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken, grant_type: 'refresh_token' }) });
  const j = await r.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!r.ok || !j.access_token) throw new Error(`Google recusou o acesso (${j.error ?? r.status}${j.error_description ? `: ${j.error_description}` : ''}). Gere um refresh_token novo.`);
  token = { valor: j.access_token, ate: Date.now() + (j.expires_in ?? 3600) * 1000, de: c.refreshToken };
  return token.valor;
}

async function gcal(c: AgendaConfig, method: string, path: string, body?: unknown, query: Record<string, string> = {}) {
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(c.calendarId)}${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const r = await fetch(url, { method, signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${await accessToken(c)}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 204) return {};
  const j = await r.json().catch(() => ({})) as Record<string, unknown>;
  if (!r.ok) { const e = new Error(`Google Agenda respondeu ${r.status}`) as Error & { status: number }; e.status = r.status; throw e; }
  return j;
}

/** Valida credenciais e devolve o nome da agenda. */
export async function testarAgenda(c: AgendaConfig) {
  token = null;
  const cal = await gcal(c, 'GET', '');
  return String(cal.summary ?? c.calendarId);
}

export async function configurarAgenda(c: AgendaConfig) {
  const nome = await testarAgenda(c);
  const st = getState() as Estado;
  st.agenda = { ...c, configurado_em: new Date().toISOString(), calendario: nome }; saveState();
  return nome;
}

const proxDia = (d: string) => new Date(Date.parse(`${d}T12:00:00Z`) + 86400e3).toISOString().slice(0, 10);

/** Cria ou atualiza o evento de dia inteiro "Prazo: ato – CNJ" (formato que o painel legado reconhece). */
export async function prazoNaAgenda(ev: EventoSalvo): Promise<{ status: 'criado' | 'atualizado' | 'sem_agenda'; id?: string; erro?: string }> {
  const c = agendaConfig();
  if (!c || !ev.prazo_final) return { status: 'sem_agenda' };
  const corpo = {
    summary: `Prazo: ${ev.tipo} – ${ev.processo}${ev.revisar ? ' [REVISAR]' : ''}`,
    description: [ev.cliente ? `Cliente: ${ev.cliente}` : 'Cliente: (sem cliente vinculado)', ev.base_legal ? `Base legal: ${ev.base_legal}` : '',
      `Disponibilização: ${ev.data.split('-').reverse().join('/')}`, ev.link ? `Original: ${ev.link}` : '', 'Prioridade: Alta', 'Criado pelo CRM (funil Prazos e publicações).'].filter(Boolean).join('\n'),
    start: { date: ev.prazo_final, dateTime: null }, end: { date: proxDia(ev.prazo_final), dateTime: null },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 2 * 24 * 60 }, { method: 'popup', minutes: 4 * 60 }] },
    extendedProperties: { private: { crmChave: ev.chave } },
  };
  try {
    let id = (ev as EventoSalvo & { agenda_evento_id?: string }).agenda_evento_id;
    if (!id) {
      const achados = await gcal(c, 'GET', '/events', undefined, { privateExtendedProperty: `crmChave=${ev.chave}`, showDeleted: 'false', maxResults: '5' });
      id = String((Array.isArray(achados.items) ? achados.items : [])[0]?.id ?? '') || undefined;
    }
    if (id) {
      try { await gcal(c, 'PATCH', `/events/${encodeURIComponent(id)}`, corpo); return { status: 'atualizado', id }; }
      catch (e) { if (![404, 410].includes((e as { status?: number }).status ?? 0)) throw e; }
    }
    const novo = await gcal(c, 'POST', '/events', corpo);
    return { status: 'criado', id: String(novo.id ?? '') };
  } catch (e) { return { status: 'sem_agenda', erro: (e as Error).message }; }
}
