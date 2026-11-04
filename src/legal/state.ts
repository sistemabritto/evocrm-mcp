// Estado e configuração do monitor jurídico dentro do MCP do CRM .
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import type { EventoSalvo } from './process.js';

const env = process.env;
export const legalSettings = {
  // Opcional: só liga com LEGAL_MONITOR=true. Nenhum dado de escritório tem valor padrão.
  enabled: env.LEGAL_MONITOR === 'true',
  stateFile: env.LEGAL_STATE_FILE || '/data/juridico.json',
  emailInbox: env.LEGAL_EMAIL_INBOX_ID || '',
  // Funil de relacionamento (opcional): card do cliente movido para a etapa do tipo de ato, sem tarefa.
  posvendaPipeline: env.POSVENDA_PIPELINE_ID || '',
  posvendaStage: env.POSVENDA_STAGE_ID || '',
  // Funil de prazos (criado sozinho se não existir): um card por cliente, uma tarefa por publicação.
  prazosPipelineName: env.LEGAL_PRAZOS_PIPELINE_NAME || 'Prazos e publicações',
  semClienteNome: env.LEGAL_UNLINKED_CONTACT_NAME || 'Publicações sem cliente',
  sweepMinutes: Math.max(10, Number(env.LEGAL_SWEEP_MINUTES || 30)),
  djenHours: (env.LEGAL_DJEN_HOURS || '7,17').split(',').map(Number).filter(h => h >= 0 && h < 24).sort((a, b) => a - b),
  businessDaysOnly: env.LEGAL_BUSINESS_DAYS_ONLY !== 'false',
  digestTime: env.LEGAL_DIGEST_TIME || '07:30',
  pjeReminderWeekdays: (env.LEGAL_PJE_REMINDER_WEEKDAYS || '1,4').split(',').map(Number),
  immediateAlerts: env.LEGAL_IMMEDIATE_ALERTS === 'true',
};

export type ProcessLink = { numero: string; contact_id: string; contact_name?: string; linked_at: string };
export type LegalState = {
  processos: Record<string, ProcessLink>;
  eventos: Record<string, EventoSalvo>;
  emails_vistos: Record<string, string>;     // conversation_id → ISO do último processamento
  legal_avisados: string[];
  djen_janelas: Record<string, boolean>;
  djen_ultima?: { em: string; lidos: number; novos: number; erro?: string };
  ultima_varredura?: { em: string; motivo: string; resumo: string };
  prazos?: { pipeline_id: string; etapas: Record<EtapaPrazo, string>; sem_cliente_id: string };
  cards_prazos?: Record<string, string>;        // contact_id → pipeline_item_id no funil de prazos
  ultimo_resumo?: string; resumo_desde?: string;
};
export type EtapaPrazo = 'nova' | 'calculado' | 'elaboracao' | 'protocolado' | 'arquivado';
export const ETAPAS_PRAZO: { chave: EtapaPrazo; nome: string; cor: string }[] = [
  { chave: 'nova', nome: 'Nova', cor: '#60A5FA' }, { chave: 'calculado', nome: 'Prazo calculado', cor: '#F59E0B' },
  { chave: 'elaboracao', nome: 'Em elaboração', cor: '#A78BFA' }, { chave: 'protocolado', nome: 'Protocolado', cor: '#34D399' },
  { chave: 'arquivado', nome: 'Arquivado', cor: '#9CA3AF' },
];

let state: LegalState = { processos: {}, eventos: {}, emails_vistos: {}, legal_avisados: [], djen_janelas: {} };
export function loadLegalState(file = legalSettings.stateFile) {
  try { if (existsSync(file)) state = { ...state, ...JSON.parse(readFileSync(file, 'utf8')) }; }
  catch { console.error('jurídico: estado ilegível; começando vazio'); }
}
loadLegalState();

export const getState = () => state;
/** Gravação atômica (temporário + rename). */
export function saveState() {
  writeFileSync(legalSettings.stateFile + '.tmp', JSON.stringify(state), { mode: 0o600 });
  renameSync(legalSettings.stateFile + '.tmp', legalSettings.stateFile);
}

export const processDigits = (numero: string) => numero.replace(/\D/g, '');

// Horário da Bahia (UTC-3, sem horário de verão).
export function bahiaNow(d = new Date()) {
  const t = new Date(d.getTime() - 3 * 3600e3);
  return { date: t.toISOString().slice(0, 10), hour: t.getUTCHours(), minute: t.getUTCMinutes(), weekday: t.getUTCDay() };
}
