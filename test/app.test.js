// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a scripted MyElectricalData API and
// a virtual clock: pace, quotas, refusal, pauses, /data, Discovery, the
// consumption published once, the off-peak calendar, the test button, secrets.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHandlers } from '../src/handlers.js';
import { MAX_REQUESTS_PER_DAY } from '../src/constants.js';
import { keyOf } from '../src/med/model.js';
import { createMemoryStore } from '../src/store.js';
import { localDate } from '../src/time.js';
import {
  CONFIG,
  DAY,
  HOUR,
  MINUTE,
  createMed,
  defaults,
  json,
  setup,
  written,
} from './helpers/app.js';
import * as M from './fixtures/med.js';

const statusText = (env) => env.fake.connectionStatus?.message?.en ?? '';
const KEY = keyOf(M.ID_KEY, 'pdl', M.PDL);
const KEY2 = keyOf(M.ID_KEY, 'pdl', M.PDL2);
const F = (feature, key = KEY) => `ext:myelectricaldata:pdl:${key}:${feature}`;

async function started(options = {}) {
  const env = await setup(options);
  registerHandlers(env.gladys, env.app, env.app.log);
  await env.start(options.config);
  return env;
}

/** The user creates every discovered device. */
async function createAll(env) {
  for (const d of structuredClone(env.fake.discoveredDevices)) await env.fake.deviceCreated(d);
}

/**
 * Every day (local date) ever published to the energy of the day (dated
 * states), in order; for the 30-minute consumption, every slot start.
 */
const dailyDates = (env, feature = F('daily_consumption')) =>
  feature.endsWith(':consumption')
    ? env.fake.publishedEnergyConsumption
        .filter((b) => b.device_feature_external_id === feature)
        .flatMap((b) => b.intervals.map((i) => i.starts_at))
    : env.fake.states
        .filter((s) => s.device_feature_external_id === feature)
        .map((s) => localDate(Date.parse(s.created_at)));

test('start: the contract read at once; Discovery, calendar, status; nothing secret written', async (t) => {
  const env = await started();
  t.after(() => env.app.stop());
  assert.deepEqual(env.med.ops(), ['contracts']);
  assert.equal(env.med.calls[0].auth, M.TOKEN);
  const [device] = env.fake.discoveredDevices;
  assert.equal(device.name, 'Linky meter …1234');
  assert.equal(device.external_id, `ext:myelectricaldata:pdl:${KEY}`);
  assert.deepEqual(
    device.features.map((f) => f.external_id.split(':').at(-1)),
    ['daily_consumption', 'max_power'],
  );
  const params = Object.fromEntries(device.params.map((p) => [p.name, p.value]));
  assert.deepEqual(params, {
    pdl_suffix: '1234',
    subscribed_power_kva: '9',
    offpeak_hours: '22:00-06:00',
  });
  const [batch] = env.fake.publishedEnergyCalendars;
  assert.equal(batch.calendar_key, 'linky-offpeak');
  assert.equal(batch.entries.length, 7 * 48);
  assert.equal(batch.entries[0].starts_at, '2026-11-10T23:00:00.000Z');
  assert.equal(batch.entries.filter((e) => e.value === 'offpeak').length, 7 * 16);
  assert.equal(env.fake.connectionStatus.connected, true);
  assert.match(
    statusText(env),
    /^Connected: 1 meter\(s\).*Off-peak hours of …1234: 22:00-06:00, calendar published up to 17\/11\/2026\.$/,
  );
  const out = written(env);
  for (const secret of [M.PDL, M.TOKEN, '-9999999']) {
    assert.ok(!out.includes(secret), `${secret} written out`);
  }
});

test('a created device: read a minute later, 31 days back; every day published once', async (t) => {
  const env = await started();
  t.after(() => env.app.stop());
  await createAll(env);
  await env.wait(30 * 1000);
  assert.deepEqual(env.med.ops(), ['contracts'], 'never sooner than a minute');
  await env.wait(MINUTE);
  assert.deepEqual(env.med.ops(), ['contracts', 'daily', 'maxPower']);
  const daily = env.med.calls[1];
  assert.deepEqual([daily.start, daily.end], ['2026-10-11', '2026-11-11']);
  assert.deepEqual([env.med.calls[2].start, env.med.calls[2].end], ['2026-10-11', '2026-11-11']);
  const dates = dailyDates(env);
  assert.equal(dates.length, 31);
  assert.equal(dates.at(-1), '2026-11-10');
  const days = env.fake.states.filter(
    (s) => s.device_feature_external_id === F('daily_consumption'),
  );
  assert.equal(days[0].state, 10, 'kWh');
  assert.equal(days[0].created_at, '2026-10-10T22:00:00.000Z', 'the local midnight');
  // The days never feed the costs: no dated consumption without the load curve.
  assert.equal(env.fake.publishedEnergyConsumption.length, 0);
  assert.match(statusText(env), /No cost is computed/);
  const peaks = env.fake.states.filter((s) => s.device_feature_external_id === F('max_power'));
  assert.equal(peaks.length, 31);
  assert.equal(peaks.at(-1).created_at, '2026-11-10T17:42:13.000Z');
  assert.deepEqual(env.store.data.published[KEY], { daily: '2026-11-10', maxPower: '2026-11-10' });
  // Up to date: nothing more today.
  await env.wait(10 * HOUR);
  assert.equal(env.med.calls.length, 3);
  // The next morning: the contract and the one new day of each.
  await env.wait(DAY);
  assert.deepEqual(env.med.ops(), [
    'contracts',
    'daily',
    'maxPower',
    'contracts',
    'daily',
    'maxPower',
  ]);
  const next = env.med.calls[4];
  assert.deepEqual([next.start, next.end], ['2026-11-11', '2026-11-12']);
  const all = dailyDates(env);
  assert.equal(all.length, 32);
  assert.equal(new Set(all).size, all.length, 'no day published twice');
  const at = new Date(env.med.calls[3].at);
  const minutes = at.getUTCHours() * 60 + at.getUTCMinutes() + 60;
  assert.ok(minutes >= 9 * 60 && minutes < 11 * 60, 'between 09:00 and 11:00 in Paris');
  assert.equal(localDate(env.med.calls[3].at), '2026-11-12');
  assert.equal(env.med.calls[3].at - env.app.roundAt('2026-11-12') < MINUTE, true);
});

