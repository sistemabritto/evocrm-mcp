// Módulo opcional: assinatura eletrônica com DocuSeal (self-hosted). Repassa as ferramentas do MCP nativo do DocuSeal
// (/mcp, Bearer) e usa a API REST (/api, X-Auth-Token) para buscar os links de assinatura (envio por WhatsApp).
//   DOCUSEAL_URL              https://assinatura.exemplo.com.br
//   DOCUSEAL_MCP_TOKEN_FILE   token MCP (Configurações → MCP)
//   DOCUSEAL_API_TOKEN_FILE   token da API (Configurações → API), opcional (só para assinatura_links)
import { readFileSync, existsSync } from 'node:fs';
import { z } from 'zod';
import { CrmError } from '../crm-client.js';
import type { Register } from './types.js';

const ler = (f?: string) => (f && existsSync(f) ? readFileSync(f, 'utf8').trim() : '');
export const docuseal = {
  url: (process.env.DOCUSEAL_URL || '').replace(/\/$/, ''),
  mcpToken: ler(process.env.DOCUSEAL_MCP_TOKEN_FILE) || process.env.DOCUSEAL_MCP_TOKEN || '',
  apiToken: ler(process.env.DOCUSEAL_API_TOKEN_FILE) || process.env.DOCUSEAL_API_TOKEN || '',
};
export const docusealAtivo = () => !!(docuseal.url && docuseal.mcpToken);

let seq = 0;
async function chamar(ferramenta: string, argumentos: Record<string, unknown>) {
  const r = await fetch(`${docuseal.url}/mcp`, { method: 'POST', signal: AbortSignal.timeout(60000), redirect: 'manual',
    headers: { Authorization: `Bearer ${docuseal.mcpToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name: ferramenta, arguments: argumentos } }) });
  if (r.status === 401 || r.status === 403) throw new CrmError('docuseal_auth', 'O DocuSeal recusou o token MCP (gere outro em Configurações → MCP).');
  if (!r.ok) throw new CrmError('docuseal_http', `O DocuSeal respondeu HTTP ${r.status}.`);
  const j = await r.json() as { result?: { content?: { type: string; text?: string }[]; isError?: boolean }; error?: { message?: string } };
  if (j.error) throw new CrmError('docuseal_error', `DocuSeal: ${j.error.message ?? 'erro'}`);
  const texto = (j.result?.content ?? []).map(c => c.text ?? '').join('\n');
  if (j.result?.isError) throw new CrmError('docuseal_error', `DocuSeal: ${texto.slice(0, 300)}`);
  try { return JSON.parse(texto); } catch { return { resultado: texto }; }
}

export function registerAssinatura(register: Register) {
  if (!docusealAtivo()) return;
  const lim = z.number().int().min(1).max(50).default(10).describe('Quantidade máxima de resultados.');
  register('assinatura_modelos_buscar', 'Busca modelos de documento no DocuSeal (assinatura eletrônica) pelo nome.', {
    q: z.string().trim().min(1).max(120).describe('Parte do nome do modelo.'), limit: lim,
  }, false, a => chamar('search_templates', a));
  register('assinatura_modelo_carregar', 'Carrega um modelo do DocuSeal com seus campos e papéis de assinatura (ex.: Contratante, Contratado).', {
    template_id: z.number().int().positive().describe('ID do modelo (assinatura_modelos_buscar).'),
  }, false, a => chamar('load_template', a));
  register('assinatura_modelo_criar', 'Cria um modelo no DocuSeal a partir de um PDF/DOCX acessível por URL, ou vazio (devolve o link para subir o arquivo e posicionar os campos na tela).', {
    name: z.string().trim().min(1).max(200).describe('Nome do modelo.'),
    url: z.string().url().max(2000).optional().describe('URL pública do PDF ou DOCX (opcional).'),
  }, true, a => chamar('create_template', a));
  register('assinatura_enviar', 'Envia um modelo para assinatura. CONTATA PESSOAS REAIS: o DocuSeal manda o link por e-mail (se o SMTP estiver configurado) e os links também podem ser buscados com assinatura_links para envio por WhatsApp. Confirme modelo, signatários e campos com o usuário antes.', {
    template_id: z.number().int().positive().describe('ID do modelo.'),
    submitters: z.array(z.object({
      role: z.string().trim().max(80).optional().describe('Papel no modelo (ex.: Contratante).'),
      name: z.string().trim().max(200).optional().describe('Nome do signatário.'),
      email: z.string().email().max(200).optional().describe('E-mail do signatário.'),
      phone: z.string().regex(/^\+\d{10,15}$/).optional().describe('Telefone E.164, ex.: +5571999999999.'),
      fields: z.array(z.object({ name: z.string().max(200).describe('Nome do campo.'), value: z.union([z.string(), z.number(), z.boolean()]).describe('Valor.') }))
        .max(100).optional().describe('Campos pré-preenchidos (ficam somente leitura).'),
    })).min(1).max(10).describe('Signatários, um por papel.'),
  }, true, a => chamar('send_documents', a));
  register('assinatura_documentos_buscar', 'Busca documentos enviados para assinatura (pendentes ou assinados) por nome, e-mail, telefone ou modelo.', {
    q: z.string().trim().min(1).max(120).describe('Termo de busca.'), limit: lim,
  }, false, a => chamar('search_documents', a));
  register('assinatura_links', 'Mostra os signatários de um envio com status e o link de assinatura de cada um (para mandar por WhatsApp).', {
    submission_id: z.number().int().positive().describe('ID do envio (devolvido por assinatura_enviar ou assinatura_documentos_buscar).'),
  }, false, async ({ submission_id }) => {
    if (!docuseal.apiToken) throw new CrmError('not_configured', 'Token da API do DocuSeal não configurado (DOCUSEAL_API_TOKEN_FILE).');
    const r = await fetch(`${docuseal.url}/api/submissions/${submission_id}`, { signal: AbortSignal.timeout(30000), redirect: 'manual',
      headers: { 'X-Auth-Token': docuseal.apiToken, Accept: 'application/json' } });
    if (!r.ok) throw new CrmError('docuseal_http', `O DocuSeal respondeu HTTP ${r.status}.`);
    const s = await r.json() as { id: number; status?: string; created_at?: string; template?: { name?: string }; submitters?: Record<string, unknown>[]; combined_document_url?: string; audit_log_url?: string };
    return { id: s.id, status: s.status, modelo: s.template?.name, criado_em: s.created_at,
      documento_assinado: s.combined_document_url ?? null,
      signatarios: (s.submitters ?? []).map(x => ({ nome: x.name, email: x.email, telefone: x.phone, papel: x.role, status: x.status,
        link: x.slug ? `${docuseal.url}/s/${String(x.slug)}` : (x.embed_src ?? null), assinado_em: x.completed_at ?? null })) };
  });
}
