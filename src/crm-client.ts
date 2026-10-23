import { MAX_LIMIT, VERSION, type Config } from './config.js';

export class CrmError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number) { super(message); }
}
export type Query = Record<string, string | number | boolean | undefined>;
export type Envelope = { data: unknown; meta?: unknown };
export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function collection(result: Envelope): unknown[] {
  if (Array.isArray(result.data)) return result.data;
  const obj = record(result.data);
  for (const key of ['payload', 'items', 'agents', 'results']) {
    if (Array.isArray(obj?.[key])) return obj[key] as unknown[];
  }
  throw new CrmError('invalid_response', 'O CRM devolveu uma coleção em formato inesperado.');
}

export class CrmClient {
  constructor(private readonly config: Pick<Config, 'baseUrl' | 'apiToken'>,
    private readonly fetcher: typeof fetch = fetch, private readonly timeoutMs = 15000) {}

  async request(method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, query: Query = {}, body?: unknown): Promise<Envelope> {
    // Paths are assembled exclusively by tools. Never accept absolute URLs or redirects.
    if (!/^\/[a-zA-Z0-9_/-]+$/.test(path) || path.startsWith('//')) {
      throw new CrmError('invalid_path', 'Caminho de API inválido.');
    }
    const url = new URL(`/api/v1${path}`, this.config.baseUrl);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const response = await this.fetcher(url, {
        method, redirect: 'manual', signal,
        headers: { api_access_token: this.config.apiToken, 'User-Agent': `evocrm-mcp/${VERSION}`,
          Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        // Error bodies may contain customer data or credentials; never reflect them.
        await response.body?.cancel();
        throw new CrmError('crm_http_error', `O CRM respondeu com erro HTTP ${response.status}. Verifique permissões e parâmetros.`, response.status);
      }
      if (response.status === 204) return { data: null };
      let value: unknown;
      try { value = await response.json(); }
      catch (error) {
        if (signal.aborted) throw error;
        throw new CrmError(method === 'GET' ? 'invalid_response' : 'operation_outcome_unknown', 'Não foi possível confirmar a resposta JSON do CRM.');
      }
      const obj = record(value);
      if (obj?.success === false) throw new CrmError('crm_operation_failed', 'O CRM recusou a operação. Verifique permissões e parâmetros.');
      if (obj && 'data' in obj) return { data: obj.data, meta: obj.meta };
      // Labels and the AI-agent proxy also expose legacy envelopes.
      return { data: value, meta: obj?.meta };
    } catch (error) {
      if (signal.aborted || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))) {
        throw new CrmError('operation_outcome_unknown', 'O tempo de espera pelo CRM terminou.');
      }
      if (error instanceof CrmError) throw error;
      throw new CrmError(method === 'GET' ? 'crm_unavailable' : 'operation_outcome_unknown', 'Não foi possível confirmar a comunicação com o CRM.');
    }
  }

  async list(path: string, page: number, limit: number, mode: 'local' | 'remote' = 'remote', query: Query = {}) {
    if (!Number.isInteger(page) || page < 1 || page > 10000 || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new CrmError('invalid_pagination', 'Paginação inválida: limite máximo de 100 registros.');
    }
    const result = await this.request('GET', path, mode === 'local' ? query : { ...query, page, per_page: limit });
    const all = collection(result);
    const offset = mode === 'local' ? (page - 1) * limit : 0;
    const items = all.slice(offset, offset + limit);
    return { items, pagination: { page, limit, returned: items.length, mode,
      ...(mode === 'local' ? { total: all.length, next_page: offset + limit < all.length ? page + 1 : null } : {}),
      truncated: mode === 'remote' && all.length > limit }, upstream_meta: result.meta ?? record(result.data)?.meta };
  }
}