test('yesterday missing: again 3 hours later, at most 3 reads a day, then the next morning', async (t) => {
  const med = createMed({
    daily: ({ pdl, start, end }) =>
      M.daily({ pdl, start, end, value: (d, i) => (d >= '2026-11-10' ? undefined : 1000 + i) }),
  });
  const env = await started({ med, config: { ...CONFIG, max_power: false } });
  t.after(() => env.app.stop());
  await createAll(env);
  await env.wait(2 * MINUTE);
  assert.equal(med.count('daily'), 1);
  assert.equal(env.store.data.published[KEY].daily, '2026-11-09');
  await env.wait(2 * HOUR + 50 * MINUTE);
  assert.equal(med.count('daily'), 1, 'not before 3 hours');
  await env.wait(15 * MINUTE);
  assert.equal(med.count('daily'), 2);
  assert.deepEqual([med.calls.at(-1).start, med.calls.at(-1).end], ['2026-11-10', '2026-11-11']);
  await env.wait(10 * HOUR);
  // 3 reads today (the contract, the first day read, one retry): no more.
  assert.equal(med.count('daily'), 2);
  assert.equal(env.store.data.rounds, 3);
  await env.wait(DAY);
  assert.ok(med.count('daily') >= 3 && med.count('daily') <= 5);
  assert.equal(new Set(dailyDates(env)).size, dailyDates(env).length);
});

test('daily ceiling: never more than the limit per meter and per day, across a restart', async (t) => {
  const store = createMemoryStore();
  const med = createMed({ daily: () => json({ detail: 'no' }, 404) });
  const env = await started({ med, store });
  await createAll(env);
  // Devices deleted and created again: each one asks for a read soon.
  for (let i = 0; i < 12; i += 1) {
    const [device] = structuredClone(env.fake.discoveredDevices);
    await env.fake.deviceDeleted(device);
    await env.fake.deviceCreated(device);
    await env.wait(2 * MINUTE);
  }
  assert.ok(med.calls.length <= MAX_REQUESTS_PER_DAY, `${med.calls.length} requests`);
  await env.app.stop();
  const later = await started({
    med,
    store,
    now: env.clock.now + 10 * MINUTE,
    devices: env.fake.devices,
  });
  t.after(() => later.app.stop());
  await later.fake.deviceCreated(structuredClone(env.fake.discoveredDevices[0]));
  await later.wait(6 * HOUR);
  const today = med.calls.filter((c) => localDate(c.at) === '2026-11-11');
  assert.ok(today.length <= MAX_REQUESTS_PER_DAY, `${today.length} requests today`);
  assert.equal(store.data.requests.counts[KEY], today.length, 'counted before each request');
});

test('a restart never reads sooner than an hour, nor what was read today', async (t) => {
  const store = createMemoryStore();
  const env = await started({ store });
  await createAll(env);
  await env.wait(2 * MINUTE);
  const sent = env.med.calls.length;
  await env.app.stop();
  const later = await started({
    store,
    med: env.med,
    now: env.clock.now + 10 * MINUTE,
    devices: env.fake.devices,
  });
  t.after(() => later.app.stop());
  await later.wait(12 * HOUR);
  assert.deepEqual(env.med.ops(), ['contracts', 'daily', 'maxPower']);
  assert.equal(env.med.calls.length, sent);
  assert.match(statusText(later), /^Starting: 1 meter\(s\), first read on 12\/11 (09|10):/);
  await later.app.stop();
});

test('a restart while yesterday is missing: the retry 3 hours after the read of /data', async (t) => {
  const store = createMemoryStore();
  const med = createMed({
    daily: ({ pdl, start, end }) =>
      M.daily({ pdl, start, end, value: (d, i) => (d >= '2026-11-10' ? undefined : 1000 + i) }),
  });
  const env = await started({ store, med, config: { ...CONFIG, max_power: false } });
  await createAll(env);
  await env.wait(2 * MINUTE);
  assert.equal(med.count('daily'), 1);
  await env.app.stop();
  const later = await started({
    store,
    med,
    now: env.clock.now + 10 * MINUTE,
    devices: env.fake.devices,
    config: { ...CONFIG, max_power: false },
  });
  t.after(() => later.app.stop());
  await later.wait(2 * HOUR + 40 * MINUTE);
  assert.equal(med.count('daily'), 1, 'not sooner than 3 hours after the read kept in /data');
  await later.wait(20 * MINUTE);
  assert.equal(med.count('daily'), 2);
});

test('429: every request paused (Retry-After), persisted across a restart', async (t) => {
  const store = createMemoryStore();
  let busy = true;
  const med = createMed({
    contracts: ({ pdl }) =>
      busy ? json({ detail: 'quota' }, 429, { 'retry-after': '7200' }) : M.contracts({ pdl }),
  });
  const env = await started({ med, store });
  assert.equal(med.count('contracts'), 1);
  assert.match(statusText(env), /asked to slow down \(quota\): next request on 11\/11 12:30/);
  assert.equal(env.fake.connectionStatus.connected, false);
  assert.equal(store.data.pause.code, 'rate_limited');
  await env.app.stop();
  busy = false;
  const later = await started({ med, store, now: env.clock.now + 30 * MINUTE });
  t.after(() => later.app.stop());
  // Test button paused too.
  const answer = await later.fake.action('test_connection');
  assert.match(answer.data.message.en, /^Not sent/);
  await later.wait(80 * MINUTE);
  assert.equal(med.calls.length, 1);
  await later.wait(20 * MINUTE);
  assert.equal(med.count('contracts'), 2);
  assert.equal(store.data.pause, null);
  assert.match(statusText(later), /^Connected/);
});

test('5xx: 15 minutes, doubled; a network error is not a pause', async (t) => {
  let answer = () => json({}, 503);
  const med = createMed({ contracts: (call) => answer(call) });
  const env = await started({ med });
  t.after(() => env.app.stop());
  assert.match(statusText(env), /having trouble \(HTTP 503\)/);
  await env.wait(15 * MINUTE + 1000);
  assert.equal(med.count('contracts'), 2);
  assert.equal(env.app.pause.count, 2);
  await env.wait(29 * MINUTE);
  assert.equal(med.count('contracts'), 2, 'doubled: 30 minutes');
  answer = () => 'network';
  await env.wait(2 * MINUTE);
  assert.equal(med.count('contracts'), 3);
  // A network error is no pause: the ordinary retry, 3 hours later.
  assert.equal(env.app.pause.count, 2);
  await env.wait(2 * HOUR);
  assert.equal(med.count('contracts'), 3);
  await env.wait(HOUR + MINUTE);
  assert.equal(med.count('contracts'), 4);
});

