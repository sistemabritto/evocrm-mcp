// Módulo opcional: cobranças no Asaas (API v3). Lista fechada de operações — sem transferência, estorno ou exclusão.
//   ASAAS_API_KEY_FILE   chave da API (produção: $aact_prod_..., sandbox: $aact_hmlg_...)
//   ASAAS_BASE_URL       padrão https://api.asaas.com/v3 (sandbox: https://api-sandbox.asaas.com/v3)
// Agente de atendimento: só lê cobranças DO PRÓPRIO CLIENTE (CPF/CNPJ conferido no servidor) e gera segunda via.
// Conector (dono): também cria cliente e cobrança e consulta saldo.
import { readFileSync, existsSync } from 'node:fs';
import { z } from 'zod';
import { CrmError } from '../crm-client.js';
import type { Register } from './types.js';

const ler = (f?: string) => (f && existsSync(f) ? readFileSync(f, 'utf8').trim() : '');
export const asaas = {
  key: ler(process.env.ASAAS_API_KEY_FILE) || process.env.ASAAS_API_KEY || '',
  base: (process.env.ASAAS_BASE_URL || 'https://api.asaas.com/v3').replace(/\/$/, ''),
};
export const asaasAtivo = () => !!asaas.key;
const so = (s: string) => s.replace(/\D/g, '');

