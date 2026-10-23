import { z } from 'zod';
import type { CrmClient } from '../crm-client.js';
import { id, text, pagination, requireChanges } from './shared.js';
import type { Register } from './types.js';

const fields = {
  name: z.string().trim().min(1).max(255).optional().describe('Nome do contato.'),
  email: z.email().max(254).optional().describe('E-mail do contato.'),
  phone_number: z.string().regex(/^\+[1-9]\d{7,14}$/).optional().describe('Telefone com código de país no formato E.164.'),
  identifier: z.string().trim().min(1).max(255).optional().describe('Identificador externo do contato.'),
};
export function registerContacts(register: Register, crm: CrmClient) {
  register('contacts_list', 'Lista contatos do CRM com paginação.', pagination, false,
    ({ page, limit }) => crm.list('/contacts', page, limit));
  register('contacts_search', 'Busca contatos por nome, e-mail, telefone ou identificador.', {
    ...pagination, q: z.string().trim().min(1).max(200).describe('Termo de busca do contato.'),
  }, false, ({ page, limit, q }) => crm.list('/contacts/search', page, limit, 'remote', { q }));
  register('contact_get', 'Consulta um contato. Use include_notes=true para conferir notas após resultado incerto.', {
    contact_id: id, include_notes: z.boolean().default(false).describe('Inclui uma página de notas do contato para conferência.'),
    ...pagination,
  }, false, async ({ contact_id, include_notes, page, limit }) => {
    const result = await crm.request('GET', `/contacts/${contact_id}`);
    if (!include_notes) return result;
    const notes = await crm.list(`/contacts/${contact_id}/notes`, page, limit, 'local');
    return { ...result, notes };
  });
  register('contact_create', 'Cria um contato. Confira contacts_search antes de repetir uma criação.', {
    ...fields, name: z.string().trim().min(1).max(255).describe('Nome do novo contato.'),
  }, true, args => crm.request('POST', '/contacts', {}, args));
  register('contact_update', 'Atualiza os campos informados de um contato.', { contact_id: id, ...fields }, true,
    ({ contact_id, ...body }) => { requireChanges(body); return crm.request('PUT', `/contacts/${contact_id}`, {}, body); }, true);
  register('contact_note_add', 'Adiciona uma nota ao contato. Após timeout, consulte contact_get com include_notes=true antes de repetir.', {
    contact_id: id, content: text,
  }, true, ({ contact_id, content }) => crm.request('POST', `/contacts/${contact_id}/notes`, {}, { note: { content } }));
}
