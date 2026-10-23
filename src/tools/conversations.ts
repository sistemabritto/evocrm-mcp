import { z } from 'zod';
import { CrmError, type CrmClient } from '../crm-client.js';
import { id, pagination } from './shared.js';
import type { Register } from './types.js';

const status = z.enum(['open', 'resolved', 'pending', 'snoozed']).describe('Estado da conversa.');
export function registerConversations(register: Register, crm: CrmClient) {
  register('conversations_list', 'Lista conversas com filtros e paginação.', {
    ...pagination, status: z.enum(['open', 'resolved', 'pending', 'snoozed', 'all']).default('open').describe('Filtra pelo estado; all inclui todos.'),
    assignee_type: z.enum(['me', 'unassigned', 'all']).default('all').describe('Filtra a atribuição das conversas.'),
    inbox_id: id.optional().describe('ID da caixa de entrada para filtrar.'),
  }, false, ({ page, limit, ...query }) => crm.list('/conversations', page, limit, 'remote', query));
  register('conversation_get', 'Consulta os detalhes de uma conversa.', { conversation_id: id }, false,
    ({ conversation_id }) => crm.request('GET', `/conversations/${conversation_id}`));
  register('conversation_assign', 'Atribui um atendente humano OU uma equipe. IDs de /agents são de IA e não servem para assignee_id. null remove a atribuição escolhida.', {
    conversation_id: id,
    assignee_id: id.nullable().optional().describe('ID do usuário humano; null remove o atendente.'),
    team_id: id.nullable().optional().describe('ID da equipe; null remove a equipe. Não combine com assignee_id.'),
  }, true, ({ conversation_id, assignee_id, team_id }) => {
    if ((assignee_id !== undefined) === (team_id !== undefined)) throw new CrmError('invalid_arguments', 'Informe exatamente um entre assignee_id e team_id.');
    return crm.request('POST', `/conversations/${conversation_id}/assignments`, {},
      assignee_id !== undefined ? { assignee_id } : { team_id });
  }, true);
  register('conversation_set_status', 'Define explicitamente o estado de uma conversa. Pode disparar automações do CRM.', {
    conversation_id: id, status,
    snoozed_until: z.iso.datetime({ offset: true }).optional().describe('Data ISO 8601 para reabrir uma conversa snoozed.'),
  }, true, ({ conversation_id, ...body }) => crm.request('POST', `/conversations/${conversation_id}/toggle_status`, {}, body), true);
}
