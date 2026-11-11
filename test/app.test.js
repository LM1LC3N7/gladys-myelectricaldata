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
import { CONFIG, DAY, HOUR, MINUTE, createMed, json, setup, written } from './helpers/app.js';
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

/** Every date ever published to a daily feature, in order. */
const dailyDates = (env, feature = F('daily_consumption')) =>
  env.fake.publishedEnergyConsumption
    .filter((b) => b.device_feature_external_id === feature)
    .flatMap((b) => b.intervals.map((i) => i.date ?? i.starts_at));

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

test('a created device: read a minute later, a year of days; every day published once', async (t) => {
  const env = await started();
  t.after(() => env.app.stop());
  await createAll(env);
  await env.wait(30 * 1000);
  assert.deepEqual(env.med.ops(), ['contracts'], 'never sooner than a minute');
  await env.wait(MINUTE);
  assert.deepEqual(env.med.ops(), ['contracts', 'daily', 'maxPower']);
  const daily = env.med.calls[1];
  assert.deepEqual([daily.start, daily.end], ['2025-11-11', '2026-11-11']);
  assert.deepEqual([env.med.calls[2].start, env.med.calls[2].end], ['2026-10-11', '2026-11-11']);
  const dates = dailyDates(env);
  assert.equal(dates.length, 365);
  assert.equal(dates.at(-1), '2026-11-10');
  assert.equal(env.fake.publishedEnergyConsumption[0].intervals[0].kwh, 10);
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
  assert.equal(all.length, 366);
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
});

test('states throttled: never more than 250 a minute', async (t) => {
  const env = await started({
    config: { ...CONFIG, production: true, usage_points: `${M.PDL},${M.PDL2}` },
  });
  t.after(() => env.app.stop());
  // A long absence: 100 days of peaks and production for two meters.
  env.app.data.published = {
    [KEY]: { daily: '2026-11-10', maxPower: '2026-08-02', production: '2026-08-02' },
    [KEY2]: { daily: '2026-11-10', maxPower: '2026-08-02', production: '2026-08-02' },
  };
  const sent = [];
  const real = env.gladys.publishStates.bind(env.gladys);
  env.gladys.publishStates = (states) => {
    sent.push({ at: env.clock.now, count: states.length });
    return real(states);
  };
  await createAll(env);
  await env.wait(10 * MINUTE);
  const total = sent.reduce((n, s) => n + s.count, 0);
  assert.equal(total, 4 * 100);
  // No window of a minute (on the virtual clock) holds more than 250.
  for (const s of sent) {
    const inWindow = sent.filter((x) => x.at >= s.at && x.at < s.at + MINUTE);
    assert.ok(inWindow.reduce((n, x) => n + x.count, 0) <= 250);
  }
  assert.ok(sent.at(-1).at - sent[0].at >= MINUTE);
});

test('Gladys refuses a publication: the days are asked again later, never lost', async (t) => {
  const env = await started({ config: { ...CONFIG, max_power: false } });
  t.after(() => env.app.stop());
  await createAll(env);
  const real = env.gladys.publishEnergyConsumption.bind(env.gladys);
  let fail = true;
  env.gladys.publishEnergyConsumption = (...args) => {
    if (fail) return Promise.reject(Object.assign(new Error('nope'), { status: 500 }));
    return real(...args);
  };
  await env.wait(2 * MINUTE);
  assert.equal(env.store.data.published[KEY], undefined);
  assert.match(statusText(env), /daily_gladys/);
  fail = false;
  await env.wait(3 * HOUR);
  assert.equal(env.med.count('daily'), 2);
  assert.equal(env.med.calls.at(-1).start, '2025-11-11');
  assert.equal(dailyDates(env).length, 365);
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
    daily: (call) =>
      new Promise((resolve) => {
        release = () => resolve(M.daily(call));
      }),
  });
  const env = await started({ med, config: { ...CONFIG, max_power: false } });
  t.after(() => env.app.stop());
  await createAll(env);
  await env.wait(2 * MINUTE);
  assert.equal(med.count('daily'), 1);
  // The user saves another meter meanwhile.
  await env.fake.configUpdated({ ...CONFIG, max_power: false, usage_points: M.PDL2 });
  release();
  await env.wait(1000);
  assert.equal(dailyDates(env).length, 0);
  assert.equal(env.store.data.published[KEY], undefined);
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
