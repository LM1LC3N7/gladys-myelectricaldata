// -----------------------------------------------------------------------------
// The HTTP client: headers, bounded body and time, errors that carry no
// secret, one request at a time with a gap, nothing after close().
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { MedError, MedSession, get, retryAfterMs, routes } from '../src/med/client.js';
import { USER_AGENT } from '../src/constants.js';
import * as M from './fixtures/med.js';

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

test('a GET: the token in Authorization, JSON, the module User-Agent, no redirect', async () => {
  let seen;
  const body = await get({
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return json({ ok: 1 });
    },
    path: routes.contracts(M.PDL),
    token: M.TOKEN,
  });
  assert.deepEqual(body, { ok: 1 });
  assert.equal(seen.url, `https://www.myelectricaldata.fr/contracts/${M.PDL}`);
  assert.equal(seen.init.method, 'GET');
  assert.equal(seen.init.headers.Authorization, M.TOKEN);
  assert.equal(seen.init.headers.Accept, 'application/json');
  assert.equal(seen.init.headers['User-Agent'], USER_AGENT);
  assert.match(
    USER_AGENT,
    /^gladys-myelectricaldata\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/LM1LC3N7\/gladys-myelectricaldata\)$/,
  );
  assert.equal(seen.init.redirect, 'error');
  assert.equal(
    routes.daily(M.PDL, '2026-11-01', '2026-11-11'),
    `/daily_consumption/${M.PDL}/start/2026-11-01/end/2026-11-11`,
  );
});

test('errors: codes and statuses only, never the URL, the token nor the answer', async () => {
  const cases = [
    [json({ detail: `bad ${M.PDL}` }, 401), 'unauthorized'],
    [json({ detail: 'x' }, 403), 'unauthorized'],
    [json({ detail: 'x' }, 404), 'not_found'],
    [json({ detail: 'x' }, 422), 'invalid'],
    [json({ detail: 'x' }, 409), 'http'],
    [json({ detail: 'x' }, 500), 'server'],
    [json({ detail: 'x' }, 503), 'server'],
    [json({ detail: 'x' }, 429, { 'retry-after': '120' }), 'rate_limited'],
    [new Response('<html>oops</html>', { status: 200 }), 'bad_response'],
    [json([1, 2]), 'bad_response'],
    ['network', 'network'],
  ];
  for (const [answer, code] of cases) {
    const err = await get({
      fetchImpl: async () => {
        if (answer === 'network') throw new TypeError('fetch failed');
        return answer;
      },
      path: routes.contracts(M.PDL),
      token: M.TOKEN,
    }).catch((e) => e);
    assert.ok(err instanceof MedError, code);
    assert.equal(err.code, code);
    const text = `${err.message} ${JSON.stringify(err)}`;
    assert.ok(!text.includes(M.PDL) && !text.includes(M.TOKEN) && !text.includes('oops'), text);
    if (code === 'rate_limited') assert.equal(err.retryAfter, 120_000);
  }
  assert.equal(
    retryAfterMs('Wed, 11 Nov 2026 10:00:00 GMT', 'Wed, 11 Nov 2026 09:58:00 GMT'),
    120_000,
  );
  assert.equal(retryAfterMs('Wed, 11 Nov 2026 10:00:00 GMT', undefined), undefined);
  assert.equal(retryAfterMs('soon'), undefined);
});

test('a body larger than the bound is cut before it is read whole', async (t) => {
  let sent = 0;
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    // Endless: only the bound can stop the read.
    const chunk = Buffer.alloc(64 * 1024, 32);
    const timer = setInterval(() => {
      sent += chunk.length;
      res.write(chunk);
    }, 1);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  server.unref();
  const err = await get({
    fetchImpl: fetch,
    url: `http://127.0.0.1:${server.address().port}`,
    path: '/contracts/x',
    token: M.TOKEN,
    maxBytes: 256 * 1024,
    timeout: 20_000,
  }).catch((e) => e);
  assert.equal(err.code, 'too_large');
  assert.ok(sent < 8 * 1024 * 1024, `${sent} bytes sent`);
  // Declared too large: refused before reading.
  const declared = await get({
    fetchImpl: async () =>
      new Response('{}', { status: 200, headers: { 'content-length': String(10 * 1024 * 1024) } }),
    path: '/x',
    token: M.TOKEN,
  }).catch((e) => e);
  assert.equal(declared.code, 'too_large');
});

test('a silent server: the request ends at its timeout', async (t) => {
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const started = performance.now();
  const err = await get({
    fetchImpl: fetch,
    url: `http://127.0.0.1:${server.address().port}`,
    path: '/x',
    token: M.TOKEN,
    timeout: 300,
  }).catch((e) => e);
  assert.equal(err.code, 'timeout');
  assert.ok(performance.now() - started < 5000);
});

test('the session: one request at a time, the gap from the END of the previous one, nothing after close()', async () => {
  let now = 0;
  const events = [];
  const sleeps = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const session = new MedSession({
    token: M.TOKEN,
    monotonic: () => now,
    gap: 3000,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    fetchImpl: async (url) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      events.push(['start', now]);
      // A slow answer: 10 s.
      await new Promise((r) => setImmediate(r));
      now += 10_000;
      inFlight -= 1;
      events.push(['end', now, url]);
      return json({ ok: 1 });
    },
  });
  let counted = 0;
  await Promise.all([
    session.request('/a', () => (counted += 1)),
    session.request('/b', () => (counted += 1)),
  ]);
  assert.equal(maxInFlight, 1);
  assert.equal(counted, 2, 'beforeSend runs once per request');
  assert.deepEqual(sleeps, [3000], 'the gap counts from the end of the slow answer');
  // beforeSend refusing: nothing sent.
  const refused = await session
    .request('/c', () => {
      throw new MedError('daily_ceiling');
    })
    .catch((e) => e);
  assert.equal(refused.code, 'daily_ceiling');
  assert.equal(events.filter((e) => e[0] === 'start').length, 2);
  session.close();
  const closed = await session.request('/d').catch((e) => e);
  assert.equal(closed.code, 'stopped');
  assert.equal(events.filter((e) => e[0] === 'start').length, 2);
});