test('refused: a 401 on the contract of every meter; nothing more until Test or a new token', async (t) => {
  const store = createMemoryStore();
  let refuse = true;
  const med = createMed({
    contracts: ({ pdl }) => (refuse ? json({ detail: 'token' }, 401) : M.contracts({ pdl })),
    access: () => (refuse ? json({ detail: 'token' }, 403) : M.validAccess()),
  });
  const env = await started({
    med,
    store,
    config: { ...CONFIG, usage_points: `${M.PDL},${M.PDL2}` },
  });
  assert.deepEqual(med.ops(), ['contracts', 'contracts']);
  assert.match(statusText(env), /refused the token for every meter/);
  assert.ok(store.data.refused && !JSON.stringify(store.data).includes(M.TOKEN));
  await env.wait(3 * DAY);
  assert.equal(med.calls.length, 2, 'never tried again by itself');
  assert.equal(env.app.dueMono, undefined, 'no read planned');
  // A restart keeps the refusal.
  await env.app.stop();
  const later = await started({
    med,
    store,
    now: env.clock.now,
    config: { ...CONFIG, usage_points: `${M.PDL},${M.PDL2}` },
  });
  t.after(() => later.app.stop());
  await later.wait(DAY);
  assert.equal(med.calls.length, 2);
  // Test refused: still refused; Test accepted: lifted, the reads resume.
  let reply = await later.fake.action('test_connection');
  assert.match(reply.data.message.en, /not checked \(unauthorized\)/);
  assert.match(statusText(later), /refused/);
  refuse = false;
  await later.wait(MINUTE);
  reply = await later.fake.action('test_connection');
  assert.match(
    reply.data.message.en,
    /Meter …1234: access valid, consent until 30\/06\/2029, 3\/50 calls/,
  );
  assert.equal(store.data.refused, null);
  await later.wait(4 * HOUR);
  assert.equal(med.count('contracts'), 4);
  assert.match(statusText(later), /^Connected/);
});

test('a new token is tried at once, even after a refusal', async (t) => {
  const med = createMed({
    contracts: ({ pdl, auth }) => (auth === M.TOKEN ? json({}, 403) : M.contracts({ pdl })),
  });
  const env = await started({ med });
  t.after(() => env.app.stop());
  assert.match(statusText(env), /refused/);
  // Even when the 8 bits kept of the refused token match the new one.
  const { tagOf } = await import('../src/app.js');
  env.app.refused.tag = tagOf(env.app.refused.salt, 'another-token-123456');
  await env.fake.configUpdated({ ...CONFIG, token: 'another-token-123456' });
  await env.wait(2 * MINUTE);
  assert.equal(med.count('contracts'), 2);
  assert.match(statusText(env), /^Connected/);
});

test('a 401 on one meter, the other unreachable: no refusal', async (t) => {
  const med = createMed({
    contracts: ({ pdl }) => (pdl === M.PDL ? json({}, 401) : 'network'),
  });
  const env = await started({ med, config: { ...CONFIG, usage_points: `${M.PDL},${M.PDL2}` } });
  t.after(() => env.app.stop());
  assert.equal(med.count('contracts'), 2);
  assert.equal(env.app.refused, undefined);
  assert.doesNotMatch(statusText(env), /refused/);
});

test('a 401 on a data route of the only meter is never a refusal', async (t) => {
  const med = createMed({ daily: () => json({}, 401) });
  const env = await started({ med, config: { ...CONFIG, max_power: false } });
  t.after(() => env.app.stop());
  await createAll(env);
  await env.wait(2 * MINUTE);
  assert.deepEqual(med.ops(), ['contracts', 'daily']);
  assert.equal(env.app.refused, undefined);
  assert.match(statusText(env), /daily_unauthorized/);
});

test('the daily ceiling holds the test button too', async (t) => {
  const env = await started();
  t.after(() => env.app.stop());
  for (let i = 0; i < 14; i += 1) {
    await env.fake.action('test_connection');
    await env.wait(MINUTE + 1000);
  }
  const today = env.med.calls.filter((c) => localDate(c.at) === '2026-11-11');
  assert.equal(today.length, MAX_REQUESTS_PER_DAY);
  const reply = await env.fake.action('test_connection');
  assert.match(reply.data.message.en, /not checked \(daily_ceiling\)/);
});

test('a 401/403 on a data route or on one meter only is never a refusal', async (t) => {
  const med = createMed({
    contracts: ({ pdl }) => (pdl === M.PDL2 ? json({}, 403) : M.contracts({ pdl })),
    daily: () => json({}, 401),
  });
  const env = await started({ med, config: { ...CONFIG, usage_points: `${M.PDL},${M.PDL2}` } });
  t.after(() => env.app.stop());
  await createAll(env);
  await env.wait(2 * MINUTE);
  assert.equal(env.app.refused, undefined);
  assert.match(statusText(env), /^Connected: 2 meter\(s\)/);
  assert.match(statusText(env), /Meter …5678: contract_unauthorized/);
  assert.match(statusText(env), /Meter …1234: daily_unauthorized/);
  // The calendar follows the first meter.
  assert.equal(env.store.data.calendar.key, KEY);
  assert.equal(env.fake.discoveredDevices.length, 2);
  assert.ok(env.fake.discoveredDevices[1].external_id.endsWith(KEY2));
});

test('calendar: no off-peak hours, unreadable, or owned by another integration: nothing guessed', async (t) => {
  for (const [offpeak, expected] of [
    [null, /has no off-peak hours/],
    ['HC (bizarre)', /could not be read/],
  ]) {
    const med = createMed({ contracts: ({ pdl }) => M.contracts({ pdl, offpeak }) });
    const env = await started({ med });
    t.after(() => env.app.stop());
    assert.equal(env.fake.publishedEnergyCalendars.length, 0);
    assert.match(statusText(env), expected);
    const [device] = env.fake.discoveredDevices;
    assert.equal(device.params.find((p) => p.name === 'offpeak_hours').value, '');
  }
  // The key declared by another integration first: 403 from Gladys.
  const env = await started({ calendars: {} });
  t.after(() => env.app.stop());
  assert.match(statusText(env), /Another integration already feeds the linky-offpeak calendar/);
  assert.equal(env.store.data.calendar, null);
});

test('calendar: the days since the last read are filled only when the hours are the same', async (t) => {
  const seeded = (ranges) =>
    createMemoryStore({
      keyTag: keyOf(M.ID_KEY, 'tag', 'myelectricaldata').slice(0, 8),
      calendar: { key: KEY, until: '2026-11-08', ranges },
    });
  const same = await started({ store: seeded([[1320, 360]]) });
  t.after(() => same.app.stop());
  const [a] = same.fake.publishedEnergyCalendars;
  assert.equal(a.entries.length, 9 * 48);
  assert.equal(a.entries[0].starts_at, '2026-11-08T23:00:00.000Z');
  assert.equal(same.store.data.calendar.until, '2026-11-17');
  // Other hours read today (the Enedis changes): from today only.
  const other = await started({ store: seeded([[120, 420]]) });
  t.after(() => other.app.stop());
  const [b] = other.fake.publishedEnergyCalendars;
  assert.equal(b.entries.length, 7 * 48);
  assert.deepEqual(other.store.data.calendar.ranges, [[1320, 360]]);
});

