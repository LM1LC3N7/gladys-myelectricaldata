// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a scripted MyElectricalData API (a
// fake fetch) and a virtual clock: nothing fires by itself, `wait(ms)` moves
// the clock and runs every timer due on the way, letting the promises they
// start settle.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { MedApp } from '../../src/app.js';
import { CALENDARS } from '../../src/constants.js';
import { createMemoryStore } from '../../src/store.js';
import * as M from '../fixtures/med.js';

export const SELECTOR = 'myelectricaldata';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const CONFIG = { token: M.TOKEN, usage_points: M.PDL, id_key: M.ID_KEY };

/** `/daily_consumption/<pdl>/start/<s>/end/<e>` -> { op, pdl, start, end }. */
export function routeOf(path) {
  const m =
    /^\/(contracts|valid_access|daily_consumption|consumption_load_curve|daily_consumption_max_power|daily_production)\/(\d{14})(?:\/start\/([\d-]+)\/end\/([\d-]+))?$/.exec(
      path,
    );
  if (!m) return { op: 'unknown' };
  const op = {
    contracts: 'contracts',
    valid_access: 'access',
    daily_consumption: 'daily',
    consumption_load_curve: 'curve',
    daily_consumption_max_power: 'maxPower',
    daily_production: 'production',
  }[m[1]];
  return { op, pdl: m[2], start: m[3], end: m[4] };
}

/** The default answers, by operation. */
export const defaults = {
  contracts: ({ pdl }) => M.contracts({ pdl }),
  access: () => M.validAccess(),
  daily: ({ pdl, start, end }) => M.daily({ pdl, start, end }),
  production: ({ pdl, start, end }) => M.daily({ pdl, start, end, value: (d, i) => 3000 + i }),
  maxPower: ({ pdl, start, end }) => M.maxPower({ pdl, start, end }),
  curve: ({ pdl, start, end }) => M.curve({ pdl, start, end }),
};

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/**
 * The API: `answers[op](call, now)` -> a body object | a Response | 'timeout'
 * | 'network' | a promise of one of them. `calls` records every request
 * ({ op, pdl, start, end, auth, at }).
 */
export function createMed(answers = {}) {
  const med = { answers: { ...defaults, ...answers }, calls: [], clock: { now: M.NOW } };
  med.count = (op) => med.calls.filter((c) => c.op === op).length;
  med.ops = () => med.calls.map((c) => c.op);
  med.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const call = {
      ...routeOf(path),
      url,
      auth: init.headers.Authorization,
      headers: init.headers,
      signal: init.signal,
      at: med.clock.now,
    };
    med.calls.push(call);
    // Like fetch: an aborted request rejects at once.
    const aborted = new Promise((_, reject) => {
      const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (init.signal?.aborted) fail();
      init.signal?.addEventListener('abort', fail, { once: true });
    });
    const answer = await Promise.race([med.answers[call.op]?.(call, med.clock.now), aborted]);
    if (answer === 'timeout') {
      const err = new Error('timeout');
      err.name = 'TimeoutError';
      throw err;
    }
    if (answer === 'network') throw new TypeError('fetch failed');
    if (answer instanceof Response) return answer;
    if (answer === undefined) return json({ detail: 'Not Found' }, 404);
    return json(answer);
  };
  return med;
}

export function createFakeClock(start) {
  const clock = { now: start };
  let nextId = 1;
  const pending = new Map();
  const timers = {
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, at: clock.now + Math.max(0, Number(ms) || 0) });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
  };
  const settle = async () => {
    for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r));
  };
  async function advance(ms) {
    const target = clock.now + ms;
    await settle();
    for (let i = 0; i < 100_000; i += 1) {
      let next;
      for (const [id, timer] of pending) {
        if (timer.at <= target && (!next || timer.at < next.timer.at)) next = { id, timer };
      }
      if (!next) break;
      pending.delete(next.id);
      clock.now = Math.max(clock.now, next.timer.at);
      next.timer.fn();
      await settle();
    }
    clock.now = Math.max(clock.now, target);
    await settle();
  }
  return { clock, timers, pending, advance, settle };
}

export async function setup({
  devices: known = [],
  store = createMemoryStore(),
  now = M.NOW,
  med = createMed(),
  config = CONFIG,
  wall = { offset: 0 },
  random,
  calendars = { [CALENDARS.OFFPEAK]: [] },
  contracts = [],
} = {}) {
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config,
    devices: known,
    energyCalendars: calendars,
    energyContracts: contracts,
  });
  await gladys.connect();
  const { clock, timers, pending, advance, settle } = createFakeClock(now);
  med.clock = clock;
  // The fake Gladys checks that an interval is elapsed against Date.now: the
  // virtual clock of this test (each test file runs in its own process).
  Date.now = () => clock.now + wall.offset;
  let drift = 0;
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  const app = new MedApp({
    gladys,
    logger: { lines, info: log, warn: log, error: log, debug: log },
    now: () => clock.now + wall.offset,
    // A real monotonic clock moves between two reads of it: 1 µs per call.
    monotonic: () => clock.now + (drift += 0.001),
    timers,
    store,
    fetchImpl: med.fetch,
    requestGap: 0,
    ...(random ? { random } : {}),
  });
  const wait = (ms) => advance(ms);
  const start = async (cfg = config) => {
    gladys.fake.config = cfg;
    const done = app.connected();
    await settle();
    await done;
    await advance(0);
  };
  return { app, gladys, fake: gladys.fake, clock, store, med, start, wait, settle, lines, pending };
}

/** Everything the integration ever wrote out: logs, statuses, /data, Discovery, states. */
export function written(env) {
  return JSON.stringify([
    env.lines,
    env.fake.connectionStatuses,
    env.store.data,
    env.fake.discoveredDevices,
    env.fake.states,
    env.fake.energyConsumption,
    env.fake.energyCalendars,
  ]);
}
