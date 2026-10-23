import { z } from 'zod';
import type { CrmClient } from '../crm-client.js';
import { id, text, pagination, priority, taskType } from './shared.js';
import type { Register } from './types.js';

export function registerTasks(register: Register, crm: CrmClient) {
  register('tasks_list', 'Lista tarefas de um item de pipeline com paginação local. Inclui subtarefas na hierarquia.', {
    ...pagination, pipeline_id: id, pipeline_item_id: id,
    status: z.enum(['pending', 'completed', 'cancelled', 'overdue']).optional().describe('Estado das tarefas para filtrar.'),
    hierarchy: z.enum(['root', 'all']).default('all').describe('root inclui somente raízes; all inclui todos os níveis.'),
  }, false, ({ pipeline_id, pipeline_item_id, page, limit, ...query }) =>
    crm.list(`/pipelines/${pipeline_id}/pipeline_items/${pipeline_item_id}/tasks`, page, limit, 'local', query));
  register('task_create', 'Cria uma tarefa vinculada a um item de pipeline.', {
    pipeline_id: id, pipeline_item_id: id,
    title: z.string().trim().min(1).max(255).describe('Título da tarefa.'), description: text.optional(),
    task_type: taskType.default('follow_up'), priority: priority.default('low'),
    due_date: z.iso.datetime({ offset: true }).optional().describe('Prazo em ISO 8601 com fuso horário.'),
    assigned_to_id: id.optional().describe('ID do usuário humano responsável.'),
    parent_task_id: id.optional().describe('ID da tarefa pai para criar uma subtarefa.'),
  }, true, ({ pipeline_id, pipeline_item_id, ...task }) =>
    crm.request('POST', `/pipelines/${pipeline_id}/pipeline_items/${pipeline_item_id}/tasks`, {}, { task }));
  register('task_complete', 'Conclui uma tarefa e suas subtarefas. Essa ação pode afetar toda a hierarquia descendente.', {
    pipeline_id: id, task_id: id,
  }, true, ({ pipeline_id, task_id }) => crm.request('POST', `/pipelines/${pipeline_id}/pipeline_tasks/${task_id}/complete`, {}, {}), true);
}