test('options: the load curve (7 days of half hours) and the production (dated states)', async (t) => {
  const env = await started({ config: { ...CONFIG, load_curve: true, production: true } });
  t.after(() => env.app.stop());
  const [device] = env.fake.discoveredDevices;
  assert.deepEqual(
    device.features.map((f) => f.external_id.split(':').at(-1)),
    ['daily_consumption', 'consumption', 'max_power', 'daily_production'],
    'the days shown, the half hours priced',
  );
  await createAll(env);
  await env.wait(2 * MINUTE);
  assert.deepEqual(env.med.ops(), ['contracts', 'daily', 'curve', 'maxPower', 'production']);
  const curve = env.med.calls[2];
  assert.deepEqual([curve.start, curve.end], ['2026-11-04', '2026-11-11']);
  const halves = env.fake.publishedEnergyConsumption
    .filter((b) => b.device_feature_external_id === F('consumption'))
    .flatMap((b) => b.intervals);
  assert.equal(halves.length, 7 * 48);
  assert.ok(halves.every((h) => Date.parse(h.starts_at) % 1_800_000 === 0));
  assert.equal(halves[0].starts_at, '2026-11-03T23:00:00.000Z');
  const production = env.fake.states.filter(
    (s) => s.device_feature_external_id === F('daily_production'),
  );
  assert.equal(production.length, 31);
  assert.equal(production.at(-1).created_at, '2026-11-09T23:00:00.000Z', 'the local midnight');
  assert.equal(production[0].state, 3);
  // Only the half hours go to the costs.
  assert.deepEqual(
    [...new Set(env.fake.publishedEnergyConsumption.map((b) => b.device_feature_external_id))],
    [F('consumption')],
  );
  assert.doesNotMatch(statusText(env), /No cost/);
});

test('states throttled: never more than 250 a minute', async (t) => {
  const env = await started({
    config: { ...CONFIG, production: true, usage_points: `${M.PDL},${M.PDL2}` },
  });
  t.after(() => env.app.stop());
  // A long absence: 100 days of peaks and production for two meters, and a
  // small batch room left: never more than 250 a minute.
  env.app.data.published = {
    [KEY]: { daily: '2026-11-10', maxPower: '2026-08-02', production: '2026-08-02' },
    [KEY2]: { daily: '2026-11-10', maxPower: '2026-08-02', production: '2026-08-02' },
  };
  // 240 states published just before: room for 10 only in this minute.
  // (stamped at the read, a minute after the device is created)
  env.app.statesSent.push({ at: env.clock.now + MINUTE + 500, count: 240 });
  const sent = [];
  const real = env.gladys.publishStates.bind(env.gladys);
  env.gladys.publishStates = (states) => {
    sent.push({ at: env.clock.now, count: states.length });
    return real(states);
  };
  await createAll(env);
  await env.wait(10 * MINUTE);
  const total = sent.reduce((n, s) => n + s.count, 0);
  // The catch-up is bounded to 31 days per kind (older ones left out), by batches of 100.
  assert.equal(total, 4 * 31);
  assert.ok(sent.every((s) => s.count <= 100));
  assert.equal(sent[0].count, 10, 'only the room left in this minute');
  // No window of a minute (on the virtual clock) holds more than 250.
  for (const s of sent) {
    const inWindow = sent.filter((x) => x.at >= s.at && x.at < s.at + MINUTE);
    assert.ok(inWindow.reduce((n, x) => n + x.count, 0) <= 250);
  }
  assert.ok(sent.at(-1).at - sent[0].at >= MINUTE);
});

test('Gladys refuses a publication: the days are asked again later, never lost', async (t) => {
  const env = await started({ config: { ...CONFIG, max_power: false, load_curve: true } });
  t.after(() => env.app.stop());
  await createAll(env);
  const real = env.gladys.publishEnergyConsumption.bind(env.gladys);
  let fail = true;
  env.gladys.publishEnergyConsumption = (...args) => {
    if (fail) return Promise.reject(Object.assign(new Error('nope'), { status: 500 }));
    return real(...args);
  };
  await env.wait(2 * MINUTE);
  assert.equal(env.store.data.published[KEY].curve, undefined);
  assert.match(statusText(env), /curve_gladys/);
  fail = false;
  await env.wait(3 * HOUR);
  assert.equal(env.med.count('curve'), 2);
  assert.equal(env.med.calls.at(-1).start, '2026-11-04');
  assert.equal(dailyDates(env, F('consumption')).length, 7 * 48);
});

test('getConfig failing in connected: retried, spaced, the status says so, then the reads', async (t) => {
  const env = await setup();
  registerHandlers(env.gladys, env.app, env.app.log);
  t.after(() => env.app.stop());
  const real = env.gladys.getConfig.bind(env.gladys);
  let failures = 2;
  env.gladys.getConfig = () => (failures-- > 0 ? Promise.reject(new Error('down')) : real());
  await env.app.connected();
  assert.match(statusText(env), /configuration could not be read/);
  assert.equal(env.med.calls.length, 0);
  await env.wait(5 * 1000);
  assert.equal(env.med.calls.length, 0);
  await env.wait(10 * 1000);
  assert.deepEqual(env.med.ops(), ['contracts']);
  assert.match(statusText(env), /^Connected/);
});

test('/data unreadable: the whole gap waited, the same ids, read again until readable', async (t) => {
  const store = createMemoryStore();
  store.unreadable = true;
  const env = await started({ store });
  t.after(() => env.app.stop());
  assert.equal(env.med.calls.length, 0);
  assert.ok(
    env.fake.discoveredDevices[0].external_id.endsWith(KEY),
    'the id comes from the id key',
  );
  assert.match(statusText(env), /\/data cannot be read/);
  await env.wait(50 * MINUTE);
  assert.equal(env.med.calls.length, 0, 'the last read is unknown: a whole gap');
  // Every 10 s, one at a time.
  assert.ok(store.loads >= 290 && store.loads <= 302, `${store.loads} reads of /data`);
  store.unreadable = false;
  await env.wait(15 * MINUTE);
  assert.deepEqual(env.med.ops(), ['contracts']);
});

