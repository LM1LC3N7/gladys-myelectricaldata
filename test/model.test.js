// -----------------------------------------------------------------------------
// The answers of the API read strictly, the off-peak hours, the calendar
// slots on the days of the changes of time, and the engine of the Gladys core
// pricing the contract template with the calendar (when the clone is here).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  parseContract,
  parseCurve,
  parseDaily,
  parseMaxPower,
  parseValidAccess,
  readingValue,
} from '../src/med/model.js';
import { calendarEntries, isOffpeakSlot, parseOffpeak, rangesText } from '../src/offpeak.js';
import { parseLocalDate, slotsOfDay } from '../src/time.js';
import * as M from './fixtures/med.js';

test('off-peak hours: the Enedis text read strictly, never guessed', () => {
  assert.deepEqual(parseOffpeak('HC (22H00-6H00)'), [[1320, 360]]);
  assert.deepEqual(parseOffpeak('HC (2H00-7H00;14H00-17H00)'), [
    [120, 420],
    [840, 1020],
  ]);
  assert.deepEqual(parseOffpeak(' hc(23h30-7h30) '), [[1410, 450]]);
  assert.deepEqual(parseOffpeak('HC (22H38-6H38)'), [[1358, 398]]);
  assert.deepEqual(parseOffpeak('HC (0H00-24H00)'), undefined, 'a whole day is not off-peak hours');
  assert.deepEqual(parseOffpeak('HC (20H00-24H00)'), [[1200, 0]]);
  for (const bad of [
    '',
    'HP',
    '22H00-6H00',
    'HC ()',
    'HC (25H00-6H00)',
    'HC (22H60-6H00)',
    'HC (22H00-22H00)',
    'HC (22H00-6H00;1H00-2H00)',
    'HC (10H00-6H00)',
    'HC (22 heures)',
    42,
    undefined,
  ]) {
    assert.equal(parseOffpeak(bad), undefined, String(bad));
  }
  assert.equal(
    rangesText([
      [1320, 360],
      [750, 870],
    ]),
    '22:00-06:00, 12:30-14:30',
  );
  // A slot is off-peak when its middle minute is.
  const odd = parseOffpeak('HC (22H38-6H38)');
  assert.equal(isOffpeakSlot(22 * 60, odd), false, '22:00-22:30: 0 minute');
  assert.equal(isOffpeakSlot(22 * 60 + 30, odd), true, '22:30-23:00: 22 minutes');
  assert.equal(isOffpeakSlot(6 * 60 + 30, odd), false, '06:30-07:00: 8 minutes');
  assert.equal(isOffpeakSlot(6 * 60, odd), true, '06:00-06:30: 30 minutes');
  const quarter = parseOffpeak('HC (22H15-6H15)');
  assert.equal(isOffpeakSlot(22 * 60, quarter), true, 'exactly half');
  assert.equal(isOffpeakSlot(6 * 60, quarter), false, '06:00-06:30: its first half only');
  // 8 hours stay 8 hours.
  assert.equal(
    calendarEntries(['2026-11-11'], quarter).filter((e) => e.value === 'offpeak').length,
    16,
  );
});

test('calendar: one entry per local half hour, 46 and 50 on the changes of time', () => {
  const ranges = parseOffpeak('HC (22H00-6H00)');
  const normal = calendarEntries(['2026-11-11'], ranges);
  assert.equal(normal.length, 48);
  assert.equal(normal[0].starts_at, '2026-11-10T23:00:00.000Z', 'local midnight in winter');
  assert.equal(normal.filter((e) => e.value === 'offpeak').length, 16);
  assert.equal(normal[11].value, 'offpeak', '05:30');
  assert.equal(normal[12].value, 'peak', '06:00');
  assert.equal(normal[43].value, 'peak', '21:30');
  assert.equal(normal[44].value, 'offpeak', '22:00');
  const spring = calendarEntries(['2026-03-29'], ranges);
  assert.equal(spring.length, 46);
  assert.equal(
    spring.filter((e) => e.value === 'offpeak').length,
    14,
    '02:00-03:00 does not exist',
  );
  const autumn = calendarEntries(['2026-10-25'], ranges);
  assert.equal(autumn.length, 50);
  assert.equal(autumn.filter((e) => e.value === 'offpeak').length, 18, '02:00-03:00 twice');
  // Every start is a distinct UTC instant on a half hour.
  const starts = autumn.map((e) => Date.parse(e.starts_at));
  assert.equal(new Set(starts).size, 50);
  assert.ok(starts.every((s) => s % 1_800_000 === 0));
  // The afternoon off-peak hours of the 2025-2027 changes.
  const afternoon = calendarEntries(['2026-11-11'], parseOffpeak('HC (2H00-6H00;14H00-18H00)'));
  assert.deepEqual(
    afternoon.flatMap((e, i) => (e.value === 'offpeak' ? [i] : [])),
    [4, 5, 6, 7, 8, 9, 10, 11, 28, 29, 30, 31, 32, 33, 34, 35],
  );
});

