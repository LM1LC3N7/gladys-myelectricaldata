// -----------------------------------------------------------------------------
// Answers of the MyElectricalData API, shaped after the schemas of its Swagger
// (www.myelectricaldata.fr/docs, version 1.5.15): fake PDL numbers and token.
// -----------------------------------------------------------------------------

import { HALF_HOUR, MINUTE } from '../../src/constants.js';
import { fromParis, nextDate, paris, parseLocalDate } from '../../src/time.js';

export const TOKEN = 'tok-SECRET-0123456789abcdefABCDEF';
export const PDL = '01234567891234';
export const PDL2 = '09876543215678';
export const ID_KEY = 'a'.repeat(64);
/** Wednesday 11 November 2026, 10:30 in Paris (09:30 UTC). */
export const NOW = Date.UTC(2026, 10, 11, 9, 30);

const pad = (v) => String(v).padStart(2, '0');
/** "2026-11-04 00:30:00", local time of France. */
export const wall = (ms) => {
  const t = paris(ms);
  return `${t.y}-${pad(t.mo)}-${pad(t.d)} ${pad(t.h)}:${pad(t.mi)}:${pad(t.s)}`;
};

export function contracts({ pdl = PDL, offpeak = 'HC (22H00-6H00)', power = '9 kVA' } = {}) {
  return {
    customer: {
      customer_id: '-9999999',
      usage_points: [
        {
          usage_point: { usage_point_id: pdl, usage_point_status: 'com', meter_type: 'AMM' },
          contracts: {
            segment: 'C5',
            subscribed_power: power,
            last_activation_date: '2019-01-01+01:00',
            distribution_tariff: 'BTINFMU4',
            ...(offpeak === null ? {} : { offpeak_hours: offpeak }),
            contract_status: 'SERVC',
            last_distribution_tariff_change_date: '2025-11-01+01:00',
          },
        },
      ],
    },
  };
}

/** The days of [start, end): `value(date, i)` Wh (undefined: the day is left out). */
export function daily({ pdl = PDL, start, end, value = (d, i) => 10000 + i, unit = 'Wh' }) {
  const interval_reading = [];
  let i = 0;
  for (let d = start; d < end; d = nextDate(d), i += 1) {
    const v = value(d, i);
    if (v !== undefined) interval_reading.push({ value: String(v), date: d });
  }
  return {
    meter_reading: {
      usage_point_id: pdl,
      start,
      end,
      quality: 'BRUT',
      reading_type: { measurement_kind: 'energy', measuring_period: 'P1D', unit, aggregate: 'sum' },
      interval_reading,
    },
  };
}

/** The peaks of [start, end): at 18:42 local time, `value(date, i)` VA. */
export function maxPower({ pdl = PDL, start, end, value = (d, i) => 5000 + i }) {
  const interval_reading = [];
  let i = 0;
  for (let d = start; d < end; d = nextDate(d), i += 1) {
    const v = value(d, i);
    if (v !== undefined) interval_reading.push({ value: String(v), date: `${d} 18:42:13` });
  }
  return {
    meter_reading: {
      usage_point_id: pdl,
      start,
      end,
      quality: 'BRUT',
      reading_type: {
        measurement_kind: 'power',
        measuring_period: 'P1D',
        unit: 'VA',
        aggregate: 'maximum',
      },
      interval_reading,
    },
  };
}

/**
 * The load curve of [start, end): one value per `minutes` interval, stamped
 * with the END of the interval (local time of France), `watts(i)` W.
 */
export function curve({
  pdl = PDL,
  start,
  end,
  minutes = 30,
  watts = (i) => 400 + (i % 48),
  startStamp = false,
}) {
  const from = parseLocalDate(start);
  const to = parseLocalDate(end);
  const interval_reading = [];
  let i = 0;
  for (let at = from; at < to; at += minutes * MINUTE, i += 1) {
    interval_reading.push({
      value: String(watts(i)),
      date: wall(startStamp ? at : at + minutes * MINUTE),
      interval_length: `PT${minutes}M`,
      measure_type: 'B',
    });
  }
  return {
    meter_reading: {
      usage_point_id: pdl,
      start,
      end,
      quality: 'BRUT',
      reading_type: { measurement_kind: 'power', unit: 'W', aggregate: 'average' },
      interval_reading,
    },
  };
}

export function validAccess({ valid = true, calls = 3, limit = 50, quota = false } = {}) {
  return {
    valid,
    information: 'ok',
    consent_expiration_date: '2029-06-30T00:00:00',
    call_number: calls,
    quota_reached: quota,
    quota_limit: limit,
    quota_reset_at: '2026-11-12T00:00:00',
    last_call: '2026-11-11T08:00:00',
    ban: false,
  };
}

export { HALF_HOUR, fromParis };