test('the id key: made once, stored in Gladys, never in /data', async (t) => {
  const env = await started({
    config: { token: M.TOKEN, usage_points: M.PDL },
    random: (n) => Buffer.alloc(n, 0xbb),
  });
  t.after(() => env.app.stop());
  assert.equal(env.fake.config.id_key, 'bb'.repeat(32));
  const key = keyOf('bb'.repeat(32), 'pdl', M.PDL);
  assert.ok(env.fake.discoveredDevices[0].external_id.endsWith(key));
  assert.ok(!JSON.stringify(env.store.data).includes('bb'.repeat(32)));
});

test('a config problem: nothing sent, the status says what', async (t) => {
  const env = await started({ config: { token: M.TOKEN, usage_points: '1234567891234' } });
  t.after(() => env.app.stop());
  assert.equal(env.med.calls.length, 0);
  assert.match(statusText(env), /not 14 digits/);
  assert.ok(!statusText(env).includes('1234567891234'));
  const answer = await env.fake.action('test_connection');
  assert.match(answer.data.message.en, /not 14 digits/);
});

test('the test button: at most once a minute; a quota reached is said', async (t) => {
  const med = createMed({ access: () => M.validAccess({ quota: true, calls: 50, limit: 50 }) });
  const env = await started({ med });
  t.after(() => env.app.stop());
  let reply = await env.fake.action('test_connection');
  assert.match(reply.data.message.en, /quota is reached \(50\/50\)/);
  reply = await env.fake.action('test_connection');
  assert.match(reply.data.message.en, /less than a minute ago/);
  assert.equal(med.count('access'), 1);
});

test('an answer of an older generation publishes nothing', async (t) => {
  let release;
  const med = createMed({
    curve: (call) =>
      new Promise((resolve) => {
        release = () => resolve(M.curve(call));
      }),
  });
  const config = { ...CONFIG, max_power: false, load_curve: true };
  const env = await started({ med, config });
  t.after(() => env.app.stop());
  await createAll(env);
  await env.wait(2 * MINUTE);
  assert.equal(med.count('curve'), 1);
  // The user saves another meter meanwhile.
  await env.fake.configUpdated({ ...config, usage_points: M.PDL2 });
  release();
  await env.wait(1000);
  assert.equal(dailyDates(env, F('consumption')).length, 0);
  assert.equal(env.store.data.published[KEY]?.curve, undefined);
});

test('stop: the request in flight aborted, nothing sent after, no timer left', async () => {
  let signal;
  const med = createMed({
    contracts: (call) => {
      signal = call.signal;
      return new Promise(() => {});
    },
  });
  const env = await setup({ med });
  registerHandlers(env.gladys, env.app, env.app.log);
  env.app.connected();
  await env.wait(1000);
  await env.app.stop();
  assert.equal(signal.aborted, true);
  const sent = med.calls.length;
  await env.wait(3 * DAY);
  assert.equal(med.calls.length, sent);
  assert.equal(env.pending.size, 0, 'no timer left');
});

// --- Review r1 -------------------------------------------------------------------

const TEMPLATE_CONTRACT = {
  id: 'c1',
  template_key: 'linky-peak-offpeak',
  template_version: '1',
  pricing_mode: 'rules',
  inputs: {},
  valid_from: '2026-11-01',
  valid_to: null,
  timezone: 'Europe/Paris',
  currency: 'EUR',
  billing_period_start_day: 1,
  status: 'active',
};

test('r2: the days are shown only; with the template but no curve, no cost at all', async (t) => {
  const env = await started({
    config: { ...CONFIG, max_power: false },
    contracts: [TEMPLATE_CONTRACT],
  });
  t.after(() => env.app.stop());
  await createAll(env);
  await env.wait(2 * MINUTE);
  assert.equal(dailyDates(env).length, 31, 'the days are published as dated states');
  assert.equal(env.fake.publishedEnergyConsumption.length, 0, 'nothing for the costs');
  const [device] = env.fake.discoveredDevices;
  const day = device.features.find((f) => f.external_id === F('daily_consumption'));
  assert.deepEqual([day.category, day.type], ['energy-sensor', 'index-yesterday']);
  assert.match(statusText(env), /No cost is computed: only the 30-minute load curve/);
});

test('r2: ticking then unticking the load curve removes no feature and loses no day', async (t) => {
  const env = await started({ config: { ...CONFIG, max_power: false } });
  t.after(() => env.app.stop());
  await createAll(env);
  await env.wait(2 * MINUTE);
  const feats = () =>
    env.fake.discoveredDevices[0].features.map((f) => f.external_id.split(':').at(-1));
  // Ticked: the half hours are offered on top of the days.
  await env.fake.configUpdated({ ...CONFIG, max_power: false, load_curve: true });
  await env.wait(MINUTE);
  assert.deepEqual(feats(), ['daily_consumption', 'consumption']);
  assert.match(statusText(env), /update the device in Discovery/);
  // Not updated yet: the days go on, the next morning too.
  await env.wait(DAY);
  assert.equal(dailyDates(env).at(-1), '2026-11-11');
  // Updated: the half hours are read (7 days back), the days go on.
  await createAll(env);
  await env.wait(2 * MINUTE);
  assert.equal(dailyDates(env, F('consumption')).length, 7 * 48);
  assert.doesNotMatch(statusText(env), /update the device/);
  // Unticked: the half-hour feature stays offered (an update never removes it).
  await env.fake.configUpdated({ ...CONFIG, max_power: false });
  await env.wait(MINUTE);
  assert.deepEqual(feats(), ['daily_consumption', 'consumption']);
  await env.wait(DAY);
  const days = dailyDates(env);
  assert.equal(new Set(days).size, days.length, 'each day once');
  // Every day from the first one to yesterday: none lost.
  assert.equal(days.length, 33);
  assert.equal(days.at(-1), '2026-11-12');
});

test('I3: a day missing in the middle is asked again, never skipped', async (t) => {
  let late = true;
  const med = createMed({
    daily: ({ pdl, start, end }) =>
      M.daily({
        pdl,
        start,
        end,
        value: (d, i) => (late && d === '2026-11-08' ? undefined : 1000 + i),
      }),
  });
  const env = await started({ med, config: { ...CONFIG, max_power: false } });
  t.after(() => env.app.stop());
  await createAll(env);
  await env.wait(2 * MINUTE);
  assert.equal(env.store.data.published[KEY].daily, '2026-11-07');
  assert.equal(dailyDates(env).at(-1), '2026-11-07', 'the days after the hole wait');
  late = false;
  await env.wait(3 * HOUR);
  assert.deepEqual([med.calls.at(-1).start, med.calls.at(-1).end], ['2026-11-08', '2026-11-11']);
  const dates = dailyDates(env);
  assert.equal(dates.length, 31);
  assert.equal(new Set(dates).size, 31, 'each day once');
  assert.ok(dates.includes('2026-11-08'));
});

