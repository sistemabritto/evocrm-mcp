import { z } from 'zod';
import { MAX_LIMIT } from '../config.js';
import { CrmError } from '../crm-client.js';
export const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).describe('ID retornado pelo CRM (UUID ou identificador numérico como texto).');
export const text = z.string().trim().min(1).max(10000).describe('Texto da operação, com até 10.000 caracteres.');
export const pagination = {
  page: z.number().int().min(1).max(10000).default(1).describe('Página, começando em 1. Mantenha o mesmo limite entre páginas.'),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(20).describe('Máximo de registros retornados por página (1 a 100).'),
};
export const customFields = z.record(z.string(), z.json()).describe('Campos personalizados em JSON. O objeto substitui os campos existentes; consulte e preserve os valores necessários.');
export function requireChanges(value: object) {
  if (!Object.values(value).some(v => v !== undefined)) throw new CrmError('invalid_arguments', 'Informe ao menos um campo para atualizar.');
}
export const taskType = z.enum(['call', 'email', 'meeting', 'follow_up', 'note', 'other']).describe('Tipo da tarefa.');
export const priority = z.enum(['low', 'medium', 'high', 'urgent']).describe('Prioridade da tarefa.');
