import { z } from 'zod';
import { collection, CrmError, record, type CrmClient } from '../crm-client.js';
import { id, pagination } from './shared.js';
import type { Register } from './types.js';

// Modelos (templates) do WhatsApp e conversas da API oficial (WhatsApp Cloud / WABA).
// Criar com inbox_id de uma caixa WhatsApp Cloud envia o modelo para aprovação da Meta.

const templateName = z.string().trim().regex(/^[a-z0-9_]{1,512}$/)
  .describe('Nome do modelo: só letras minúsculas, números e _ (ex.: confirmacao_consulta). Exigência da Meta.');
const language = z.string().trim().regex(/^[a-z]{2}(_[A-Z]{2})?$/).default('pt_BR').describe('Idioma do modelo, ex.: pt_BR.');
const category = z.enum(['UTILITY', 'MARKETING', 'AUTHENTICATION'])
  .describe('Categoria da Meta. UTILITY = aviso de algo que a pessoa pediu (consulta, documento, andamento); MARKETING = promoção/convite; AUTHENTICATION = código de acesso.');
const varPattern = /\{\{(\d+)\}\}/g;
const positions = (s: string) => [...new Set([...s.matchAll(varPattern)].map(m => Number(m[1])))].sort((a, b) => a - b);
const params = z.record(z.string().regex(/^[A-Za-z0-9_]{1,40}$/), z.string().max(1024)).default({})
  .describe('Valores das variáveis do modelo. Chaves "1", "2"... na ordem de {{1}}, {{2}} (ou o nome, em modelos NAMED).');

function checkSequential(text: string, where: string) {
  const p = positions(text);
  if (p.some((n, i) => n !== i + 1)) throw new CrmError('invalid_arguments', `As variáveis do ${where} precisam ser {{1}}, {{2}}... em sequência.`);
  if (/^\s*\{\{\d+\}\}|\{\{\d+\}\}\s*$/.test(text) && where === 'corpo') {
    throw new CrmError('invalid_arguments', 'A Meta recusa corpo que começa ou termina com variável. Coloque texto antes e depois.');
  }
  return p;
}

const templateRef = {
  template_id: id.optional().describe('ID do modelo no CRM (de message_templates_list). Preferível ao nome.'),
  template_name: templateName.optional().describe('Nome do modelo, se não tiver o ID.'),
  language: language.optional(),
  params,
};
function templateParams(a: { template_id?: string; template_name?: string; language?: string; params: Record<string, string> }) {
  if (!a.template_id && !a.template_name) throw new CrmError('invalid_arguments', 'Informe template_id ou template_name.');
  return { ...(a.template_id ? { id: a.template_id } : {}), ...(a.template_name ? { name: a.template_name } : {}),
    language: a.language ?? 'pt_BR', processed_params: a.params };
}

