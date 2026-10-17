// Talking to the Padala server.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Errors worth waiting out (weak signal, server restarting) rather than showing to the person. */
export const isTransient = (err) =>
  !(err instanceof ApiError) || err.status === 408 || err.status === 429 || err.status >= 500;

export function createApi(base = '', fetchImpl = (...a) => fetch(...a), extraHeaders = {}) {
  async function request(method, path, body, { raw = false, signal, headers = {} } = {}) {
    const init = { method, credentials: 'same-origin', signal, headers: { 'X-Padala': '1', ...extraHeaders, ...headers } };
    if (body instanceof Uint8Array) {
      init.body = body;
      init.headers['Content-Type'] = 'application/octet-stream';
    } else if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json';
    }
    let res;
    try {
      res = await fetchImpl(base + path, init);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new Error('No connection');
    }
    if (!res.ok) {
      let message = `Request failed (${res.status}).`;
      try { message = (await res.json()).error || message; } catch { /* not JSON */ }
      throw new ApiError(res.status, message);
    }
    if (raw) return new Uint8Array(await res.arrayBuffer());
    return res.json();
  }
  return {
    get: (p, o) => request('GET', p, undefined, o),
    post: (p, b, o) => request('POST', p, b ?? {}, o),
    put: (p, b, o) => request('PUT', p, b, o),
    patch: (p, b, o) => request('PATCH', p, b, o),
    del: (p, o) => request('DELETE', p, undefined, o),
    raw: (p, o) => request('GET', p, undefined, { ...o, raw: true }),
  };
}
