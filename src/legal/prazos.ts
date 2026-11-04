// Funil "Prazos e publicações": um card por cliente (o CRM só permite um card ativo por contato e funil)
// e uma tarefa por publicação. Publicações sem cliente ficam no card do contato "Publicações sem cliente".
import { CrmClient, record, collection } from '../crm-client.js';
import { getState, saveState, legalSettings, ETAPAS_PRAZO, type EtapaPrazo } from './state.js';
import { camposDoFunil } from '../tools/admin.js';

const CAMPOS = [
  { key: 'processos', label: 'Processos (CNJ)', type: 'text' as const },
  { key: 'tribunal', label: 'Tribunal', type: 'text' as const },
  { key: 'ultimo_ato', label: 'Último ato', type: 'text' as const },
  { key: 'disponibilizacao', label: 'Disponibilização', type: 'date' as const },
  { key: 'prazo_final', label: 'Próximo prazo final', type: 'date' as const },
  { key: 'fontes', label: 'Fontes', type: 'text' as const },
  { key: 'pendentes', label: 'Publicações pendentes', type: 'number' as const },
];
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

let preparando: Promise<NonNullable<ReturnType<typeof getState>['prazos']>> | null = null;
/** Garante o funil, as etapas e o contato "Publicações sem cliente". Idempotente. */
export function garantirFunilPrazos(crm: CrmClient) {
  const st = getState();
  if (st.prazos?.pipeline_id && st.prazos.sem_cliente_id && Object.keys(st.prazos.etapas ?? {}).length === ETAPAS_PRAZO.length) return Promise.resolve(st.prazos);
  preparando ??= (async () => {
    const lista = collection(await crm.request('GET', '/pipelines', { include_inactive: true })).map(record).filter(Boolean) as Record<string, unknown>[];
    let p = lista.find(x => norm(String(x.name)) === norm(legalSettings.prazosPipelineName));
    if (!p) {
      p = record((await crm.request('POST', '/pipelines', {}, {
        pipeline: { name: legalSettings.prazosPipelineName, description: 'Publicações (DJEN, Jusbrasil, PJe, Escavador, Recorte OAB, tribunais): um card por cliente, uma tarefa por publicação. Criado pelo monitor jurídico.',
          pipeline_type: 'custom', visibility: 'public', custom_fields: camposDoFunil(CAMPOS) },
        stages: ETAPAS_PRAZO.map(e => ({ name: e.nome, color: e.cor })),
      })).data) ?? {};
    }
    const pid = String(p.id ?? '');
    if (!pid) throw new Error('Não consegui criar o funil de prazos.');
    let estagios = (Array.isArray(p.stages) ? p.stages : Array.isArray(p.pipeline_stages) ? p.pipeline_stages : []).map(record).filter(Boolean) as Record<string, unknown>[];
    if (!estagios.length) {
      const full = record((await crm.request('GET', `/pipelines/${pid}`)).data) ?? {};
      estagios = (Array.isArray(full.stages) ? full.stages : Array.isArray(full.pipeline_stages) ? full.pipeline_stages : []).map(record).filter(Boolean) as Record<string, unknown>[];
    }
    const etapas = {} as Record<EtapaPrazo, string>;
    for (const e of ETAPAS_PRAZO) {
      let s = estagios.find(x => norm(String(x.name)) === norm(e.nome));
      if (!s) s = record((await crm.request('POST', `/pipelines/${pid}/pipeline_stages`, {}, { pipeline_stage: { name: e.nome, color: e.cor } })).data) ?? {};
      etapas[e.chave] = String(s.id ?? '');
    }
    const busca = collection(await crm.request('GET', '/contacts/search', { q: legalSettings.semClienteNome, page: 1, per_page: 10 })).map(record);
    let semId = String(busca.find(c => c && norm(String(c.name)) === norm(legalSettings.semClienteNome))?.id ?? '');
    if (!semId) {
      const c = record((await crm.request('POST', '/contacts', {}, { name: legalSettings.semClienteNome })).data);
      semId = String(c?.id ?? record(c?.contact)?.id ?? '');
    }
    st.prazos = { pipeline_id: pid, etapas, sem_cliente_id: semId }; saveState();
    return st.prazos;
  })().finally(() => { preparando = null; });
  return preparando;
}

/** Card do contato no funil de prazos (cria em "Nova" se não houver). */
export async function cardPrazos(crm: CrmClient, contactId: string): Promise<string> {
  const f = await garantirFunilPrazos(crm); const st = getState(); st.cards_prazos ??= {};
  const cache = st.cards_prazos[contactId];
  if (cache) return cache;
  const itens = collection(await crm.request('GET', `/pipelines/${f.pipeline_id}/pipeline_items`)).map(record);
  const achado = itens.find(i => i && (i.contact_id === contactId || record(i.contact)?.id === contactId || (i.type === 'contact' && i.item_id === contactId)));
  let id = String(achado?.id ?? '');
  if (!id) {
    const novo = record((await crm.request('POST', `/pipelines/${f.pipeline_id}/pipeline_items`, {}, { type: 'contact', item_id: contactId, pipeline_stage_id: f.etapas.nova })).data);
    id = String(novo?.id ?? record(novo?.pipeline_item)?.id ?? '');
  }
  if (!id) throw new Error('O CRM não devolveu o card do funil de prazos.');
  st.cards_prazos[contactId] = id; saveState();
  return id;
}

export async function moverCard(crm: CrmClient, itemId: string, etapa: EtapaPrazo, se?: EtapaPrazo[]) {
  const f = await garantirFunilPrazos(crm);
  if (se) {
    const item = record((await crm.request('GET', `/pipelines/${f.pipeline_id}/pipeline_items/${itemId}`)).data) ?? {};
    const atual = String(item.pipeline_stage_id ?? record(item.pipeline_stage)?.id ?? record(item.stage)?.id ?? '');
    const chaveAtual = (Object.entries(f.etapas).find(([, v]) => v === atual)?.[0] ?? '') as EtapaPrazo;
    if (!se.includes(chaveAtual) || atual === f.etapas[etapa]) return;
  }
  await crm.request('PATCH', `/pipelines/${f.pipeline_id}/pipeline_items/${itemId}/move_to_stage`, {}, { new_stage_id: f.etapas[etapa], notes: 'Monitor jurídico' });
}

/** Recalcula os campos do card a partir das publicações do contato. */
export async function atualizarCamposCard(crm: CrmClient, contactId: string) {
  const f = await garantirFunilPrazos(crm); const itemId = await cardPrazos(crm, contactId);
  const doContato = Object.values(getState().eventos).filter(e => (e.contact_id ?? f.sem_cliente_id) === contactId && e.item_prazos_id === itemId)
    .sort((a, b) => b.data.localeCompare(a.data));
  if (!doContato.length) return;
  const ult = doContato[0]!;
  const prazos = doContato.map(e => e.prazo_final).filter((p): p is string => !!p && p >= new Date().toISOString().slice(0, 10)).sort();
  const custom_fields = {
    processos: [...new Set(doContato.map(e => e.processo))].slice(0, 20).join(', '),
    tribunal: ult.tribunal ?? '', ultimo_ato: ult.tipo.slice(0, 120), disponibilizacao: ult.data,
    prazo_final: prazos[0] ?? '', fontes: [...new Set(doContato.flatMap(e => e.fontes))].join(', '),
    pendentes: doContato.filter(e => !e.prazo_final && !e.conferir).length,
  };
  await crm.request('PATCH', `/pipelines/${f.pipeline_id}/pipeline_items/${itemId}/update_custom_fields`, {}, { custom_fields }).catch(() => undefined);
}
