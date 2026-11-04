// Gateway drops underscore headers; CRM accepts the dashed alias. Scoped to the configured CRM origin.
const target = new URL(process.env.EVOCRM_BASE_URL).origin;
const originalFetch = globalThis.fetch;
globalThis.fetch = function (input, init = {}) {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin === target) {
    const headers = new Headers(init.headers);
    if (headers.has('api_access_token')) { headers.set('X-Api-Access-Token', headers.get('api_access_token')); headers.delete('api_access_token'); init = { ...init, headers }; }
  }
  return originalFetch(input, init);
};
