// -----------------------------------------------------------------------------
// The answers of the MyElectricalData API (the Enedis data it relays), read
// strictly, after the schemas of its Swagger: a value is a string of digits,
// a date a local date (or local time) of France. An answer about another
// meter, in another unit, or of an unexpected shape is unreadable (never a
// guess); an odd reading is left out, never published as 0. Pure functions.
// -----------------------------------------------------------------------------

import { createHmac } from 'node:crypto';
import { HALF_HOUR, MAX_DAY_KWH, MAX_POWER_VA, MAX_READINGS, MINUTE } from '../constants.js';
import { parseOffpeak } from '../offpeak.js';
import { instantsOf, nextDate, parseLocalDate, slotsOfDay } from '../time.js';

/** 16 hex digits of an HMAC-SHA-256 under the id key: a stable key, nothing to find the value back from. */
export const keyOf = (idKey, kind, value) =>
  createHmac('sha256', idKey).update(`${kind}\u0000${value}`, 'utf8').digest('hex').slice(0, 16);

const DIGITS = /^\d{1,9}(\.\d{1,6})?$/;

/** A reading value: a string (or a number) of digits; undefined otherwise (never 0 for text). */
export function readingValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== 'string' || !DIGITS.test(value.trim())) return undefined;
  return Number(value.trim());
}

/** The meter_reading of an answer, about this PDL; undefined when unreadable. */
function meterReading(body, pdl, units) {
  const reading = body?.meter_reading;
  if (!reading || typeof reading !== 'object' || Array.isArray(reading)) return undefined;
  // An answer naming another meter is not ours.
  if (reading.usage_point_id !== undefined && String(reading.usage_point_id) !== pdl) {
    return undefined;
  }
  const unit = reading.reading_type?.unit;
  if (unit !== undefined && !units.includes(unit)) return undefined;
  if (!Array.isArray(reading.interval_reading)) return undefined;
  return reading.interval_reading.slice(0, MAX_READINGS);
}

/** "2026-11-04" (or with a midnight time) -> "2026-11-04"; undefined otherwise. */
export function readingDate(value) {
  const match = /^(\d{4}-\d{2}-\d{2})(?:[ T]00:00(?::00)?)?$/.exec(
    typeof value === 'string' ? value.trim() : '',
  );
  return match && parseLocalDate(match[1]) !== undefined ? match[1] : undefined;
}

/**
 * The days of a daily answer (consumption or production, Wh): Map date ->
 * kWh, for the dates in [start, end) only. A date given twice with two
 * values is left out (never a guess). Undefined when unreadable.
 */
export function parseDaily(body, pdl, start, end) {
  const list = meterReading(body, pdl, ['Wh']);
  if (!list) return undefined;
  const out = new Map();
  const conflicts = new Set();
  for (const item of list) {
    const date = readingDate(item?.date);
    const wh = readingValue(item?.value);
    if (!date || date < start || date >= end || wh === undefined) continue;
    const kwh = Math.round(wh) / 1000;
    if (kwh > MAX_DAY_KWH) continue;
    if (out.has(date) && out.get(date) !== kwh) conflicts.add(date);
    out.set(date, kwh);
  }
  for (const date of conflicts) out.delete(date);
  return out;
}

const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** "2026-11-04 18:42:13" -> the candidate instants of that local time of France. */
export function localTimeInstants(value) {
  const match = LOCAL_TIME.exec(typeof value === 'string' ? value.trim() : '');
  if (!match) return [];
  const [y, mo, d, h, mi, s] = match.slice(1).map((v) => Number(v ?? 0));
  if (parseLocalDate(`${match[1]}-${match[2]}-${match[3]}`) === undefined) return [];
  if (h > 24 || mi > 59 || s > 59 || (h === 24 && (mi || s))) return [];
  if (h === 24) {
    // "24:00:00": the midnight that ends the day.
    const next = parseLocalDate(nextDate(`${match[1]}-${match[2]}-${match[3]}`));
    return [next];
  }
  return instantsOf(y, mo, d, h, mi, s);
}

/**
 * The daily peaks of power (VA): Map date -> { va, at } (the instant of the
 * peak when readable, else the local midnight of the day). A peak of 0 means
 * nothing was read: left out.
 */
export function parseMaxPower(body, pdl, start, end) {
  const list = meterReading(body, pdl, ['VA', 'W']);
  if (!list) return undefined;
  const out = new Map();
  const conflicts = new Set();
  for (const item of list) {
    const raw = typeof item?.date === 'string' ? item.date.trim() : '';
    const date = raw.slice(0, 10);
    if (readingDate(date) === undefined || date < start || date >= end) continue;
    const va = readingValue(item?.value);
    if (va === undefined || va <= 0 || va > MAX_POWER_VA) continue;
    // The time of the peak, when given and unambiguous; the day otherwise.
    const instants = raw.length > 10 ? localTimeInstants(raw) : [];
    const at = instants.length === 1 ? instants[0] : parseLocalDate(date);
    const value = { va: Math.round(va), at };
    const known = out.get(date);
    if (known && known.va !== value.va) conflicts.add(date);
    out.set(date, value);
  }
  for (const date of conflicts) out.delete(date);
  return out;
}

const LENGTH = /^PT(\d{1,2})M$/;

