// Funil de tráfego pago do evo-jud-crm (API /tracking). Só existe em CRMs com o módulo de tracking.
import { z } from 'zod';
import type { CrmClient } from '../crm-client.js';
import { id } from './shared.js';
import type { Register } from './types.js';

const canal = z.enum(['meta', 'google', 'pago', 'todos', 'site', 'instagram', 'postiz', 'openreply', 'organico']).default('pago')
  .describe('Origem: meta, google, pago (Meta + Google), todos, ou orgânicos (site, instagram, postiz, openreply, organico = sem código).');
const data = z.iso.date().describe('Data AAAA-MM-DD.');
const periodo = {
  canal,
  de: data.optional().describe('Início (AAAA-MM-DD). Padrão: 30 dias atrás.'),
  ate: data.optional().describe('Fim (AAAA-MM-DD). Padrão: hoje.'),
};
const etapa = z.enum(['conversa_iniciada', 'link_agendamento_enviado', 'reuniao_agendada', 'contrato_assinado', 'pagamento_efetuado'])
  .describe('Etapa do funil.');

export function registerTrafego(register: Register, crm: CrmClient) {
  register('trafego_funil', 'Funil de tráfego por origem e período: cliques, conversa iniciada, link de agendamento enviado, reunião agendada, contrato assinado e pagamento efetuado, com números brutos, % da etapa anterior e do topo, investimento, custos por etapa, receita e ROAS. Contatos entram pela data da conversa iniciada.', periodo, false,
    async ({ canal, de, ate }) => (await crm.request('GET', '/tracking/funnel', { channel: canal, from: de, to: ate })).data);

  register('trafego_campanhas', 'Quebra do funil por código de campanha (CRM, ex.: inv1, ginv1, sger1) e métricas por campanha da plataforma (Meta/Google: gasto, impressões, cliques).', periodo, false,
    async ({ canal, de, ate }) => (await crm.request('GET', '/tracking/campaigns', { channel: canal, from: de, to: ate })).data);

  register('trafego_status', 'Mostra o que está conectado no tracking (Meta, CAPI, Google Ads, Postiz, OpenReply), última sincronização e totais por etapa.', {}, false,
    async () => (await crm.request('GET', '/tracking/status')).data);

  register('trafego_links', 'Gera links de WhatsApp com frase pronta e código de origem para anúncios, site, posts do Postiz e respostas do OpenReply. Sem prefixo = Meta, G = Google, S = site, P = Postiz, O = OpenReply, IG = Instagram.', {
    canal: z.enum(['meta', 'google', 'site', 'postiz', 'openreply', 'instagram']).describe('Onde o link vai ser usado.'),
    area: z.enum(['GER', 'INV', 'DIV', 'IMO', 'EXT', 'PRE', 'CIV', 'ELE', 'AGR', 'AMB', 'ADM']).optional().describe('Área do anúncio (vazio = todas).'),
    variacao: z.number().int().min(1).max(999).default(1).describe('Número da variação do criativo.'),
    frase: z.string().trim().min(3).max(300).optional().describe('Frase própria (o código é acrescentado no fim).'),
  }, false, async ({ canal, area, variacao, frase }) =>
    (await crm.request('GET', '/tracking/links', { channel: canal, area, variant: variacao, text: frase })).data);

  register('trafego_origem_definir', 'Corrige a origem de um contato que chegou sem código (ex.: veio de anúncio mas digitou outra frase).', {
    contact_id: id,
    canal: z.enum(['meta', 'google', 'site', 'instagram', 'postiz', 'openreply', 'organico']).describe('Origem correta.'),
    campanha: z.string().trim().max(40).optional().describe('Código da campanha, ex.: inv1.'),
  }, true, async ({ contact_id, canal, campanha }) =>
    (await crm.request('POST', `/tracking/contacts/${contact_id}/origin`, {}, { channel: canal, campaign: campanha })).data);

  register('trafego_marco_registrar', 'Registra manualmente um marco do funil para um contato (ex.: reunião feita por telefone, contrato assinado fora do DocuSeal, pagamento fora do Asaas). Idempotente: só a primeira ocorrência de cada etapa conta; pagamentos somam por external_id.', {
    etapa,
    contact_id: id.optional(),
    telefone: z.string().trim().max(30).optional().describe('Alternativa ao contact_id.'),
    email: z.string().email().optional().describe('Alternativa ao contact_id.'),
    valor: z.number().positive().max(10_000_000).optional().describe('Valor em reais (pagamento).'),
    external_id: z.string().trim().max(120).optional().describe('ID da cobrança/documento, evita contar duas vezes.'),
    quando: z.iso.datetime({ offset: true }).optional().describe('Data e hora ISO 8601. Padrão: agora.'),
  }, true, async ({ etapa, contact_id, telefone, email, valor, external_id, quando }) =>
    (await crm.request('POST', '/tracking/events', {}, {
      stage: etapa, contact_id, phone: telefone, email, value: valor, external_id, occurred_at: quando, source: 'mcp',
    })).data);
}
