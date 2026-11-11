// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, setTimeout) and a real
// local HTTP server playing the MyElectricalData API: the first read at once,
// the read of a new device a minute later, the retry while yesterday is
// missing really 3 hours later, the requests really 3 s apart, a bounded
// number of timers, and nothing sent after stop(). The time is sped up 20000
// times (3 hours last 0.54 s) but it is the real clock: it moves between any
// two reads of it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { MedApp } from '../src/app.js';
import { CALENDARS, REQUEST_GAP, RETRY_GAP, SOON_GAP } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import { registerHandlers } from '../src/handlers.js';
import { defaults, routeOf } from './helpers/app.js';
import * as M from './fixtures/med.js';

const SPEED = 20000;
const HOUR = 3_600_000;
// Wide margins: the suite runs in parallel on a loaded runner.

test('real clock: reads at once, a minute after a new device, 3 hours later; timers bounded', async (t) => {
  const requests = [];
  const server = createServer((req, res) => {
    const call = routeOf(new URL(req.url, 'http://x').pathname);
    requests.push({ op: call.op, at: performance.now() * SPEED });
    // Yesterday never comes: the retry is due 3 hours later.
    const answer =
      call.op === 'daily'
        ? M.daily({ ...call, value: (d, i) => (d >= '2026-11-10' ? undefined : 1000 + i) })
        : defaults[call.op](call);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  let timersSet = 0;
  const timers = {
    setTimeout(fn, ms) {
      timersSet += 1;
      return setTimeout(fn, Math.max(0, ms) / SPEED);
    },
    clearTimeout: (id) => clearTimeout(id),
  };
  const gladys = createFakeGladys({
    selector: 'myelectricaldata',
    config: { token: M.TOKEN, usage_points: M.PDL, id_key: M.ID_KEY, max_power: false },
    energyCalendars: { [CALENDARS.OFFPEAK]: [] },
  });
  await gladys.connect();
  const quiet = () => {};
  const t0 = performance.now();
  const app = new MedApp({
    gladys,
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    now: () => M.NOW + (performance.now() - t0) * SPEED,
    monotonic: () => performance.now() * SPEED,
    timers,
    store: createMemoryStore(),
    apiUrl: `http://127.0.0.1:${server.address().port}`,
  });
  registerHandlers(gladys, app, app.log);
  // Stopped even when an assertion fails: no timer left behind.
  t.after(() => app.stop());
  const started = performance.now() * SPEED;
  await app.connected();
  await gladys.fake.deviceCreated(structuredClone(gladys.fake.discoveredDevices[0]));
  const deadline = performance.now() + 20_000;
  while (requests.filter((r) => r.op === 'daily').length < 2 && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await app.stop();
  const sent = requests.length;
  await new Promise((resolve) => setTimeout(resolve, RETRY_GAP / SPEED));
  assert.equal(requests.length, sent, 'nothing sent after stop()');
  const at = (r) => Math.round((r.at - started) / 60_000);
  assert.deepEqual(
    requests.map((r) => r.op),
    ['contracts', 'daily', 'daily'],
    `${requests.map((r) => `${r.op}@${at(r)}min`)}`,
  );
  const [contract, first, retry] = requests;
  assert.ok(contract.at - started < HOUR, 'the first read at once');
  const soon = first.at - contract.at;
  assert.ok(soon >= 0.9 * SOON_GAP && soon >= REQUEST_GAP, `a minute later: ${soon / 1000} s`);
  assert.ok(soon < 2 * HOUR, `soon: ${soon / 60_000} min`);
  const gap = retry.at - first.at;
  assert.ok(gap >= 0.9 * RETRY_GAP, `never sooner than 3 hours: ${gap / 60_000} min`);
  assert.ok(gap < 2 * RETRY_GAP, `on time: ${gap / 60_000} min`);
  assert.ok(timersSet <= 80, `${timersSet} timers`);
});