export function registerTemplates(register: Register, crm: CrmClient) {
  register('message_templates_list', 'Lista modelos (templates) de mensagem. Com inbox_id, lista os modelos daquela caixa (ex.: WhatsApp Cloud, com o status de aprovação da Meta); sem inbox_id, o catálogo global do CRM.', {
    ...pagination,
    inbox_id: id.optional().describe('ID da caixa de entrada (de inboxes_list).'),
    category: category.optional(),
    search: z.string().trim().max(100).optional().describe('Parte do nome.'),
  }, false, ({ page, limit, inbox_id, category: cat, search }) =>
    crm.list('/message_templates', page, limit, 'remote', { inbox_id, category: cat, search, sort_by: 'name' }));

  register('message_template_get', 'Mostra um modelo: texto, componentes, variáveis e status de aprovação.', { template_id: id }, false,
    ({ template_id }) => crm.request('GET', `/message_templates/${template_id}`));

  register('message_template_create',
    'Cria um modelo de WhatsApp. Com inbox_id de uma caixa WhatsApp Cloud, o modelo vai para aprovação da Meta (status PENDING; consulte depois com message_templates_sync). ' +
    'Regras da Meta: nome em minúsculas_com_underscore; variáveis {{1}}, {{2}} em sequência com um exemplo real para cada; corpo até 1024 caracteres, sem começar nem terminar com variável; ' +
    'cabeçalho de texto até 60 caracteres com no máximo 1 variável; rodapé até 60 caracteres sem variável; até 10 botões. Confirme o texto com o usuário antes de criar.', {
    inbox_id: id.optional().describe('Caixa WhatsApp Cloud que envia o modelo para a Meta. Sem ela, o modelo fica só no catálogo interno do CRM.'),
    name: templateName, language, category,
    body: z.string().trim().min(1).max(1024).describe('Texto principal. Variáveis: {{1}}, {{2}}... Formatação do WhatsApp: *negrito*, _itálico_.'),
    body_examples: z.array(z.string().trim().min(1).max(200)).max(20).default([])
      .describe('Exemplo realista para cada variável do corpo, na ordem (ex.: ["Maria", "12/11 às 15h"]). Obrigatório se houver variáveis.'),
    header_text: z.string().trim().min(1).max(60).optional().describe('Cabeçalho de texto (opcional), com no máximo uma variável {{1}}.'),
    header_example: z.string().trim().min(1).max(60).optional().describe('Exemplo da variável do cabeçalho, se houver.'),
    footer: z.string().trim().min(1).max(60).optional().describe('Rodapé curto, sem variáveis (ex.: "Escritório Exemplo").'),
    buttons: z.array(z.object({
      type: z.enum(['QUICK_REPLY', 'URL', 'PHONE_NUMBER']),
      text: z.string().trim().min(1).max(25).describe('Texto do botão (até 25 caracteres).'),
      url: z.string().url().max(2000).optional().describe('Para URL: endereço https fixo.'),
      phone_number: z.string().regex(/^\+\d{10,15}$/).optional().describe('Para PHONE_NUMBER: +55DDDNÚMERO.'),
    })).max(10).optional().describe('Botões do modelo (até 10).'),
  }, true, async (a) => {
    const bodyVars = checkSequential(a.body, 'corpo');
    if (bodyVars.length !== a.body_examples.length) {
      throw new CrmError('invalid_arguments', `O corpo tem ${bodyVars.length} variável(is); informe o mesmo número de body_examples.`);
    }
    if (a.body.length / Math.max(1, bodyVars.length) < 10 && bodyVars.length) {
      throw new CrmError('invalid_arguments', 'Texto curto demais para a quantidade de variáveis; a Meta recusa. Acrescente texto fixo.');
    }
    const components: Record<string, unknown>[] = [];
    const variables: Record<string, unknown>[] = bodyVars.map((n, i) => ({ name: String(n), position: n, component: 'body', type: 'text', required: true, example: a.body_examples[i] }));
    if (a.header_text) {
      const hv = checkSequential(a.header_text, 'cabeçalho');
      if (hv.length > 1) throw new CrmError('invalid_arguments', 'O cabeçalho aceita no máximo uma variável.');
      if (hv.length && !a.header_example) throw new CrmError('invalid_arguments', 'Informe header_example para a variável do cabeçalho.');
      components.push({ type: 'HEADER', format: 'TEXT', text: a.header_text });
      if (hv.length) variables.push({ name: 'header_1', position: 1, component: 'header', type: 'text', required: true, example: a.header_example });
    }
    components.push({ type: 'BODY', text: a.body });
    if (a.footer) {
      if (positions(a.footer).length) throw new CrmError('invalid_arguments', 'O rodapé não aceita variáveis.');
      components.push({ type: 'FOOTER', text: a.footer });
    }
    if (a.buttons?.length) {
      for (const b of a.buttons) {
        if (b.type === 'URL' && (!b.url || !b.url.startsWith('https://') || b.url.includes('{{'))) throw new CrmError('invalid_arguments', 'Botão URL precisa de url https fixa.');
        if (b.type === 'PHONE_NUMBER' && !b.phone_number) throw new CrmError('invalid_arguments', 'Botão de telefone precisa de phone_number.');
      }
      components.push({ type: 'BUTTONS', buttons: a.buttons.map(b => ({ type: b.type, text: b.text,
        ...(b.type === 'URL' ? { url: b.url } : {}), ...(b.type === 'PHONE_NUMBER' ? { phone_number: b.phone_number } : {}) })) });
    }
    const content = [a.header_text, a.body, a.footer].filter(Boolean).join('\n\n');
    return crm.request('POST', '/message_templates', { ...(a.inbox_id ? { inbox_id: a.inbox_id } : {}) }, {
      ...(a.inbox_id ? { inbox_id: a.inbox_id } : {}),
      message_template: { name: a.name, language: a.language, category: a.category, template_type: 'text', content, components, variables, active: true },
    });
  });

  register('message_templates_sync', 'Atualiza da Meta os modelos de uma caixa WhatsApp Cloud: status (APPROVED, PENDING, REJECTED), modelos criados no Gerenciador do WhatsApp e motivos de recusa.', {
    inbox_id: id.describe('Caixa WhatsApp Cloud.'),
  }, true, ({ inbox_id }) => crm.request('POST', `/inboxes/${inbox_id}/message_templates/sync`));

  register('message_template_delete', 'Apaga um modelo. Com inbox_id de WhatsApp Cloud, apaga também na Meta (o nome fica bloqueado por 30 dias). Peça confirmação antes.', {
    template_id: id, inbox_id: id.optional().describe('Caixa do modelo, se for de WhatsApp Cloud.'),
  }, true, ({ template_id, inbox_id }) => crm.request('DELETE', `/message_templates/${template_id}`, { inbox_id }), true);

  register('conversation_reply_window',
    'Diz se dá para responder com texto livre numa conversa da API oficial: a Meta só permite texto livre até 24 h depois da última mensagem do cliente. Fora da janela, só modelo aprovado (template_send).', {
    conversation_id: id,
  }, false, async ({ conversation_id }) => {
    const conv = record((await crm.request('GET', `/conversations/${conversation_id}`)).data) ?? {};
    const inbox = record(conv.inbox) ?? {};
    const provider = String(record(inbox.provider_config)?.provider ?? inbox.provider ?? '');
    const channel = String(inbox.channel_type ?? '');
    let lastIncoming: string | null = null; let before: string | undefined;
    for (let i = 0; i < 5 && !lastIncoming; i++) {
      const items = collection(await crm.request('GET', `/conversations/${conversation_id}/messages`, { before }));
      if (!items.length) break;
      const inc = [...items].reverse().find(m => [0, 'incoming'].includes(record(m)?.message_type as number | string));
      if (inc) { const c = record(inc)?.created_at; lastIncoming = typeof c === 'number' ? new Date(c * 1000).toISOString() : String(c); }
      before = String(record(items[0])?.id ?? ''); if (!before) break;
    }
    const exempt = channel === 'Channel::Whatsapp' && ['evolution', 'evolution_go'].includes(provider);
    const until = lastIncoming ? new Date(new Date(lastIncoming).getTime() + 24 * 3600e3) : null;
    const open = exempt || (until ? until.getTime() > Date.now() : false);
    return { conversation_id, channel_type: channel, provider: provider || null, last_incoming_at: lastIncoming,
      window_applies: !exempt, can_send_free_text: open, window_closes_at: exempt ? null : until?.toISOString() ?? null,
      hint: exempt ? 'Canal não oficial: sem janela de 24 h.' : open ? 'Dentro da janela: texto livre permitido.' : 'Fora da janela: use template_send com um modelo APPROVED.' };
  });

  register('template_send',
    'Envia um modelo aprovado numa conversa existente (necessário fora da janela de 24 h da API oficial). Contata uma pessoa real: confirme modelo, variáveis e destinatário com o usuário. Após timeout, consulte messages_list antes de tentar de novo.', {
    conversation_id: id, ...templateRef,
  }, true, ({ conversation_id, ...a }) => crm.request('POST', `/conversations/${conversation_id}/messages`, {}, {
    content: '', message_type: 'outgoing', private: false, template_params: templateParams(a),
  }));

  register('conversation_start_with_template',
    'Inicia uma conversa nova com um contato por uma caixa WhatsApp Cloud, enviando um modelo aprovado (a Meta só aceita modelo como primeira mensagem da empresa). Contata uma pessoa real: confirme antes.', {
    contact_id: id, inbox_id: id.describe('Caixa WhatsApp Cloud.'), ...templateRef,
  }, true, ({ contact_id, inbox_id, ...a }) => crm.request('POST', '/conversations', {}, {
    contact_id, inbox_id, status: 'open',
    message: { content: '', message_type: 'outgoing', template_params: templateParams(a) },
  }));
}
