import { z } from 'zod';
import type { CrmClient } from '../crm-client.js';
import { id, text, customFields, requireChanges, priority } from './shared.js';
import type { Register } from './types.js';

const cor = z.string().regex(/^#[0-9A-Fa-f]{6}$/).describe('Cor em hexadecimal, ex.: #60A5FA.');
const tipoCampo = z.enum(['text', 'number', 'currency', 'percent', 'link', 'date', 'list', 'checkbox']);
const definicaoCampo = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,59}$/).describe('Chave do campo (minúsculas, números e _).'),
  label: z.string().trim().min(1).max(80).describe('Nome exibido.'),
  type: tipoCampo.describe('Tipo do campo.'),
  values: z.array(z.string().trim().min(1).max(80)).max(50).optional().describe('Opções, só para type=list.'),
});
/** Converte [{key,label,type}] no formato do CRM: { attributes, attribute_definitions }. */
export function camposDoFunil(defs: z.infer<typeof definicaoCampo>[]) {
  return { attributes: defs.map(d => d.key), attribute_definitions: Object.fromEntries(defs.map(d => [d.key, {
    attribute_display_name: d.label, attribute_display_type: d.type, ...(d.type === 'list' && d.values ? { attribute_values: d.values } : {}) }])) };
}

export function registerAdmin(register: Register, crm: CrmClient) {
  // ---------- Funis ----------
  register('pipeline_create', 'Cria um funil (pipeline) com etapas e, opcionalmente, campos personalizados dos cards. Por padrão nasce público.', {
    name: z.string().trim().min(1).max(120).describe('Nome do funil.'), description: text.optional(),
    pipeline_type: z.enum(['sales', 'support', 'onboarding', 'custom', 'marketing']).default('custom').describe('Tipo do funil.'),
    visibility: z.enum(['public', 'private']).default('public').describe('public: todos veem; private: só quem criou.'),
    stages: z.array(z.object({ name: z.string().trim().min(1).max(80), color: cor.optional(), description: z.string().trim().max(500).optional() }))
      .min(1).max(30).describe('Etapas, na ordem.'),
    card_fields: z.array(definicaoCampo).max(40).optional().describe('Campos personalizados exibidos nos cards.'),
  }, true, ({ stages, card_fields, ...pipeline }) => crm.request('POST', '/pipelines', {}, {
    pipeline: { ...pipeline, ...(card_fields?.length ? { custom_fields: camposDoFunil(card_fields) } : {}) }, stages,
  }));
  register('pipeline_update', 'Edita nome, descrição, visibilidade, ativação ou campos personalizados de um funil. card_fields substitui a lista de campos.', {
    pipeline_id: id, name: z.string().trim().min(1).max(120).optional().describe('Novo nome.'), description: text.optional(),
    visibility: z.enum(['public', 'private']).optional().describe('public ou private.'), is_active: z.boolean().optional().describe('false desativa o funil.'),
    card_fields: z.array(definicaoCampo).max(40).optional().describe('Nova lista completa de campos dos cards.'),
  }, true, ({ pipeline_id, card_fields, ...rest }) => {
    const pipeline = { ...rest, ...(card_fields ? { custom_fields: camposDoFunil(card_fields) } : {}) };
    requireChanges(pipeline);
    return crm.request('PATCH', `/pipelines/${pipeline_id}`, {}, { pipeline });
  });
  // ---------- Etapas ----------
  register('pipeline_stage_create', 'Cria uma etapa no fim do funil.', {
    pipeline_id: id, name: z.string().trim().min(1).max(80).describe('Nome da etapa.'), color: cor.optional(),
    stage_type: z.enum(['active', 'completed', 'cancelled']).default('active').describe('completed/cancelled marcam etapas finais.'),
  }, true, ({ pipeline_id, ...pipeline_stage }) => crm.request('POST', `/pipelines/${pipeline_id}/pipeline_stages`, {}, { pipeline_stage }));
  register('pipeline_stage_update', 'Renomeia ou muda cor/tipo de uma etapa.', {
    pipeline_id: id, stage_id: id, name: z.string().trim().min(1).max(80).optional().describe('Novo nome.'), color: cor.optional(),
    stage_type: z.enum(['active', 'completed', 'cancelled']).optional().describe('Tipo da etapa.'),
  }, true, ({ pipeline_id, stage_id, ...pipeline_stage }) => {
    requireChanges(pipeline_stage);
    return crm.request('PATCH', `/pipelines/${pipeline_id}/pipeline_stages/${stage_id}`, {}, { pipeline_stage });
  });
  register('pipeline_stage_delete', 'Exclui uma etapa vazia do funil. Confirme com o usuário antes.', { pipeline_id: id, stage_id: id }, true,
    ({ pipeline_id, stage_id }) => crm.request('DELETE', `/pipelines/${pipeline_id}/pipeline_stages/${stage_id}`), true);
  // ---------- Cards ----------
  register('pipeline_item_custom_fields_update', 'Grava os campos personalizados de um card. O objeto substitui o atual: leia antes (pipeline_items_list) e preserve o que precisar.', {
    pipeline_id: id, pipeline_item_id: id, custom_fields: customFields,
  }, true, ({ pipeline_id, pipeline_item_id, custom_fields }) =>
    crm.request('PATCH', `/pipelines/${pipeline_id}/pipeline_items/${pipeline_item_id}/update_custom_fields`, {}, { custom_fields }), true);
  register('pipeline_item_delete', 'Remove um card do funil (o contato/conversa continua existindo). Confirme com o usuário antes.', {
    pipeline_id: id, pipeline_item_id: id,
  }, true, ({ pipeline_id, pipeline_item_id }) => crm.request('DELETE', `/pipelines/${pipeline_id}/pipeline_items/${pipeline_item_id}`), true);
  // ---------- Tarefas ----------
  register('task_update', 'Edita uma tarefa: título, descrição, prazo, prioridade, responsável ou status.', {
    pipeline_id: id, task_id: id, title: z.string().trim().min(1).max(255).optional().describe('Novo título.'), description: text.optional(),
    due_date: z.iso.datetime({ offset: true }).optional().describe('Prazo em ISO 8601 com fuso horário.'),
    priority: priority.optional(), assigned_to_id: id.optional(),
    status: z.enum(['pending', 'completed', 'cancelled']).optional().describe('Novo status.'),
  }, true, ({ pipeline_id, task_id, ...task }) => {
    requireChanges(task);
    return crm.request('PATCH', `/pipelines/${pipeline_id}/pipeline_tasks/${task_id}`, {}, { task });
  });
  register('task_cancel', 'Cancela uma tarefa.', { pipeline_id: id, task_id: id }, true,
    ({ pipeline_id, task_id }) => crm.request('POST', `/pipelines/${pipeline_id}/pipeline_tasks/${task_id}/cancel`, {}, {}), true);
  register('task_reopen', 'Reabre uma tarefa concluída ou cancelada.', { pipeline_id: id, task_id: id }, true,
    ({ pipeline_id, task_id }) => crm.request('POST', `/pipelines/${pipeline_id}/pipeline_tasks/${task_id}/reopen`, {}, {}));
  // ---------- Etiquetas ----------
  register('labels_list', 'Lista as etiquetas (labels) da conta.', {}, false, () => crm.request('GET', '/labels'));
  register('label_create', 'Cria uma etiqueta (label).', {
    title: z.string().trim().min(1).max(100).regex(/^[\p{L}\p{N}_-]+$/u).describe('Título sem espaços (use - ou _).'),
    description: z.string().trim().max(500).optional().describe('Descrição.'), color: cor.optional(), show_on_sidebar: z.boolean().default(false).describe('Mostra na barra lateral.'),
  }, true, label => crm.request('POST', '/labels', {}, { label }));
  // ---------- Campos personalizados de contato/conversa ----------
  register('custom_attributes_list', 'Lista definições de campos personalizados de contatos ou conversas.', {
    attribute_model: z.enum(['contact_attribute', 'conversation_attribute']).default('contact_attribute').describe('Campos de contato ou de conversa.'),
  }, false, ({ attribute_model }) => crm.request('GET', '/custom_attribute_definitions', { attribute_model }));
  register('custom_attribute_create', 'Cria um campo personalizado para contatos ou conversas.', {
    attribute_model: z.enum(['contact_attribute', 'conversation_attribute']).describe('Contato ou conversa.'),
    attribute_key: z.string().regex(/^[a-z][a-z0-9_]{0,59}$/).describe('Chave (minúsculas, números e _).'), attribute_display_name: z.string().trim().min(1).max(80).describe('Nome exibido.'),
    attribute_display_type: tipoCampo.describe('Tipo do campo.'), attribute_description: z.string().trim().max(500).optional().describe('Descrição.'),
    attribute_values: z.array(z.string().trim().min(1).max(80)).max(50).optional().describe('Opções, só para list.'),
  }, true, custom_attribute_definition => crm.request('POST', '/custom_attribute_definitions', {}, { custom_attribute_definition }));
}
