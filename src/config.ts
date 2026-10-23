export const VERSION = '0.1.0';
export const MAX_LIMIT = 100;
export type Scope = 'read' | 'write';
export interface Config {
  baseUrl: string;
  apiToken: string;
  scope: Scope;
  port: number;
  allowedOrigins: string[];
  tokenHashRead?: string;
  tokenHashWrite?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, mode: 'stdio' | 'http' = 'stdio'): Config {
  let base: URL;
  try { base = new URL(env.EVOCRM_BASE_URL ?? ''); }
  catch { throw new Error('Configure EVOCRM_BASE_URL com uma origem HTTP ou HTTPS válida.'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.pathname !== '/' || base.search || base.hash) {
    throw new Error('EVOCRM_BASE_URL deve conter somente a origem, sem credenciais, caminho ou parâmetros.');
  }
  if (!env.EVOCRM_API_TOKEN?.trim() || /[\r\n]/.test(env.EVOCRM_API_TOKEN)) {
    throw new Error('Configure EVOCRM_API_TOKEN com um token válido.');
  }
  const scope = env.MCP_SCOPE || 'read';
  if (mode === 'stdio' && scope !== 'read' && scope !== 'write') throw new Error('MCP_SCOPE deve ser read ou write.');
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT deve estar entre 1 e 65535.');
  const tokenHashRead = env.MCP_TOKEN_SHA256_READ || undefined;
  const tokenHashWrite = env.MCP_TOKEN_SHA256_WRITE || undefined;
  if (mode === 'http') {
    if (!tokenHashRead && !tokenHashWrite) throw new Error('Configure ao menos um hash MCP_TOKEN_SHA256_READ ou MCP_TOKEN_SHA256_WRITE.');
    for (const hash of [tokenHashRead, tokenHashWrite]) {
      if (hash && !/^[a-fA-F0-9]{64}$/.test(hash)) throw new Error('Hashes MCP devem ser SHA-256 hexadecimal de 64 caracteres.');
    }
    if (tokenHashRead && tokenHashWrite && tokenHashRead.toLowerCase() === tokenHashWrite.toLowerCase()) {
      throw new Error('Use tokens distintos para os escopos read e write.');
    }
  }
  const allowedOrigins = (env.MCP_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const origin of allowedOrigins) {
    try {
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new Error();
    } catch { throw new Error('MCP_ALLOWED_ORIGINS deve listar origens exatas separadas por vírgulas.'); }
  }
  return { baseUrl: base.origin, apiToken: env.EVOCRM_API_TOKEN, scope: scope === 'write' ? 'write' : 'read',
    port, allowedOrigins, tokenHashRead, tokenHashWrite };
}