test('I3: a day missing for more than 5 days is given up', async (t) => {
  const med = createMed({
    daily: ({ pdl, start, end }) =>
      M.daily({ pdl, start, end, value: (d, i) => (d === '2026-10-20' ? undefined : 1000 + i) }),
  });
  const env = await started({ med, config: { ...CONFIG, max_power: false } });
  t.after(() => env.app.stop());
  await createAll(env);
  await env.wait(2 * MINUTE);
  assert.equal(env.store.data.published[KEY].daily, '2026-11-10');
  assert.equal(dailyDates(env).length, 30);
});

test('I4: a 5xx on a route of one meter never stops the other routes and meters', async (t) => {
  const med = createMed({
    curve: (call) => (call.pdl === M.PDL ? json({}, 500) : defaults.curve(call)),
  });
  const env = await started({
    med,
    config: { ...CONFIG, load_curve: true, usage_points: `${M.PDL},${M.PDL2}` },
  });
  t.after(() => env.app.stop());
  await createAll(env);
  await env.wait(2 * MINUTE);
  assert.equal(env.app.pause, undefined, 'no global pause: other routes answered');
  // The read after the first one starts with the second meter.
  assert.equal(med.calls[2].pdl, M.PDL2);
  const ops = med.calls.map((c) => `${c.op}:${c.pdl === M.PDL ? 1 : 2}`);
  assert.ok(ops.includes('maxPower:1'), 'the route after the failing one is read');
  assert.ok(ops.includes('curve:2') && ops.includes('maxPower:2'), 'the other meter is read');
  assert.equal(dailyDates(env, F('consumption', KEY2)).length, 7 * 48);
  assert.match(statusText(env), /Meter …1234: curve_server/);
  // The failing route waits; the next read starts with the other meter.
  await env.wait(3 * HOUR);
  assert.equal(med.calls.filter((c) => c.op === 'curve' && c.pdl === M.PDL).length, 2);
});

test('I4: the only route left in 5xx waits on its own: 3 reads a day, no pause of all', async (t) => {
  const med = createMed({ curve: () => json({}, 500) });
  const env = await started({ med, config: { ...CONFIG, load_curve: true } });
  t.after(() => env.app.stop());
  await createAll(env);
  await env.wait(20 * HOUR);
  assert.equal(env.app.pause, undefined);
  assert.ok(med.count('curve') <= 3, `${med.count('curve')} curve requests today`);
  assert.equal(med.count('maxPower'), 1);
});

test('I2: dated states by batches of 100 at most', async (t) => {
  const env = await started({ config: { ...CONFIG, production: true } });
  t.after(() => env.app.stop());
  const sizes = [];
  env.gladys.publishStates = async (states) => sizes.push(states.length);
  const feature = F('daily_production');
  const states = Array.from({ length: 150 }, (_, i) => ({
    device_feature_external_id: feature,
    state: i,
    created_at: new Date(M.NOW - (i + 1) * DAY).toISOString(),
  }));
  await env.app.publishDated(env.app.gen, states);
  assert.deepEqual(sizes, [100, 50]);
});

test('I5: the devices not read from Gladys at start: retried, the status says so', async (t) => {
  const first = await started({ config: { ...CONFIG, max_power: false } });
  await createAll(first);
  const devices = first.fake.devices;
  await first.app.stop();
  const env = await setup({ devices, config: { ...CONFIG, max_power: false } });
  registerHandlers(env.gladys, env.app, env.app.log);
  t.after(() => env.app.stop());
  const real = env.gladys.getDevices.bind(env.gladys);
  // Down at the start and at the first read: retried by its own timer.
  let failures = 2;
  env.gladys.getDevices = () => (failures-- > 0 ? Promise.reject(new Error('down')) : real());
  await env.start();
  assert.match(statusText(env), /devices could not be read from Gladys/);
  assert.equal(env.fake.connectionStatus.connected, false);
  await env.wait(2 * MINUTE);
  assert.equal(dailyDates(env).length, 31);
  assert.doesNotMatch(statusText(env), /devices could not be read/);
});

test('I6: a fixed PDL lifts the refusal (same token)', async (t) => {
  const med = createMed({
    contracts: ({ pdl }) => (pdl === M.PDL2 ? json({}, 403) : M.contracts({ pdl })),
  });
  const env = await started({ med, config: { ...CONFIG, usage_points: M.PDL2 } });
  t.after(() => env.app.stop());
  assert.match(statusText(env), /refused/);
  // Even when the 8 bits kept of the refused meter list match the new one.
  const { tagOf } = await import('../src/app.js');
  env.app.refused.pdlTag = tagOf(env.app.refused.salt, `pdl\u0000${M.PDL}`);
  await env.fake.configUpdated({ ...CONFIG });
  await env.wait(2 * MINUTE);
  assert.equal(med.calls.filter((c) => c.pdl === M.PDL).length, 1);
  assert.match(statusText(env), /^Connected/);
});

test('I7: the count is in /data before the request leaves', async (t) => {
  const store = createMemoryStore();
  const seen = [];
  const med = createMed({
    contracts: (call) => {
      seen.push(store.data.requests?.counts?.[KEY]);
      return defaults.contracts(call);
    },
  });
  const env = await started({ med, store });
  t.after(() => env.app.stop());
  assert.deepEqual(seen, [1]);
});

const TAG = keyOf(M.ID_KEY, 'tag', 'myelectricaldata').slice(0, 8);

test('I7: a pause of /data is capped to 6 hours; a future last read is invalid', async (t) => {
  const store = createMemoryStore({
    keyTag: TAG,
    pause: { until: M.NOW + 30 * HOUR, count: 1, code: 'server', detail: null },
  });
  const env = await started({ store });
  t.after(() => env.app.stop());
  await env.wait(6 * HOUR - MINUTE);
  assert.equal(env.med.calls.length, 0);
  await env.wait(2 * MINUTE);
  assert.equal(env.med.count('contracts'), 1);
  const future = await started({
    store: createMemoryStore({ keyTag: TAG, lastRound: M.NOW + 10 * HOUR }),
  });
  t.after(() => future.app.stop());
  assert.equal(future.med.count('contracts'), 1, 'a last read in the future is ignored');
  // Not even kept (a config problem: no read overwrites it).
  const kept = await started({
    store: createMemoryStore({ keyTag: TAG, lastRound: M.NOW + 10 * HOUR }),
    config: { ...CONFIG, token: '' },
  });
  t.after(() => kept.app.stop());
  assert.equal(kept.app.data.lastRound, null);
});

