// -----------------------------------------------------------------------------
// The off-peak hours (heures creuses) of a meter, as Enedis gives them in the
// contract data ("HC (22H00-6H00)", "HC (2H00-7H00;14H00-17H00)"), and the
// 30-minute slots of the `linky-offpeak` tariff calendar built from them.
// Pure functions.
//
// The ranges are local times of France. A range need not start on a half
// hour (some meters switch at 22H38): a slot is off-peak when the off-peak
// hours cover its middle minute (xx:15 or xx:45), that is most of it, or
// exactly its second half (a range starting at 22H15 makes 22:00-22:30
// off-peak and 06:00-06:30 peak: 8 hours stay 8 hours). The engine of
// Gladys prices 30-minute intervals; the exact ranges stay shown on the
// device.
// -----------------------------------------------------------------------------

import { CALENDAR_VALUES } from './constants.js';
import { paris, slotsOfDay, wallMinute } from './time.js';

const RANGE = /^(\d{1,2})[Hh:](\d{2})\s*-\s*(\d{1,2})[Hh:](\d{2})$/;
/** At most this many ranges; their total between 1 minute and 16 hours. */
const MAX_RANGES = 6;
const MAX_TOTAL = 16 * 60;

/**
 * "HC (22H00-6H00;12H30-14H30)" -> [[1320, 360], [750, 870]] (minutes of the
 * day, end exclusive, end before start = across midnight); undefined when
 * absent or not readable (never a guess).
 */
export function parseOffpeak(text) {
  if (typeof text !== 'string' || text.length > 200) return undefined;
  const match = /^\s*HC\s*\(([^()]*)\)\s*$/i.exec(text);
  if (!match) return undefined;
  const items = match[1]
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!items.length || items.length > MAX_RANGES) return undefined;
  const ranges = [];
  let total = 0;
  for (const item of items) {
    const m = RANGE.exec(item);
    if (!m) return undefined;
    const [h1, m1, h2, m2] = m.slice(1).map(Number);
    if (h1 > 24 || h2 > 24 || m1 > 59 || m2 > 59) return undefined;
    if ((h1 === 24 && m1) || (h2 === 24 && m2)) return undefined;
    const from = (h1 * 60 + m1) % 1440;
    const to = (h2 * 60 + m2) % 1440;
    if (from === to) return undefined;
    total += (to - from + 1440) % 1440;
    ranges.push([from, to]);
  }
  if (total > MAX_TOTAL) return undefined;
  // Two ranges overlapping: not a meter's programme.
  for (let minute = 0; minute < 1440; minute += 1) {
    if (ranges.filter((r) => inRange(minute, r)).length > 1) return undefined;
  }
  return ranges;
}

function inRange(minute, [from, to]) {
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}

/** Whether the slot starting at that wall minute is off-peak: its middle minute is. */
export const isOffpeakSlot = (start, ranges) => ranges.some((r) => inRange((start + 15) % 1440, r));

/** The ranges as text, local time: "22:00-06:00, 12:30-14:30". */
export function rangesText(ranges) {
  const hm = (v) =>
    `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
  return (ranges ?? []).map(([a, b]) => `${hm(a)}-${hm(b)}`).join(', ');
}

/** Whether a stored value is a valid list of ranges (from /data). */
export function validRanges(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_RANGES &&
    value.every(
      (r) =>
        Array.isArray(r) &&
        r.length === 2 &&
        r.every((v) => Number.isInteger(v) && v >= 0 && v < 1440) &&
        r[0] !== r[1],
    )
  );
}

/**
 * The calendar entries of the local days `dates` (["2026-11-11", …]): one per
 * 30-minute slot of the local clock of France (46 on the spring change, 50 on
 * the autumn one, each repeated slot classified by its wall time).
 */
export function calendarEntries(dates, ranges) {
  const out = [];
  for (const date of dates) {
    for (const at of slotsOfDay(date)) {
      const start = wallMinute(at);
      // Paris has whole-hour offsets: every slot starts on :00 or :30.
      if (paris(at).mi % 30 !== 0) continue;
      out.push({
        starts_at: new Date(at).toISOString(),
        value: isOffpeakSlot(start, ranges) ? CALENDAR_VALUES.OFFPEAK : CALENDAR_VALUES.PEAK,
      });
    }
  }
  return out;
}
