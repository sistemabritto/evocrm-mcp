import { z } from 'zod';
import { collection, CrmError, type CrmClient } from '../crm-client.js';
import { id } from './shared.js';
import type { Register } from './types.js';

export function registerLabels(register: Register, crm: CrmClient) {
  register('labels_add', 'Adiciona labels por título a um contato ou conversa, preservando a lista consultada. Evite edições concorrentes: o upstream substitui a lista inteira.', {
    entity: z.enum(['contact', 'conversation']).describe('Tipo de entidade que receberá as labels.'),
    entity_id: id,
    labels: z.array(z.string().trim().min(1).max(100)).min(1).max(100).describe('Títulos das labels a adicionar; use títulos, não UUIDs.'),
  }, true, async ({ entity, entity_id, labels }) => {
    const path = `/${entity === 'contact' ? 'contacts' : 'conversations'}/${entity_id}/labels`;
    const existing = collection(await crm.request('GET', path));
    if (!existing.every(label => typeof label === 'string')) throw new CrmError('invalid_response', 'O CRM devolveu labels em formato inesperado; operação interrompida.');
    return crm.request('POST', path, {}, { labels: [...new Set([...existing, ...labels])] });
  }, true);
}
