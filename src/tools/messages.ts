import { z } from 'zod';
import { collection, CrmError, record, type CrmClient } from '../crm-client.js';
import { id, text } from './shared.js';
import type { Register } from './types.js';

export function registerMessages(register: Register, crm: CrmClient) {
  register('messages_list', 'Lista mensagens em ordem cronológica. O upstream usa cursor, não número de página: avance com next_before ou next_after. Sem cursor, retorna as mais recentes.', {
    conversation_id: id,
    page: z.literal(1).default(1).describe('Sempre 1: mensagens usam before/after em vez de páginas numéricas.'),
    limit: z.number().int().min(1).max(20).default(20).describe('Máximo de mensagens (1 a 20), compatível com a janela do upstream.'),
    before: id.optional().describe('ID da mensagem mais antiga vista, para buscar mensagens anteriores.'),
    after: id.optional().describe('ID da mensagem mais recente vista, para buscar mensagens posteriores. Não combine com before.'),
  }, false, async ({ conversation_id, limit, before, after }) => {
    if (before && after) throw new CrmError('invalid_arguments', 'Informe somente before ou after.');
    const result = await crm.request('GET', `/conversations/${conversation_id}/messages`, { before, after });
    const all = collection(result);
    const items = after ? all.slice(0, limit) : all.slice(-limit);
    return { items, pagination: { page: 1, limit, returned: items.length, mode: 'cursor',
      next_before: record(items[0])?.id ?? null, next_after: record(items.at(-1))?.id ?? null } };
  });
  register('message_send', 'Envia uma mensagem de saída ou nota privada. Pode contatar uma pessoa real. Após timeout, consulte messages_list antes de qualquer nova tentativa.', {
    conversation_id: id, content: text,
    private: z.boolean().default(false).describe('true cria nota interna; false envia a mensagem ao contato.'),
  }, true, ({ conversation_id, ...body }) => crm.request('POST', `/conversations/${conversation_id}/messages`, {}, { ...body, message_type: 'outgoing' }));
}
