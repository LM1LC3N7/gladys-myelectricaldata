// -----------------------------------------------------------------------------
// Constants of the MyElectricalData integration: the gateway, the pace, the
// quotas, the bounds and the manifest keys (forever: stored in user configs,
// devices and contracts).
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

/** The public API of the MyElectricalData community gateway (Swagger: /docs). */
export const API_URL = 'https://www.myelectricaldata.fr';
// The version follows the release (package.json is in the image).
const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
export const USER_AGENT = `gladys-myelectricaldata/${VERSION} (+https://github.com/LM1LC3N7/gladys-myelectricaldata)`;

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const HALF_HOUR = 30 * MINUTE;

export const TIME_ZONE = 'Europe/Paris';

// --- Requests -----------------------------------------------------------------

/** One request never takes longer (the gateway asks Enedis live: it can be slow). */
export const REQUEST_TIMEOUT = 45 * SECOND;
/** A larger answer is cut before it is read whole (a year of days is about 30 kB). */
export const MAX_BODY_BYTES = 1024 * 1024;
/** Two requests of the integration are always this far apart (one in flight at a time). */
export const REQUEST_GAP = 3 * SECOND;

// --- Pace and quotas ------------------------------------------------------------

/**
 * Enedis publishes the data of a day the next morning: the daily read starts
 * at ROUND_HOUR (local time of France) plus a minute of the hour proper to
 * the installation (spread over ROUND_SPREAD_MINUTES), and asks only for the
 * days not yet published.
 */
export const ROUND_HOUR = 9;
export const ROUND_SPREAD_MINUTES = 120;
/** When yesterday is still missing: again RETRY_GAP later, at most ROUNDS_PER_DAY reads a day. */
export const RETRY_GAP = 3 * HOUR;
export const ROUNDS_PER_DAY = 3;
/** Two reads are never closer than this (a restart, a saved config included). */
export const MIN_ROUND_GAP = HOUR;
/** A new device or a changed configuration is read sooner, never sooner than this. */
export const SOON_GAP = MINUTE;
/**
 * Hard ceiling of requests per meter (PDL) and per local day of France, kept
 * in /data before each request: the gateway is a free community service.
 */
export const MAX_REQUESTS_PER_DAY = 12;
/** A 429 without Retry-After: 1 hour, doubled up to 6 hours. */
export const RATE_LIMIT_PAUSE = HOUR;
/** A 5xx or a gateway down: 15 minutes, doubled up to 6 hours. */
export const SERVER_PAUSE = 15 * MINUTE;
export const PAUSE_MAX = 6 * HOUR;
/** The test button answers at most once a minute with new requests. */
export const TEST_MIN_GAP = MINUTE;
/** The config is read again after a failure: 5 s doubled up to 5 minutes, for ever. */
export const CONFIG_RETRY_MIN = 5 * SECOND;
export const CONFIG_RETRY_MAX = 5 * MINUTE;
/** /data: waited at most STORE_WAIT; an unreadable one is read again every STORE_RETRY. */
export const STORE_WAIT = 3 * SECOND;
export const STORE_RETRY = 10 * SECOND;
/** A wait longer than this is cut in pieces: a wall clock set forward is seen within it. */
export const MAX_TIMER = HOUR;

// --- History ----------------------------------------------------------------------

/** A new daily feature gets this many days back (one request). */
export const BACKFILL_DAYS = 365;
/** A new load curve feature: 7 days (the Enedis limit of one request). */
export const CURVE_DAYS = 7;
/** The production and the peak power go through the states: 31 days at most. */
export const STATE_BACKFILL_DAYS = 31;
/** The states published per minute, every publication of the integration included. */
export const STATES_PER_MINUTE = 250;
/** The off-peak calendar is published from today to this many days ahead (the core takes 7). */
export const CALENDAR_DAYS_AHEAD = 6;

// --- Bounds -----------------------------------------------------------------------

/** At most this many meters (PDL) per installation. */
export const MAX_PDL = 5;
/** A day beyond this (kWh) is not a household reading (36 kVA x 24 h = 864 kWh). */
export const MAX_DAY_KWH = 1000;
/** A peak beyond this (VA) is not a reading. */
export const MAX_POWER_VA = 250_000;
/** At most this many readings are taken from one answer. */
export const MAX_READINGS = 2000;
export const MAX_STATUS = 500;

// --- Manifest keys (forever) -------------------------------------------------------

export const ACTIONS = { TEST: 'test_connection' };
export const TEMPLATES = { PEAK_OFFPEAK: 'linky-peak-offpeak' };
export const CALENDARS = { OFFPEAK: 'linky-offpeak' };
export const CALENDAR_VALUES = { OFFPEAK: 'offpeak', PEAK: 'peak' };
