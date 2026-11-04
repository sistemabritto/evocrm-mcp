// Operações no EvoCRM usadas pelo monitor jurídico e pelas ferramentas de vínculo.
import { CrmClient, record, collection } from '../crm-client.js';
import { legalSettings as settings, getState, saveState, processDigits, type ProcessLink } from './state.js';

export function linkFor(numero: string): ProcessLink | undefined {
  return getState().processos[processDigits(numero)];
}

export async function linkProcess(crm: CrmClient, numero: string, contactId: string): Promise<ProcessLink> {
  const digits = processDigits(numero);
  if (digits.length < 15) throw new Error('Número de processo inválido (use o número CNJ completo).');
  const contact = record((await crm.request('GET', `/contacts/${contactId}`)).data) ?? {};
  const link: ProcessLink = { numero, contact_id: contactId, contact_name: String(contact.name ?? ''), linked_at: new Date().toISOString() };
  getState().processos[digits] = link;
  saveState();
  // Espelha no contato para ficar visível no CRM (não bloqueia se o CRM recusar).
  try {
    const attrs = { ...(record(contact.custom_attributes) ?? {}) };
    const list = new Set(String(attrs.processos ?? '').split(/[,;\s]+/).filter(Boolean));
    list.add(numero);
    attrs.processos = [...list].join(', ');
    await crm.request('PUT', `/contacts/${contactId}`, {}, { custom_attributes: attrs });
  } catch { console.error('jurídico: não consegui gravar processos no contato'); }
  return link;
}

export function unlinkProcess(numero: string): boolean {
  const st = getState(); const digits = processDigits(numero);
  if (!st.processos[digits]) return false;
  delete st.processos[digits]; saveState(); return true;
}

export async function addNote(crm: CrmClient, contactId: string, content: string) {
  await crm.request('POST', `/contacts/${contactId}/notes`, {}, { note: { content } });
}

/** Card do contato no funil Suporte e Pós-venda (cria em "Em andamento" se não existir). */
export async function ensurePosvendaItem(crm: CrmClient, contactId: string): Promise<string> {
  const pid = settings.posvendaPipeline;
  const items = collection(await crm.request('GET', `/pipelines/${pid}/pipeline_items`));
  const found = items.map(record).find(i => i && (
    i.contact_id === contactId || record(i.contact)?.id === contactId ||
    (i.type === 'contact' && i.item_id === contactId) || record(i.item)?.id === contactId));
  if (found?.id) return String(found.id);
  const created = record((await crm.request('POST', `/pipelines/${pid}/pipeline_items`, {},
    { type: 'contact', item_id: contactId, pipeline_stage_id: settings.posvendaStage })).data);
  const id = created?.id ?? record(created?.pipeline_item)?.id;
  if (!id) throw new Error('O CRM não devolveu o card criado.');
  return String(id);
}

export async function createTask(crm: CrmClient, itemId: string, task: {
  title: string; description: string; priority: 'low' | 'medium' | 'high' | 'urgent'; due_date?: string;
}): Promise<string | undefined> {
  const res = record((await crm.request('POST',
    `/pipelines/${settings.posvendaPipeline}/pipeline_items/${itemId}/tasks`, {}, { task: { ...task, task_type: 'follow_up' } })).data);
  const id = res?.id ?? record(res?.task)?.id;
  return id ? String(id) : undefined;
}
