import { z } from 'zod';
import type { CrmClient } from '../crm-client.js';
import { team, alertarEquipe, enviarParaMembro, pedirAprovacao, estadoEquipe } from '../team/team.js';
import { id } from './shared.js';
import type { Register } from './types.js';

const destino = () => z.enum(team.membros.map(m => m.chave) as [string, ...string[]]);
const listaMembros = () => team.membros.map(m => `${m.chave} = ${m.nome}`).join('; ');
const texto = z.string().trim().min(1).max(1500).describe('Texto da mensagem, até 1.500 caracteres.');

/** Para o conector OAuth (Claude do dono). */
export function registerEquipe(register: Register, crm: CrmClient) {
  if (!team.ativo) return;
  register('alerta_whatsapp_enviar',
    `Envia um alerta interno por WhatsApp a um membro da equipe (lista fixa no servidor: ${listaMembros()}). Não serve para clientes nem leads. Agrupe vários avisos num texto só.`, {
      texto, destino: destino().default(team.padrao).describe('Membro da equipe.'),
    }, true, ({ texto, destino }) => enviarParaMembro(crm, destino, texto));
  register('aprovacoes_listar', 'Lista os pedidos de aprovação de respostas a clientes (#código), com status e texto.', {
    status: z.enum(['pendente', 'enviada', 'ajustada', 'humano', 'expirada', 'todas']).default('pendente'),
  }, false, async ({ status }) => estadoEquipe().aprovacoes.filter(a => status === 'todas' || a.status === status).slice(-50).reverse());
}

/** Para o agente de atendimento (endpoint interno). */
export function registerEquipeAgente(register: Register, crm: CrmClient) {
  if (!team.ativo) return;
  register('enviar_alerta_equipe',
    `Avisa a equipe interna por WhatsApp. Destinos possíveis (lista fixa): ${listaMembros()}. ` +
    (team.escalaDe ? `Alerta para "${team.escalaDe}" pede CIENTE e, sem resposta em ${team.escalaMin} min, vai sozinho para "${team.escalaPara}". ` : '') +
    'Nunca manda para clientes. Uma mensagem por assunto.', {
      destino: destino().describe('Membro da equipe.'), texto,
    }, true, ({ destino, texto }) => alertarEquipe(crm, destino, texto));
  register('pedir_aprovacao',
    'Pede ao responsável a aprovação de uma resposta antes de enviá-la ao cliente desta conversa. Ele responde 1 (enviar), 2 + texto (enviar ajustada) ou 3 (ele mesmo responde); ' +
    'o envio aprovado sai sozinho na conversa do cliente. Use o ID do contato que aparece em "Contact Information". Depois de pedir, não envie ao cliente nada sobre o mesmo assunto.', {
      contact_id: id.describe('ID do contato do cliente (Contact Information → ID).'),
      texto_proposto: z.string().trim().min(1).max(3000).describe('Resposta exata que seria enviada ao cliente.'),
      resumo: z.string().trim().min(1).max(500).describe('Contexto em 1–2 linhas para quem aprova.'),
    }, true, ({ contact_id, texto_proposto, resumo }) => pedirAprovacao(crm, contact_id, texto_proposto, resumo));
  register('nota_contato_criar', 'Cria uma nota interna no contato (fica no histórico do cliente; o cliente não vê).', {
    contact_id: id.describe('ID do contato (Contact Information → ID).'),
    texto: z.string().trim().min(1).max(5000),
  }, true, ({ contact_id, texto }) => crm.request('POST', `/contacts/${contact_id}/notes`, {}, { note: { content: texto } }));
}
