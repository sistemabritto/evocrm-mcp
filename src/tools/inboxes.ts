import type { CrmClient } from '../crm-client.js';
import { pagination } from './shared.js';
import type { Register } from './types.js';
export function registerInboxes(register: Register, crm: CrmClient) {
  register('inboxes_list', 'Lista caixas de entrada acessíveis com paginação.', pagination, false,
    ({ page, limit }) => crm.list('/inboxes', page, limit));
}
