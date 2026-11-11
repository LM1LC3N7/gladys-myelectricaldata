// -----------------------------------------------------------------------------
// Local time of France (Europe/Paris), through the time zone database of Node
// (Intl): the changes of time are the real ones. Enedis dates its days and
// its load curve in the local time of France, without an offset. Pure
// functions.
// -----------------------------------------------------------------------------

import { DAY, HALF_HOUR, HOUR, TIME_ZONE } from './constants.js';

const parts = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** The local date and time of France at `ms`: { y, mo, d, h, mi, s }. */
export function paris(ms) {
  const out = {};
  for (const { type, value } of parts.formatToParts(new Date(ms))) {
    out[type] = Number(value);
  }
  return { y: out.year, mo: out.month, d: out.day, h: out.hour, mi: out.minute, s: out.second };
}

const pad = (v) => String(v).padStart(2, '0');

/** "2026-11-11", the local date of France at `ms`. */
export function localDate(ms) {
  const t = paris(ms);
  return `${t.y}-${pad(t.mo)}-${pad(t.d)}`;
}

/** "14:05", local time of France. */
export function clock(ms) {
  const t = paris(ms);
  return `${pad(t.h)}:${pad(t.mi)}`;
}

/** "11/11 14:05", local date and time of France. */
export function dayClock(ms) {
  const t = paris(ms);
  return `${pad(t.d)}/${pad(t.mo)} ${pad(t.h)}:${pad(t.mi)}`;
}

/**
 * Every instant showing this local time in France, oldest first: one, two
 * (the hour seen twice in autumn) or none (the hour skipped in spring).
 */
export function instantsOf(y, mo, d, h = 0, mi = 0, s = 0) {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  const out = [];
  for (const offset of [2, 1]) {
    const candidate = asUtc - offset * HOUR;
    const t = paris(candidate);
    if (t.y === y && t.mo === mo && t.d === d && t.h === h && t.mi === mi && t.s === s) {
      out.push(candidate);
    }
  }
  return out;
}

/** The instant of a local time of France (the first one of an hour seen twice). */
export function fromParis(y, mo, d, h = 0, mi = 0) {
  const [first] = instantsOf(y, mo, d, h, mi);
  // A local time skipped by the spring change (02:xx): read as winter time.
  return first ?? Date.UTC(y, mo - 1, d, h, mi) - HOUR;
}

/** The local midnight of France that starts the day of `ms`. */
export function startOfDay(ms) {
  const t = paris(ms);
  return fromParis(t.y, t.mo, t.d);
}

/** The local midnight `days` days before (negative) or after the day of `ms`. */
export function addDays(ms, days) {
  const t = paris(ms);
  // Noon of the day, moved by whole days, never lands on a change of time.
  const noon = Date.UTC(t.y, t.mo - 1, t.d, 12) + days * DAY;
  const n = new Date(noon);
  return fromParis(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate());
}

/** A local date "YYYY-MM-DD" -> its local midnight in France; undefined when malformed. */
export function parseLocalDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof value === 'string' ? value : '');
  if (!match) return undefined;
  const [y, mo, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (y < 2000 || y > 2100) return undefined;
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return undefined;
  return fromParis(y, mo, d);
}

/** The next local date: "2026-11-11" -> "2026-11-12". */
export function nextDate(date) {
  const [y, mo, d] = date.split('-').map(Number);
  const n = new Date(Date.UTC(y, mo - 1, d + 1));
  return `${n.getUTCFullYear()}-${pad(n.getUTCMonth() + 1)}-${pad(n.getUTCDate())}`;
}

/** The local date `days` days after (negative: before) a local date. */
export function shiftDate(date, days) {
  const [y, mo, d] = date.split('-').map(Number);
  const n = new Date(Date.UTC(y, mo - 1, d + days));
  return `${n.getUTCFullYear()}-${pad(n.getUTCMonth() + 1)}-${pad(n.getUTCDate())}`;
}

/** The 30-minute slots (their start instants) of a local day of France: 46, 48 or 50. */
export function slotsOfDay(date) {
  const from = parseLocalDate(date);
  const to = parseLocalDate(nextDate(date));
  const out = [];
  for (let at = from; at < to; at += HALF_HOUR) out.push(at);
  return out;
}

/** The wall minute (0..1439) of an instant, local time of France. */
export function wallMinute(ms) {
  const t = paris(ms);
  return t.h * 60 + t.mi;
}