/**
 * The load curve (mean power in W over each interval of the meter, PT10M,
 * PT15M, PT30M or PT60M) -> the energy of the 30-minute slots of the local
 * clock of France: Map date -> [{ starts_at, kwh }] for the COMPLETE days of
 * [start, end) only (every slot of the day known once). Enedis stamps each
 * value with the END of its interval; an answer whose first value is stamped
 * at the start of the window uses the start of the interval (read as such).
 * An hour seen twice (autumn) is told apart by order. Undefined when
 * unreadable.
 */
export function parseCurve(body, pdl, start, end) {
  const list = meterReading(body, pdl, ['W']);
  if (!list) return undefined;
  const windowStart = parseLocalDate(start);
  const windowEnd = parseLocalDate(end);
  // The stamp convention of this answer.
  const startStamped = list.some(
    (item) => localTimeInstants(item?.date)[0] === windowStart && windowStart !== undefined,
  );
  const slots = new Map();
  const bad = new Set();
  const seen = new Map();
  for (const item of list) {
    const raw = typeof item?.date === 'string' ? item.date.trim() : '';
    const instants = localTimeInstants(raw);
    if (!instants.length) continue;
    const length = LENGTH.exec(String(item?.interval_length ?? 'PT30M'));
    const minutes = length ? Number(length[1]) : NaN;
    if (![5, 10, 15, 30, 60].includes(minutes)) continue;
    // The n-th time this wall time is seen: the n-th instant showing it.
    const n = seen.get(raw) ?? 0;
    seen.set(raw, n + 1);
    const stamp = instants[n];
    if (stamp === undefined) {
      // Seen more often than the clock shows it: that slot is not trusted.
      const last = instants.at(-1) - (startStamped ? 0 : minutes * MINUTE);
      bad.add(last - (last % HALF_HOUR));
      continue;
    }
    const w = readingValue(item?.value);
    if (w === undefined || w > MAX_POWER_VA) continue;
    const from = startStamped ? stamp : stamp - minutes * MINUTE;
    const to = from + minutes * MINUTE;
    if (from < windowStart || to > windowEnd) continue;
    const wh = (w * minutes) / 60;
    // Spread over the slots it covers (an hour: two halves); never across a slot otherwise.
    const pieces = minutes === 60 ? [from, from + HALF_HOUR] : [from];
    if (minutes !== 60 && Math.floor(from / HALF_HOUR) !== Math.floor((to - 1) / HALF_HOUR))
      continue;
    for (const piece of pieces) {
      const slot = piece - (piece % HALF_HOUR);
      const part = minutes === 60 ? 30 : minutes;
      const known = slots.get(slot) ?? { wh: 0, minutes: 0, parts: new Set() };
      const offset = (piece - slot) / MINUTE;
      if (known.parts.has(offset)) bad.add(slot);
      known.parts.add(offset);
      known.wh += minutes === 60 ? wh / 2 : wh;
      known.minutes += part;
      slots.set(slot, known);
    }
  }
  const out = new Map();
  for (let date = start; date < end; date = nextDate(date)) {
    const day = slotsOfDay(date);
    const values = [];
    for (const at of day) {
      const s = slots.get(at);
      if (!s || bad.has(at) || s.minutes !== 30) break;
      values.push({ starts_at: new Date(at).toISOString(), kwh: Math.round(s.wh * 1000) / 1e6 });
    }
    if (values.length === day.length) out.set(date, values);
  }
  return out;
}

/**
 * The contract data of the PDL: { offpeak (ranges or null when the meter
 * has none given), offpeakGiven, power (kVA), tariff }; undefined when
 * unreadable or about another meter.
 */
export function parseContract(body, pdl) {
  const points = body?.customer?.usage_points;
  if (!Array.isArray(points)) return undefined;
  const point = points
    .slice(0, 20)
    .find((p) => String(p?.usage_point?.usage_point_id ?? '') === pdl);
  if (!point || !point.contracts || typeof point.contracts !== 'object') return undefined;
  const c = point.contracts;
  const text = typeof c.offpeak_hours === 'string' ? c.offpeak_hours.trim() : '';
  const offpeak = text ? parseOffpeak(text) : null;
  const powerMatch = /^(\d{1,3}(?:[.,]\d{1,2})?)\s*kVA$/i.exec(
    typeof c.subscribed_power === 'string' ? c.subscribed_power.trim() : '',
  );
  const tariff =
    typeof c.distribution_tariff === 'string' && /^[A-Z0-9_ -]{1,32}$/i.test(c.distribution_tariff)
      ? c.distribution_tariff.trim()
      : '';
  return {
    // undefined: given but unreadable; null: none given.
    offpeak,
    offpeakGiven: Boolean(text),
    power: powerMatch ? Number(powerMatch[1].replace(',', '.')) : undefined,
    tariff,
  };
}

/** The answer of /valid_access: { valid, quotaReached, calls, limit, consentEnd }. */
export function parseValidAccess(body) {
  if (!body || typeof body !== 'object') return undefined;
  const int = (v) => (Number.isInteger(v) && v >= 0 && v < 1e6 ? v : undefined);
  const end = Date.parse(
    typeof body.consent_expiration_date === 'string' ? body.consent_expiration_date : '',
  );
  return {
    valid: body.valid === true ? true : body.valid === false ? false : undefined,
    quotaReached: body.quota_reached === true,
    calls: int(body.call_number),
    limit: int(body.quota_limit),
    consentEnd: Number.isFinite(end) ? end : undefined,
    banned: body.ban === true,
  };
}
