import { z } from 'zod';
import type { CrmClient } from '../crm-client.js';
import { id, text, customFields, pagination, requireChanges } from './shared.js';
import type { Register } from './types.js';

export function registerPipelines(register: Register, crm: CrmClient) {
  register('pipelines_list', 'Lista pipelines acessíveis e suas etapas. A lista não inclui os itens no upstream atual.', {
    ...pagination, include_inactive: z.boolean().default(false).describe('Inclui pipelines inativos.'),
  }, false, ({ page, limit, include_inactive }) => crm.list('/pipelines', page, limit, 'local', { include_inactive }));
  register('pipeline_get', 'Consulta um pipeline com suas etapas e itens; o upstream devolve o quadro completo.', { pipeline_id: id }, false,
    ({ pipeline_id }) => crm.request('GET', `/pipelines/${pipeline_id}`));
  register('pipeline_items_list', 'Lista itens de um pipeline. Paginação aplicada localmente, pois o upstream devolve a coleção completa.', {
    ...pagination, pipeline_id: id, stage_id: id.optional().describe('ID da etapa para filtrar.'),
    status: z.enum(['active', 'completed', 'all']).default('active').describe('Filtra itens ativos ou concluídos.'),
  }, false, ({ pipeline_id, page, limit, ...query }) => crm.list(`/pipelines/${pipeline_id}/pipeline_items`, page, limit, 'local', query));
  register('pipeline_item_create', 'Adiciona um contato ou conversa a um pipeline. Informe IDs obtidos em consultas e uma etapa do pipeline.', {
    pipeline_id: id, type: z.enum(['contact', 'conversation']).describe('Entidade associada ao novo item.'),
    item_id: id.describe('ID do contato ou da conversa, conforme type.'),
    pipeline_stage_id: id.describe('ID da etapa de destino, pertencente ao pipeline.'),
    custom_fields: customFields.optional(),
  }, true, ({ pipeline_id, ...body }) => crm.request('POST', `/pipelines/${pipeline_id}/pipeline_items`, {}, body));
  register('pipeline_item_move', 'Move um item para outra etapa do mesmo pipeline. Pode disparar automações.', {
    pipeline_id: id, pipeline_item_id: id, new_stage_id: id.describe('ID da etapa de destino.'), notes: text.optional(),
  }, true, ({ pipeline_id, pipeline_item_id, ...body }) => crm.request('PATCH', `/pipelines/${pipeline_id}/pipeline_items/${pipeline_item_id}/move_to_stage`, {}, body), true);
  register('pipeline_item_update', 'Atualiza campos personalizados, etapa e/ou notas do item. custom_fields substitui o objeto existente. Notas são persistidas mesmo sem mudança de etapa no upstream atual.', {
    pipeline_id: id, pipeline_item_id: id, pipeline_stage_id: id.optional().describe('ID da nova etapa, se houver mudança.'),
    custom_fields: customFields.optional(), notes: text.optional(),
  }, true, ({ pipeline_id, pipeline_item_id, ...body }) => {
    requireChanges(body);
    return crm.request('PATCH', `/pipelines/${pipeline_id}/pipeline_items/${pipeline_item_id}`, {}, body);
  }, true);
}