test('a reading value: digits only, never text as 0', () => {
  assert.equal(readingValue('1234'), 1234);
  assert.equal(readingValue('0'), 0);
  assert.equal(readingValue(' 12.5 '), 12.5);
  for (const bad of ['', ' ', 'null', '-5', '1e3', 'NaN', null, undefined, {}, -1, NaN]) {
    assert.equal(readingValue(bad), undefined, String(bad));
  }
});

test('daily answers: Wh to kWh, the window only, another meter or unit refused', () => {
  const body = M.daily({ start: '2026-11-01', end: '2026-11-04' });
  const days = parseDaily(body, M.PDL, '2026-11-01', '2026-11-04');
  assert.deepEqual(
    [...days],
    [
      ['2026-11-01', 10],
      ['2026-11-02', 10.001],
      ['2026-11-03', 10.002],
    ],
  );
  assert.equal(parseDaily(body, M.PDL2, '2026-11-01', '2026-11-04'), undefined, 'another PDL');
  assert.equal(
    parseDaily(
      M.daily({ start: '2026-11-01', end: '2026-11-02', unit: 'kWh' }),
      M.PDL,
      '2026-11-01',
      '2026-11-02',
    ),
    undefined,
  );
  assert.equal(parseDaily({ detail: 'x' }, M.PDL, '2026-11-01', '2026-11-02'), undefined);
  assert.equal(parseDaily([], M.PDL, '2026-11-01', '2026-11-02'), undefined);
  // Outside the window, text, too large, a date twice with two values: left out.
  body.meter_reading.interval_reading.push(
    { value: '5000', date: '2026-11-04' },
    { value: 'n/a', date: '2026-11-01' },
    { value: '2000000', date: '2026-11-02' },
    { value: '999', date: '2026-11-03' },
    { value: '777', date: '2026-11-31' },
  );
  const kept = parseDaily(body, M.PDL, '2026-11-01', '2026-11-04');
  assert.deepEqual([...kept.keys()], ['2026-11-01', '2026-11-02']);
  // A date stamped with a midnight time is the day.
  const stamped = parseDaily(
    { meter_reading: { interval_reading: [{ value: '100', date: '2026-11-01 00:00:00' }] } },
    M.PDL,
    '2026-11-01',
    '2026-11-02',
  );
  assert.deepEqual([...stamped], [['2026-11-01', 0.1]]);
});

test('peak power: the instant of the peak, 0 left out', () => {
  const body = M.maxPower({
    start: '2026-11-01',
    end: '2026-11-03',
    value: (d, i) => (i ? 0 : 6123),
  });
  const peaks = parseMaxPower(body, M.PDL, '2026-11-01', '2026-11-03');
  assert.deepEqual([...peaks.keys()], ['2026-11-01']);
  assert.equal(peaks.get('2026-11-01').va, 6123);
  assert.equal(new Date(peaks.get('2026-11-01').at).toISOString(), '2026-11-01T17:42:13.000Z');
  // In the hour seen twice, the time is ambiguous: the day is used.
  const autumn = parseMaxPower(
    { meter_reading: { interval_reading: [{ value: '4000', date: '2026-10-25 02:30:00' }] } },
    M.PDL,
    '2026-10-25',
    '2026-10-26',
  );
  assert.equal(autumn.get('2026-10-25').at, parseLocalDate('2026-10-25'));
});

