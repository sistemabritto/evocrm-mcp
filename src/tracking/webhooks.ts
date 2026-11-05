// Webhooks que alimentam o funil de tráfego do evo-jud-crm (POST /tracking/events no CRM):
//   /webhooks/asaas     PAYMENT_RECEIVED | PAYMENT_CONFIRMED  -> pagamento_efetuado (valor somado por cobrança)
//   /webhooks/docuseal  submission.completed | form.completed -> contrato_assinado
// Autenticação: TRACKING_WEBHOOK_TOKEN_FILE. Asaas manda no cabeçalho asaas-access-token;
// DocuSeal no cabeçalho x-tracking-token (configurado no webhook do DocuSeal).
import { readFileSync, existsSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { CrmClient } from '../crm-client.js';
import { asaasAtivo, asaasCliente } from '../tools/asaas.js';

const tokenFile = process.env.TRACKING_WEBHOOK_TOKEN_FILE;
const TOKEN = tokenFile && existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : (process.env.TRACKING_WEBHOOK_TOKEN || '');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const webhooksAtivos = () => process.env.TRACKING_ENABLED === 'true' && TOKEN.length >= 20;

export function tokenValido(given: string | undefined) {
  if (!TOKEN || !given) return false;
  const a = createHash('sha256').update(TOKEN).digest(), b = createHash('sha256').update(given).digest();
  return timingSafeEqual(a, b);
}

type Marco = { stage: string; contact_id?: string; phone?: string; email?: string; value?: number; external_id?: string; occurred_at?: string };

async function registrar(crm: CrmClient, m: Marco) {
  try {
    await crm.request('POST', '/tracking/events', {}, { ...m, source: m.stage === 'pagamento_efetuado' ? 'asaas' : 'docuseal' });
    return 'registrado';
  } catch (e) {
    const status = (e as { status?: number }).status;
    return status === 404 ? 'contato_nao_encontrado' : 'falhou';
  }
}

type Pagamento = { id?: string; customer?: string; value?: number; paymentDate?: string; confirmedDate?: string; clientPaymentDate?: string; externalReference?: string };

export async function webhookAsaas(crm: CrmClient, body: { event?: string; payment?: Pagamento }) {
  if (!['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'].includes(String(body.event))) return { ignorado: body.event ?? 'sem evento' };
  const p = body.payment ?? {};
  if (!p.id || !p.value) return { ignorado: 'pagamento sem id/valor' };
  const quando = p.clientPaymentDate || p.paymentDate || p.confirmedDate;
  const base: Marco = { stage: 'pagamento_efetuado', value: Number(p.value), external_id: p.id, occurred_at: quando ? `${quando}T12:00:00-03:00` : undefined };
  if (p.externalReference && UUID.test(p.externalReference)) {
    const r = await registrar(crm, { ...base, contact_id: p.externalReference });
    if (r === 'registrado') return { resultado: r, por: 'externalReference da cobrança' };
  }
  if (!p.customer || !asaasAtivo()) return { resultado: 'contato_nao_encontrado' };
  const c = await asaasCliente(p.customer);
  if (c.externalReference && UUID.test(c.externalReference)) {
    const r = await registrar(crm, { ...base, contact_id: c.externalReference });
    if (r === 'registrado') return { resultado: r, por: 'externalReference do cliente' };
  }
  return { resultado: await registrar(crm, { ...base, phone: c.mobilePhone || c.phone, email: c.email }), por: 'telefone/e-mail' };
}

type Signatario = { email?: string; phone?: string; status?: string; completed_at?: string; submission_id?: number };

export async function webhookDocuseal(crm: CrmClient, body: { event_type?: string; data?: Signatario & { id?: number; submitters?: Signatario[] } }) {
  const tipo = String(body.event_type);
  const d = body.data ?? {};
  let lista: Signatario[] = [];
  if (tipo === 'submission.completed') lista = d.submitters ?? [];
  else if (tipo === 'form.completed') lista = [d];
  else return { ignorado: tipo };
  const envio = tipo === 'submission.completed' ? d.id : d.submission_id;
  const resultados = [];
  for (const s of lista.filter(x => x.email || x.phone)) {
    resultados.push(await registrar(crm, { stage: 'contrato_assinado', phone: s.phone, email: s.email, external_id: envio ? `docuseal-${envio}` : undefined,
      occurred_at: s.completed_at }));
  }
  return { resultados };
}