test('I7: the calendar gap is filled 31 days back at most', async (t) => {
  const env = await started({
    store: createMemoryStore({
      keyTag: TAG,
      calendar: { key: KEY, until: '2026-10-01', ranges: [[1320, 360]] },
    }),
  });
  t.after(() => env.app.stop());
  assert.equal(env.fake.publishedEnergyCalendars[0].entries.length, 7 * 48);
});

test('I7: the id key Gladys holds is the one used (read back), another key drops the marks', async (t) => {
  const env = await setup({ config: { token: M.TOKEN, usage_points: M.PDL } });
  registerHandlers(env.gladys, env.app, env.app.log);
  t.after(() => env.app.stop());
  // Another writer stored its key first: that one wins.
  const realSet = env.gladys.setConfig.bind(env.gladys);
  env.gladys.setConfig = async () => realSet({ id_key: 'c'.repeat(64) });
  await env.start();
  assert.ok(
    env.fake.discoveredDevices[0].external_id.endsWith(keyOf('c'.repeat(64), 'pdl', M.PDL)),
  );
  const store = createMemoryStore({
    keyTag: '0badc0de',
    published: { [KEY]: { daily: '2026-11-10' } },
    contracts: { [KEY]: { date: '2026-11-11', offpeak: [[1320, 360]] } },
  });
  const other = await started({ store });
  t.after(() => other.app.stop());
  assert.deepEqual(store.data.published, {});
  assert.equal(
    other.med.count('contracts'),
    1,
    'the contract kept under another key is read again',
  );
});