const sum = (values) => Math.round(values.reduce((n, v) => n + v.kwh, 0) * 1000) / 1000;

test('load curve: end stamps to half hours, complete days only', () => {
  const body = M.curve({ start: '2026-11-08', end: '2026-11-10', watts: () => 1000 });
  const days = parseCurve(body, M.PDL, '2026-11-08', '2026-11-10');
  assert.deepEqual([...days.keys()], ['2026-11-08', '2026-11-09']);
  const first = days.get('2026-11-08');
  assert.equal(first.length, 48);
  assert.equal(first[0].starts_at, '2026-11-07T23:00:00.000Z');
  assert.equal(first[0].kwh, 0.5, '1000 W over 30 minutes');
  assert.equal(sum(first), 24);
  // One value missing: that day is not published at all.
  body.meter_reading.interval_reading.splice(60, 1);
  assert.deepEqual([...parseCurve(body, M.PDL, '2026-11-08', '2026-11-10').keys()], ['2026-11-08']);
  // A value given twice for a slot: the day is left out (never a guess).
  const twice = M.curve({ start: '2026-11-08', end: '2026-11-09' });
  twice.meter_reading.interval_reading.push(twice.meter_reading.interval_reading[3]);
  assert.equal(parseCurve(twice, M.PDL, '2026-11-08', '2026-11-09').size, 0);
  // Another unit or meter: unreadable.
  const kw = M.curve({ start: '2026-11-08', end: '2026-11-09' });
  kw.meter_reading.reading_type.unit = 'kW';
  assert.equal(parseCurve(kw, M.PDL, '2026-11-08', '2026-11-09'), undefined);
});

test('load curve: start stamps, hours split in two, 10 minutes summed', () => {
  const start = M.curve({
    start: '2026-11-08',
    end: '2026-11-09',
    watts: (i) => i,
    startStamp: true,
  });
  const s = parseCurve(start, M.PDL, '2026-11-08', '2026-11-09').get('2026-11-08');
  assert.equal(s.length, 48);
  assert.equal(s[1].kwh, 0.0005, 'the second value is the second slot');
  const hourly = M.curve({
    start: '2026-11-08',
    end: '2026-11-09',
    minutes: 60,
    watts: () => 2000,
  });
  const h = parseCurve(hourly, M.PDL, '2026-11-08', '2026-11-09').get('2026-11-08');
  assert.equal(h.length, 48);
  assert.ok(h.every((x) => x.kwh === 1));
  const ten = M.curve({ start: '2026-11-08', end: '2026-11-09', minutes: 10, watts: () => 600 });
  const tn = parseCurve(ten, M.PDL, '2026-11-08', '2026-11-09').get('2026-11-08');
  assert.equal(tn.length, 48);
  assert.ok(tn.every((x) => x.kwh === 0.3));
});

test('load curve: values at both ends of the window are unreadable (no shifted day)', () => {
  const body = M.curve({ start: '2026-11-08', end: '2026-11-09', watts: () => 1000 });
  // An end-stamped day plus one value stamped at the start of the window.
  body.meter_reading.interval_reading.unshift({
    value: '4000',
    date: '2026-11-08 00:00:00',
    interval_length: 'PT30M',
  });
  assert.equal(parseCurve(body, M.PDL, '2026-11-08', '2026-11-09'), undefined);
});

test('load curve: the days of the changes of time (46 and 50 half hours)', () => {
  const autumn = M.curve({ start: '2026-10-25', end: '2026-10-26', watts: () => 1000 });
  // The hour seen twice gives the same wall stamps twice, in order.
  const stamps = autumn.meter_reading.interval_reading.map((r) => r.date);
  assert.equal(stamps.filter((x) => x === '2026-10-25 02:30:00').length, 2);
  const a = parseCurve(autumn, M.PDL, '2026-10-25', '2026-10-26').get('2026-10-25');
  assert.equal(a.length, 50);
  assert.deepEqual(
    a,
    slotsOfDay('2026-10-25').map((at) => ({ starts_at: new Date(at).toISOString(), kwh: 0.5 })),
  );
  const spring = M.curve({ start: '2026-03-29', end: '2026-03-30', watts: () => 1000 });
  const sp = parseCurve(spring, M.PDL, '2026-03-29', '2026-03-30').get('2026-03-29');
  assert.equal(sp.length, 46);
  assert.equal(sum(sp), 23);
});