async function api<T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, query: Record<string, string | number | undefined> = {}, body?: unknown): Promise<T> {
  if (!/^\/[A-Za-z0-9/_-]+$/.test(path)) throw new CrmError('invalid_arguments', 'Caminho inválido.');
  const url = new URL(asaas.base + path);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  const r = await fetch(url, { method, signal: AbortSignal.timeout(30000), redirect: 'manual',
    headers: { access_token: asaas.key, 'User-Agent': 'evocrm-mcp', Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({})) as Record<string, unknown>;
  if (!r.ok) {
    const erros = Array.isArray(j.errors) ? (j.errors as { description?: string }[]).map(e => e.description).filter(Boolean).join('; ') : '';
    throw new CrmError(r.status === 401 ? 'asaas_auth' : 'asaas_http', r.status === 401 ? 'O Asaas recusou a chave da API.' : `Asaas: ${erros || `HTTP ${r.status}`}`.slice(0, 300));
  }
  return j as T;
}

/** Cliente do Asaas por ID (usado pelo webhook de pagamento do funil de tráfego). */
export async function asaasCliente(customerId: string) {
  if (!/^cus_[A-Za-z0-9]+$/.test(customerId)) throw new CrmError('invalid_arguments', 'Cliente inválido.');
  return api<{ id: string; name?: string; email?: string; mobilePhone?: string; phone?: string; cpfCnpj?: string; externalReference?: string }>('GET', `/customers/${customerId}`);
}

type Cobranca = { id: string; customer: string; value: number; netValue?: number; dueDate: string; status: string; billingType: string;
  description?: string; invoiceUrl?: string; bankSlipUrl?: string; paymentDate?: string; installmentNumber?: number };
const resumo = (c: Cobranca) => ({ id: c.id, valor: c.value, vencimento: c.dueDate, status: c.status, forma: c.billingType,
  descricao: c.description ?? '', pago_em: c.paymentDate ?? null, link: c.invoiceUrl ?? null, parcela: c.installmentNumber ?? null });

async function clientePorDocumento(doc: string) {
  const d = so(doc);
  if (![11, 14].includes(d.length)) throw new CrmError('invalid_arguments', 'Informe CPF (11 dígitos) ou CNPJ (14 dígitos).');
  const r = await api<{ data: Record<string, unknown>[] }>('GET', '/customers', { cpfCnpj: d, limit: 10 });
  return r.data ?? [];
}

async function segundaVia(paymentId: string) {
  const c = await api<Cobranca>('GET', `/payments/${paymentId}`);
  const extra: Record<string, unknown> = {};
  if (['PENDING', 'OVERDUE'].includes(c.status)) {
    if (c.billingType === 'BOLETO' || c.billingType === 'UNDEFINED') {
      const l = await api<{ identificationField?: string }>('GET', `/payments/${paymentId}/identificationField`).catch(() => null);
      if (l?.identificationField) extra.linha_digitavel = l.identificationField;
      if (c.bankSlipUrl) extra.boleto_pdf = c.bankSlipUrl;
    }
    if (c.billingType === 'PIX' || c.billingType === 'BOLETO' || c.billingType === 'UNDEFINED') {
      const p = await api<{ payload?: string; expirationDate?: string }>('GET', `/payments/${paymentId}/pixQrCode`).catch(() => null);
      if (p?.payload) { extra.pix_copia_e_cola = p.payload; extra.pix_valido_ate = p.expirationDate ?? null; }
    }
  }
  return { ...resumo(c), ...extra, observacao: ['PENDING', 'OVERDUE'].includes(c.status) ? null : 'Cobrança não está em aberto: não há segunda via.' };
}

const doc = z.string().trim().min(11).max(20).describe('CPF ou CNPJ do cliente (com ou sem pontuação).');
const idCob = z.string().trim().regex(/^pay_[A-Za-z0-9]+$/).describe('ID da cobrança no Asaas (pay_...).');
const statusCob = z.enum(['PENDING', 'OVERDUE', 'RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH', 'REFUNDED']).optional().describe('Filtra por status.');

/** Agente de atendimento: só dados do próprio cliente, conferidos pelo CPF/CNPJ. */
export function registerAsaasAgente(register: Register) {
  if (!asaasAtivo()) return;
  register('asaas_minhas_cobrancas', 'Lista as cobranças (Asaas) do cliente desta conversa pelo CPF/CNPJ que ele informou. Use só depois de confirmar a identidade. Mostra valor, vencimento, status e link de pagamento.', {
    cpf_cnpj: doc, status: statusCob,
  }, false, async ({ cpf_cnpj, status }) => {
    const clientes = await clientePorDocumento(cpf_cnpj);
    if (!clientes.length) return { encontrado: false, mensagem: 'Nenhum cadastro no Asaas com esse CPF/CNPJ. Avise a equipe (não invente valores).' };
    const itens: ReturnType<typeof resumo>[] = [];
    for (const cl of clientes) {
      const r = await api<{ data: Cobranca[] }>('GET', '/payments', { customer: String(cl.id), status, limit: 50 });
      itens.push(...(r.data ?? []).map(resumo));
    }
    return { encontrado: true, cliente: String(clientes[0]!.name ?? ''), cobrancas: itens.sort((a, b) => a.vencimento.localeCompare(b.vencimento)) };
  });
  register('asaas_segunda_via', 'Gera a segunda via de uma cobrança em aberto do cliente: link de pagamento, linha digitável do boleto e PIX copia-e-cola. Exige o CPF/CNPJ do cliente, que o servidor confere com a cobrança.', {
    payment_id: idCob, cpf_cnpj: doc,
  }, false, async ({ payment_id, cpf_cnpj }) => {
    const clientes = await clientePorDocumento(cpf_cnpj);
    const c = await api<Cobranca>('GET', `/payments/${payment_id}`);
    if (!clientes.some(cl => cl.id === c.customer)) throw new CrmError('forbidden', 'Esta cobrança não pertence ao CPF/CNPJ informado.');
    return segundaVia(payment_id);
  });
}

/** Conector do dono: consultas amplas e criação de cliente/cobrança. */
export function registerAsaas(register: Register) {
  if (!asaasAtivo()) return;
  registerAsaasAgente(register);
  register('asaas_clientes_buscar', 'Busca clientes no Asaas por nome, e-mail ou CPF/CNPJ.', {
    nome: z.string().trim().min(2).max(120).optional().describe('Parte do nome.'),
    email: z.string().email().optional().describe('E-mail.'), cpf_cnpj: doc.optional(),
  }, false, async ({ nome, email, cpf_cnpj }) => {
    const r = await api<{ data: Record<string, unknown>[]; totalCount?: number }>('GET', '/customers', { name: nome, email, cpfCnpj: cpf_cnpj ? so(cpf_cnpj) : undefined, limit: 20 });
    return { total: r.totalCount ?? r.data?.length ?? 0, clientes: (r.data ?? []).map(c => ({ id: c.id, nome: c.name, cpf_cnpj: c.cpfCnpj, email: c.email, celular: c.mobilePhone })) };
  });
  register('asaas_cobrancas_listar', 'Lista cobranças do Asaas, opcionalmente de um cliente e/ou status.', {
    customer_id: z.string().regex(/^cus_[A-Za-z0-9]+$/).optional().describe('ID do cliente no Asaas (cus_...).'), status: statusCob,
    vencimento_de: z.iso.date().optional().describe('Vencimento a partir de (AAAA-MM-DD).'), vencimento_ate: z.iso.date().optional().describe('Vencimento até (AAAA-MM-DD).'),
  }, false, async ({ customer_id, status, vencimento_de, vencimento_ate }) => {
    const r = await api<{ data: Cobranca[]; totalCount?: number }>('GET', '/payments', { customer: customer_id, status, 'dueDate[ge]': vencimento_de, 'dueDate[le]': vencimento_ate, limit: 100 });
    return { total: r.totalCount ?? 0, cobrancas: (r.data ?? []).map(resumo) };
  });
  register('asaas_cobranca_detalhe', 'Detalha uma cobrança e devolve a segunda via se estiver em aberto.', { payment_id: idCob }, false, ({ payment_id }) => segundaVia(payment_id));
  register('asaas_cliente_criar', 'Cria um cliente no Asaas (se já existir com o mesmo CPF/CNPJ, devolve o existente).', {
    nome: z.string().trim().min(2).max(200).describe('Nome completo.'), cpf_cnpj: doc,
    email: z.string().email().optional().describe('E-mail.'), celular: z.string().trim().max(20).optional().describe('Celular com DDD.'),
    referencia_externa: z.string().trim().max(100).optional().describe('ID do contato no CRM, para cruzar os sistemas.'),
  }, true, async ({ nome, cpf_cnpj, email, celular, referencia_externa }) => {
    const ja = await clientePorDocumento(cpf_cnpj);
    if (ja.length) return { criado: false, id: ja[0]!.id, nome: ja[0]!.name };
    const c = await api('POST', '/customers', {}, { name: nome, cpfCnpj: so(cpf_cnpj), email, mobilePhone: celular ? so(celular) : undefined, externalReference: referencia_externa, notificationDisabled: false });
    return { criado: true, id: c.id, nome: c.name };
  });
  register('asaas_cobranca_criar', 'Cria uma cobrança no Asaas (boleto, PIX, cartão ou "o cliente escolhe"). O Asaas pode notificar o cliente conforme a configuração da conta. Confirme valor, vencimento e descrição com o usuário antes.', {
    customer_id: z.string().regex(/^cus_[A-Za-z0-9]+$/).describe('ID do cliente (cus_...).'),
    valor: z.number().positive().max(1_000_000).describe('Valor total em reais.'),
    vencimento: z.iso.date().describe('Vencimento (AAAA-MM-DD).'),
    forma: z.enum(['UNDEFINED', 'BOLETO', 'PIX', 'CREDIT_CARD']).default('UNDEFINED').describe('UNDEFINED deixa o cliente escolher.'),
    descricao: z.string().trim().min(3).max(500).describe('Ex.: "Honorários — parcela 1/3, contrato de 04/11/2026".'),
    parcelas: z.number().int().min(2).max(24).optional().describe('Número de parcelas (o valor é o total).'),
    referencia_externa: z.string().trim().max(100).optional().describe('ID do contato/card no CRM.'),
  }, true, async ({ customer_id, valor, vencimento, forma, descricao, parcelas, referencia_externa }) => {
    const corpo: Record<string, unknown> = { customer: customer_id, billingType: forma, dueDate: vencimento, description: descricao, externalReference: referencia_externa };
    if (parcelas) { corpo.installmentCount = parcelas; corpo.totalValue = valor; } else corpo.value = valor;
    const c = await api<Cobranca & { installment?: string }>('POST', '/payments', {}, corpo);
    return { ...resumo(c), parcelamento: c.installment ?? null };
  });
  register('asaas_saldo', 'Mostra o saldo disponível na conta Asaas.', {}, false, async () => {
    const b = await api<{ balance?: number }>('GET', '/finance/balance');
    return { saldo: b.balance ?? null };
  });
}