test('I7: the device key is an HMAC under the id key (fixed vector)', async () => {
  const { createHmac } = await import('node:crypto');
  const expected = createHmac('sha256', M.ID_KEY)
    .update(`pdl\u0000${M.PDL}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
  assert.equal(KEY, expected);
  assert.notEqual(
    KEY,
    createHmac('sha256', '').update(`pdl\u0000${M.PDL}`, 'utf8').digest('hex').slice(0, 16),
  );
});

test('I7: a refusal kept in /data does not hold another token after a restart', async (t) => {
  const store = createMemoryStore();
  const med = createMed({
    contracts: ({ pdl, auth }) => (auth === M.TOKEN ? json({}, 401) : M.contracts({ pdl })),
  });
  const random = (n) => Buffer.alloc(n, 1);
  const env = await started({ med, store, random });
  assert.ok(store.data.refused);
  const { tagOf } = await import('../src/app.js');
  assert.notEqual(tagOf(store.data.refused.salt, 'another-token-123456'), store.data.refused.tag);
  await env.app.stop();
  const later = await started({
    med,
    store,
    random,
    now: env.clock.now + 2 * HOUR,
    config: { ...CONFIG, token: 'another-token-123456' },
  });
  t.after(() => later.app.stop());
  await later.wait(2 * HOUR);
  assert.equal(med.count('contracts'), 2);
  // The same token after a restart stays refused.
  await later.app.stop();
  const same = await started({ med, store, now: env.clock.now + 4 * HOUR });
  t.after(() => same.app.stop());
  await same.wait(DAY);
  assert.equal(med.calls.filter((c) => c.auth === M.TOKEN).length, 1);
});

test('M2: a wall clock set back keeps the count of the later day', async (t) => {
  const store = createMemoryStore({
    keyTag: TAG,
    requests: { date: '2026-11-12', counts: { [KEY]: MAX_REQUESTS_PER_DAY } },
  });
  const env = await started({ store });
  t.after(() => env.app.stop());
  await env.wait(3 * HOUR);
  assert.equal(env.med.calls.length, 0);
  const reply = await env.fake.action('test_connection');
  assert.match(reply.data.message.en, /daily_ceiling/);
  assert.equal(env.med.calls.length, 0);
});

test('M3: a pause set while a request waits in the queue: nothing sent', async (t) => {
  const env = await started();
  t.after(() => env.app.stop());
  env.app.pause = {
    until: M.NOW + HOUR,
    due: env.app.monotonic() + HOUR,
    count: 1,
    code: 'rate_limited',
  };
  const err = await env.app.countRequest(env.app.meters[0]).catch((e) => e);
  assert.equal(err.code, 'paused');
});

test('M4: /data not writable: the reads wait an hour after a start, the status says so', async (t) => {
  const store = createMemoryStore();
  store.failSave = true;
  const env = await started({ store });
  t.after(() => env.app.stop());
  assert.equal(env.med.calls.length, 0);
  assert.match(statusText(env), /cannot be read or written/);
  await env.wait(59 * MINUTE);
  assert.equal(env.med.calls.length, 0);
  await env.wait(2 * MINUTE);
  assert.equal(env.med.count('contracts'), 1);
});

test('M5: a pause ending in the night: the read waits for the morning', async (t) => {
  // 02:00 in Paris, the contract read yesterday.
  const night = Date.UTC(2026, 10, 11, 1, 0);
  const store = createMemoryStore({
    keyTag: TAG,
    lastRound: night - 10 * HOUR,
    contracts: { [KEY]: { date: '2026-11-10', offpeak: [[1320, 360]] } },
  });
  const med = createMed({ access: () => json({}, 503) });
  const env = await started({ store, med, now: night });
  t.after(() => env.app.stop());
  await env.fake.action('test_connection');
  assert.ok(env.app.pause);
  await env.wait(6 * HOUR);
  assert.equal(med.count('contracts'), 0, 'not at 02:15 nor 06:00');
  await env.wait(3 * HOUR);
  assert.equal(med.count('contracts'), 1);
  assert.ok(localDate(med.calls.at(-1).at) === '2026-11-11');
});

test('M6: the calendar Gladys did not take is published again without a request', async (t) => {
  const env = await setup();
  registerHandlers(env.gladys, env.app, env.app.log);
  t.after(() => env.app.stop());
  const real = env.gladys.publishEnergyCalendar.bind(env.gladys);
  let failures = 1;
  env.gladys.publishEnergyCalendar = (...args) =>
    failures-- > 0 ? Promise.reject(new Error('busy')) : real(...args);
  await env.start();
  assert.match(statusText(env), /did not take the off-peak calendar/);
  await env.wait(5 * MINUTE + 1000);
  assert.equal(env.fake.publishedEnergyCalendars.length, 1);
  assert.equal(env.med.calls.length, 1);
  assert.match(statusText(env), /calendar published up to 17\/11\/2026/);
});

// --- Review r2 -------------------------------------------------------------------

test('M8: a slow /data write that lands is not an unwritable /data', async (t) => {
  const store = createMemoryStore();
  const held = [];
  const save = store.save.bind(store);
  store.save = (data) => new Promise((resolve) => held.push(() => save(data).then(resolve)));
  const env = await setup({ store });
  registerHandlers(env.gladys, env.app, env.app.log);
  t.after(() => env.app.stop());
  env.app.connected();
  await env.wait(5 * 1000);
  for (const done of held.splice(0)) await done();
  await env.wait(1000);
  assert.equal(env.app.storeState, 'ok');
  // Writes land from now on, quickly.
  store.save = save;
  await env.wait(2 * MINUTE);
  assert.equal(env.med.count('contracts'), 1, 'the first read is not delayed by an hour');
  assert.doesNotMatch(statusText(env), /cannot be read or written/);
});

test('M9: a route in 5xx waits; the next read announced is the real one', async (t) => {
  let fail = true;
  const med = createMed({
    daily: (call) => (fail ? json({}, 503) : defaults.daily(call)),
  });
  const env = await started({ med, config: { ...CONFIG, max_power: false } });
  t.after(() => env.app.stop());
  await createAll(env);
  await env.wait(2 * MINUTE);
  assert.equal(med.count('daily'), 1);
  assert.equal(env.app.pause, undefined);
  // A wait longer than the ordinary retry (doubled several times): the read waits for it.
  const key = [...env.app.backoff.keys()][0];
  env.app.backoff.set(key, { count: 5, due: env.app.monotonic() + 5 * HOUR });
  env.app.schedule(env.app.gen);
  await env.app.report();
  const announced = /next read on (\d\d\/\d\d \d\d:\d\d)/.exec(statusText(env))?.[1];
  fail = false;
  await env.wait(4 * HOUR + 50 * MINUTE);
  assert.equal(med.count('daily'), 1, 'not before the wait of the route');
  await env.wait(20 * MINUTE);
  assert.equal(med.count('daily'), 2);
  const t2 = med.calls.filter((c) => c.op === 'daily')[1].at;
  const { dayClock } = await import('../src/time.js');
  const minuteAfter = dayClock(t2 + MINUTE);
  assert.ok([dayClock(t2), minuteAfter].includes(announced), `${announced} vs ${dayClock(t2)}`);
  // A success lifts the wait of the route: a later 5xx starts again at 15 minutes.
  assert.equal(env.app.backoff.size, 0);
  fail = true;
  for (let i = 0; i < 30 && med.count('daily') < 3; i += 1) await env.wait(HOUR);
  assert.equal(med.count('daily'), 3);
  assert.equal(env.app.backoff.values().next().value.count, 1);
});

test('M12: meter numbers changed while stopped lift a refusal', async (t) => {
  const store = createMemoryStore();
  const med = createMed({
    contracts: ({ pdl }) => (pdl === M.PDL2 ? json({}, 403) : M.contracts({ pdl })),
  });
  const env = await started({ med, store, config: { ...CONFIG, usage_points: M.PDL2 } });
  assert.ok(store.data.refused);
  await env.app.stop();
  const later = await started({ med, store, now: env.clock.now + HOUR });
  t.after(() => later.app.stop());
  await later.wait(3 * HOUR);
  assert.equal(med.calls.filter((c) => c.pdl === M.PDL).length, 1);
  // The same wrong meter after a restart stays refused.
  await later.app.stop();
  const same = await started({
    med,
    store: createMemoryStore({ keyTag: TAG, refused: store.data.refused }),
    now: env.clock.now + 2 * HOUR,
    config: { ...CONFIG, usage_points: M.PDL2 },
  });
  t.after(() => same.app.stop());
  await same.wait(DAY);
  assert.equal(med.calls.filter((c) => c.pdl === M.PDL2).length, 1);
});

test('M13: Test pressed while a read waits for a 429: "nothing sent"', async (t) => {
  let release;
  const med = createMed({
    contracts: () =>
      new Promise((resolve) => {
        release = () => resolve(json({}, 429, { 'retry-after': '3600' }));
      }),
  });
  const env = await setup({ med });
  registerHandlers(env.gladys, env.app, env.app.log);
  t.after(() => env.app.stop());
  env.app.connected();
  await env.wait(1000);
  assert.equal(med.count('contracts'), 1);
  const reply = env.fake.action('test_connection');
  await env.wait(1000);
  release();
  await env.wait(1000);
  const answer = await reply;
  assert.match(answer.data.message.en, /^Not sent: MyElectricalData asked to wait/);
  assert.equal(med.count('access'), 0);
});

// --- Review r3 -------------------------------------------------------------------

test('M14: one 429 without Retry-After pauses 1 hour, applied once', async (t) => {
  const med = createMed({ contracts: () => json({ detail: 'quota' }, 429) });
  const env = await started({ med });
  t.after(() => env.app.stop());
  assert.equal(env.store.data.pause.count, 1);
  assert.equal(env.store.data.pause.until - env.clock.now, HOUR);
});

test('M14: the energy of the days is caught up 92 days back at most after a stop', async (t) => {
  const store = createMemoryStore({
    keyTag: TAG,
    published: { [KEY]: { daily: '2026-06-01' } },
  });
  const env = await started({ store, config: { ...CONFIG, max_power: false } });
  t.after(() => env.app.stop());
  await createAll(env);
  await env.wait(2 * MINUTE);
  const daily = env.med.calls.find((c) => c.op === 'daily');
  assert.deepEqual([daily.start, daily.end], ['2026-08-11', '2026-11-11']);
});

test('M14: /data writable again goes back to ok', async (t) => {
  const store = createMemoryStore();
  store.failSave = true;
  const env = await started({ store });
  t.after(() => env.app.stop());
  assert.equal(env.app.storeState, 'unwritable');
  store.failSave = false;
  await env.wait(61 * MINUTE);
  assert.equal(env.app.storeState, 'ok');
  assert.doesNotMatch(statusText(env), /cannot be read or written/);
});

test('M14: a global pause lifts the waits of the routes (read again with the rest)', async (t) => {
  let down = false;
  const med = createMed({
    contracts: (call) => (down ? json({}, 503) : defaults.contracts(call)),
  });
  const env = await started({ med, config: { ...CONFIG, max_power: false } });
  t.after(() => env.app.stop());
  await createAll(env);
  await env.wait(2 * MINUTE);
  assert.equal(med.count('daily'), 1);
  // The next morning: the day route still waits an hour (failed 3 times alone),
  // and the gateway is down for the first read.
  const next = env.app.roundAt('2026-11-12');
  await env.wait(next - env.clock.now - MINUTE);
  env.app.backoff.set(`${KEY}:daily`, { count: 3, due: env.app.monotonic() + 3 * HOUR });
  down = true;
  await env.wait(2 * MINUTE);
  assert.equal(med.count('contracts'), 2);
  assert.ok(env.app.pause);
  down = false;
  await env.wait(20 * MINUTE);
  assert.equal(med.count('daily'), 2, 'read at the end of the pause, not 3 hours later');
});
