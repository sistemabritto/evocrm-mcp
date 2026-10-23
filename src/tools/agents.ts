import type { CrmClient } from '../crm-client.js';
import { pagination } from './shared.js';
import type { Register } from './types.js';
export function registerAgents(register: Register, crm: CrmClient) {
  register('agents_list', 'Lista agentes de IA via /agents (proxy evo-core). Não lista usuários humanos; seus IDs não servem para atribuir atendentes.', pagination, false,
    ({ page, limit }) => crm.list('/agents', page, limit, 'remote', { skip: (page - 1) * limit, limit, pageSize: limit }));
}
