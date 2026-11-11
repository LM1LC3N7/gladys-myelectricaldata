// -----------------------------------------------------------------------------
// The Gladys devices (pure). Read-only features only: nothing is commanded.
//
// External ids (forever):
//   ext:<selector>:pdl:<key>   a meter (PDL, point de livraison); key = 16 hex
//                              digits of an HMAC-SHA-256 of the 14-digit PDL
//                              number under the id key kept in the Gladys
//                              config (the number itself is never in an id,
//                              a log, a status or /data). The device name
//                              shows its last 4 digits only.
//
// Features: the daily consumption, or the 30-minute consumption (load curve)
// when asked (never both: a consumption is priced once), fed by
// publishEnergyConsumption (dated intervals, never an index); the daily production and the daily peak power, dated states.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { MAX_DAY_KWH, MAX_POWER_VA } from './constants.js';
import { t } from './i18n.js';
import { rangesText } from './offpeak.js';

export const KIND = 'pdl';
export const FEATURE = Object.freeze({
  DAILY: 'daily_consumption',
  CURVE: 'consumption',
  PRODUCTION: 'daily_production',
  MAX_POWER: 'max_power',
});

export const idsOf = (gladys, key) => gladys.externalIds(KIND, key);

/** The key of one of our device or feature external ids; undefined otherwise. */
export function parseDeviceId(externalId) {
  const match = /:pdl:([0-9a-f]{16})(?::([a-z_]+))?$/.exec(String(externalId ?? ''));
  return match ? { key: match[1], feature: match[2] } : undefined;
}

const sensor = (ids, key, name, category, type, unit, max) => ({
  name,
  external_id: ids.feature(key),
  category,
  type,
  unit,
  read_only: true,
  has_feedback: false,
  keep_history: true,
  min: 0,
  max,
});

/**
 * The device of a meter: `{ key, suffix, contract? }` and the options of the
 * config (`loadCurve`, `production`, `maxPower`).
 */
export function buildPdlDevice(gladys, meter, options, language = 'en') {
  const ids = idsOf(gladys, meter.key);
  const features = [];
  // One consumption feature only (never priced twice): the half hours when
  // the load curve is read, the days otherwise.
  if (!options.loadCurve) {
    features.push(
      sensor(
        ids,
        FEATURE.DAILY,
        t('featureDaily', language),
        C.ENERGY_SENSOR,
        T.ENERGY_SENSOR.DAILY_CONSUMPTION,
        U.KILOWATT_HOUR,
        MAX_DAY_KWH,
      ),
    );
  } else {
    features.push(
      sensor(
        ids,
        FEATURE.CURVE,
        t('featureCurve', language),
        C.ENERGY_SENSOR,
        T.ENERGY_SENSOR.THIRTY_MINUTES_CONSUMPTION,
        U.KILOWATT_HOUR,
        100,
      ),
    );
  }
  if (options.maxPower) {
    features.push(
      sensor(
        ids,
        FEATURE.MAX_POWER,
        t('featureMaxPower', language),
        C.ENERGY_SENSOR,
        T.ENERGY_SENSOR.POWER,
        U.VOLT_AMPERE,
        MAX_POWER_VA,
      ),
    );
  }
  if (options.production) {
    features.push(
      sensor(
        ids,
        FEATURE.PRODUCTION,
        t('featureProduction', language),
        C.ENERGY_PRODUCTION_SENSOR,
        T.ENERGY_PRODUCTION_SENSOR.DAILY_PRODUCTION,
        U.KILOWATT_HOUR,
        MAX_DAY_KWH,
      ),
    );
  }
  const contract = meter.contract ?? {};
  return {
    name: t('devicePdl', language, { suffix: meter.suffix }),
    external_id: ids.device,
    features,
    params: [
      { name: 'pdl_suffix', value: meter.suffix },
      {
        name: 'subscribed_power_kva',
        value: contract.power === undefined ? '' : String(contract.power),
      },
      { name: 'offpeak_hours', value: contract.offpeak ? rangesText(contract.offpeak) : '' },
    ],
  };
}