test('contract and access answers', () => {
  const c = parseContract(
    M.contracts({ offpeak: 'HC (1H30-7H30;12H30-14H30)', power: '12 kVA' }),
    M.PDL,
  );
  assert.deepEqual(c.offpeak, [
    [90, 450],
    [750, 870],
  ]);
  assert.equal(c.power, 12);
  assert.equal(c.tariff, 'BTINFMU4');
  const none = parseContract(M.contracts({ offpeak: null }), M.PDL);
  assert.equal(none.offpeak, null, 'no off-peak hours given');
  const odd = parseContract(M.contracts({ offpeak: 'HC (bizarre)' }), M.PDL);
  assert.equal(odd.offpeak, undefined, 'given but unreadable');
  assert.equal(parseContract(M.contracts(), M.PDL2), undefined, 'another meter');
  assert.equal(parseContract({ detail: 'x' }, M.PDL), undefined);
  const access = parseValidAccess(M.validAccess({ calls: 7, limit: 50 }));
  assert.equal(access.valid, true);
  assert.equal(access.calls, 7);
  assert.equal(access.limit, 50);
  assert.equal(new Date(access.consentEnd).getUTCFullYear(), 2029);
});

const CORE = '/home/claude/code/Gladys/server/lib/energy-contract/engine.js';

test('the engine of the Gladys core prices the template with the calendar (clone only)', (t) => {
  if (!existsSync(CORE)) {
    t.skip('no Gladys clone');
    return;
  }
  const engine = createRequire(import.meta.url)(CORE);
  const manifest = JSON.parse(
    readFileSync(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
  );
  const [template] = manifest.energy_contracts.templates;
  const [definition] = manifest.energy_contracts.calendars;
  const inputs = { price_peak: 0.27, price_offpeak: 0.2, subscription: 15 };
  const tariff = engine.substituteInputs(template.tariff, inputs);
  engine.validateTariff(tariff);
  const compiled = engine.compileTariff(tariff, inputs);
  const dates = ['2026-10-25', '2026-11-11'];
  const entries = calendarEntries(dates, parseOffpeak('HC (22H38-6H38)')).map((e) => ({
    calendar_key: definition.key,
    ...e,
  }));
  const calendars = engine.createCalendarLookup(
    { [definition.key]: definition },
    entries,
    'Europe/Paris',
  );
  const intervals = dates
    .flatMap((d) => slotsOfDay(d))
    .map((at) => ({ starts_at: new Date(at).toISOString(), kwh: 1 }));
  const priced = engine.priceIntervals(compiled, { timezone: 'Europe/Paris' }, intervals, {
    calendars,
  });
  const energy = priced.costs.map((x) => x.components.energy);
  const at = (iso) => energy[intervals.findIndex((i) => i.starts_at === iso)];
  assert.equal(at('2026-11-11T21:00:00.000Z'), 0.27, '22:00 local: 0 off-peak minute');
  assert.equal(at('2026-11-11T21:30:00.000Z'), 0.2, '22:30 local: 22 off-peak minutes');
  assert.equal(at('2026-11-11T05:30:00.000Z'), 0.27, '06:30 local: 8 off-peak minutes');
  assert.equal(at('2026-10-25T01:00:00.000Z'), 0.2, 'the second 02:00 of the autumn change');
  // A day without calendar: the peak price (fallback), never a guess.
  const later = engine.priceIntervals(
    compiled,
    { timezone: 'Europe/Paris' },
    [{ starts_at: '2026-12-01T00:00:00.000Z', kwh: 1 }],
    { calendars },
  );
  assert.equal(later.costs[0].components.energy, 0.27);
});
