// -----------------------------------------------------------------------------
// The only place that talks to the network: GET a route of the public API of
// MyElectricalData (www.myelectricaldata.fr, Swagger at /docs) with the
// user's token in the Authorization header, a timeout, a bounded body and an
// identifiable User-Agent.
//
// The session sends one request at a time, at least REQUEST_GAP apart, and
// never follows a redirect. The token and the PDL number (in the path) are
// never logged nor put in an error: an error carries a code and an HTTP
// status, never the URL nor the text of the answer (it may echo the PDL).
// -----------------------------------------------------------------------------

import { API_URL, MAX_BODY_BYTES, REQUEST_GAP, REQUEST_TIMEOUT, USER_AGENT } from '../constants.js';

export class MedError extends Error {
  constructor(code, { status, retryAfter } = {}) {
    super(`MyElectricalData: ${code}${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'MedError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** Retry-After (seconds or an HTTP date, against the Date header) -> ms; undefined otherwise. */
export function retryAfterMs(value, dateHeader) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  const ref = Date.parse(dateHeader ?? '');
  // Without a readable Date of the server, a date cannot be measured.
  return Number.isFinite(at) && Number.isFinite(ref) ? Math.max(0, at - ref) : undefined;
}

/** The body as text, never more than `max` bytes (cut and refused beyond). */
async function boundedText(response, max) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel?.().catch(() => {});
    throw new MedError('too_large');
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > max) throw new MedError('too_large');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new MedError('too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/** GET one route; resolves the parsed JSON object, throws a MedError otherwise. */
export async function get({
  fetchImpl,
  url = API_URL,
  path,
  token,
  signal,
  timeout = REQUEST_TIMEOUT,
  maxBytes = MAX_BODY_BYTES,
}) {
  const timer = AbortSignal.timeout(timeout);
  const both = signal ? AbortSignal.any([signal, timer]) : timer;
  let response;
  let text;
  try {
    response = await fetchImpl(`${url}${path}`, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        Authorization: token,
      },
      signal: both,
      redirect: 'error',
    });
    text = await boundedText(response, maxBytes);
  } catch (err) {
    if (err instanceof MedError) throw err;
    if (signal?.aborted) throw new MedError('stopped');
    throw new MedError(timer.aborted ? 'timeout' : 'network');
  }
  const status = response.status;
  if (status === 429) {
    throw new MedError('rate_limited', {
      status,
      retryAfter: retryAfterMs(
        response.headers?.get?.('retry-after'),
        response.headers?.get?.('date'),
      ),
    });
  }
  if (status >= 500) throw new MedError('server', { status });
  if (status === 401 || status === 403) throw new MedError('unauthorized', { status });
  if (status === 404) throw new MedError('not_found', { status });
  if (status === 422) throw new MedError('invalid', { status });
  if (status !== 200) throw new MedError('http', { status });
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new MedError('bad_response', { status });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new MedError('bad_response', { status });
  }
  return body;
}

/** One session of the API for one token: one request at a time, REQUEST_GAP apart. */
export class MedSession {
  constructor({
    token,
    fetchImpl = globalThis.fetch,
    url = API_URL,
    monotonic = () => performance.now(),
    sleep,
    timeout,
    gap = REQUEST_GAP,
    onError,
  }) {
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.url = url;
    this.monotonic = monotonic;
    this.sleep = sleep;
    this.timeout = timeout;
    this.gap = gap;
    this.onError = onError;
    this.lane = Promise.resolve();
    this.lastSent = -Infinity;
    this.abort = new AbortController();
    this.closed = false;
    /** Requests sent (tests). */
    this.sent = 0;
  }

  /** Stops the session: the request in flight is aborted, nothing more is sent. */
  close() {
    this.closed = true;
    this.abort.abort();
  }

  /**
   * One GET, after the previous one and REQUEST_GAP after its end.
   * `beforeSend()` runs just before the request leaves (the daily count);
   * it may throw to send nothing.
   */
  request(path, beforeSend) {
    const run = async () => {
      if (this.closed) throw new MedError('stopped');
      const wait = this.lastSent + this.gap - this.monotonic();
      if (wait > 0 && this.sleep) await this.sleep(wait);
      if (this.closed) throw new MedError('stopped');
      if (beforeSend) await beforeSend();
      if (this.closed) throw new MedError('stopped');
      this.lastSent = this.monotonic();
      this.sent += 1;
      try {
        return await get({
          fetchImpl: this.fetchImpl,
          url: this.url,
          path,
          token: this.token,
          signal: this.abort.signal,
          ...(this.timeout ? { timeout: this.timeout } : {}),
        });
      } catch (err) {
        // Told before the next request of the queue runs (a 429 holds them all).
        this.onError?.(err);
        throw err;
      } finally {
        // The gap counts from the end of a request: a slow answer never shortens it.
        this.lastSent = this.monotonic();
      }
    };
    const job = this.lane.then(run, run);
    this.lane = job.catch(() => {});
    return job;
  }
}

/** The routes used (read-only): the PDL is a path segment, never a query string. */
export const routes = {
  contracts: (pdl) => `/contracts/${pdl}`,
  validAccess: (pdl) => `/valid_access/${pdl}`,
  daily: (pdl, start, end) => `/daily_consumption/${pdl}/start/${start}/end/${end}`,
  curve: (pdl, start, end) => `/consumption_load_curve/${pdl}/start/${start}/end/${end}`,
  maxPower: (pdl, start, end) => `/daily_consumption_max_power/${pdl}/start/${start}/end/${end}`,
  production: (pdl, start, end) => `/daily_production/${pdl}/start/${start}/end/${end}`,
};
