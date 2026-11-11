// -----------------------------------------------------------------------------
// The integration itself: the Linky meters (PDL) of the user read through
// the public API of the MyElectricalData community gateway, one Gladys device
// per PDL, the consumption published after the fact (publishEnergyConsumption,
// daily and, when asked, per half hour), the daily production and peak power
// as dated states, and the `linky-offpeak` tariff calendar fed with the real
// off-peak hours of the first PDL (the `linky-peak-offpeak` contract
// template reads it). index.js only wires the SDK handlers to it. Read-only:
// nothing is ever changed on the user's account.
//
// Pace (the gateway is a free service with quotas): one read a day, from
// 09:00 (local time of France, a minute proper to the installation), asking
// only for the days not yet published; again 3 hours later while yesterday
// is missing, at most 3 reads a day; a new device or a changed config is
// read a minute later. Every request is counted in /data BEFORE it leaves,
// with a hard ceiling per PDL and per day. A 429 or a 5xx pauses every
// request (persisted, at most 6 hours).
//
// Two clocks: `now` (wall clock) names the days and dates what /data keeps;
// `monotonic` paces the reads, the gaps and the pauses, so that a wall clock
// set back or forward never hurries them.
//
// A start (config saved, reconnection) opens a new generation: a late answer
// of an older one publishes nothing and sets no status (checked after every
// await).
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { normalizeConfig } from './config.js';
import {
  BACKFILL_DAYS,
  CALENDARS,
  CALENDAR_DAYS_AHEAD,
  CONFIG_RETRY_MAX,
  CONFIG_RETRY_MIN,
  CURVE_DAYS,
  MAX_REQUESTS_PER_DAY,
  MAX_STATUS,
  MAX_TIMER,
  MIN_ROUND_GAP,
  MINUTE,
  PAUSE_MAX,
  RATE_LIMIT_PAUSE,
  RETRY_GAP,
  ROUND_HOUR,
  ROUND_SPREAD_MINUTES,
  ROUNDS_PER_DAY,
  SERVER_PAUSE,
  SOON_GAP,
  STATE_BACKFILL_DAYS,
  STATES_PER_MINUTE,
  STORE_RETRY,
  STORE_WAIT,
  TEST_MIN_GAP,
} from './constants.js';
import { FEATURE, buildPdlDevice, idsOf, parseDeviceId } from './devices.js';
import { both, t } from './i18n.js';
import { MedError, MedSession, routes } from './med/client.js';
import {
  keyOf,
  parseContract,
  parseCurve,
  parseDaily,
  parseMaxPower,
  parseValidAccess,
} from './med/model.js';
import { calendarEntries, rangesText, validRanges } from './offpeak.js';
import { FileStore } from './store.js';
import { dayClock, fromParis, localDate, nextDate, parseLocalDate, shiftDate } from './time.js';

const TIMED_OUT = Symbol('timed out');
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const KEY = /^[0-9a-f]{16}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID_KEY = /^[0-9a-f]{64}$/;
/** Errors that pause every request. */
const PAUSING = new Set(['rate_limited', 'server']);
/** The kinds of data read, in the order of a round. */
const KINDS = ['daily', 'curve', 'maxPower', 'production'];
const FEATURE_OF = {
  daily: FEATURE.DAILY,
  curve: FEATURE.CURVE,
  maxPower: FEATURE.MAX_POWER,
  production: FEATURE.PRODUCTION,
};
/** Days asked for a feature never published yet. */
const FIRST_DAYS = {
  daily: BACKFILL_DAYS,
  curve: CURVE_DAYS,
  maxPower: STATE_BACKFILL_DAYS,
  production: STATE_BACKFILL_DAYS,
};
/** At most this many days asked in one request. */
const MAX_DAYS = {
  daily: BACKFILL_DAYS,
  curve: CURVE_DAYS,
  maxPower: BACKFILL_DAYS,
  production: BACKFILL_DAYS,
};
/** The calendar gap filled between two reads giving the same off-peak hours. */
const MAX_CALENDAR_FILL_DAYS = 31;

/** 8 bits of a salted hash of the token: nothing to find it back from. */
export const tagOf = (salt, token) =>
  createHash('sha256').update(`${salt}\u0000${token}`, 'utf8').digest()[0];

/** A pause read back from /data, its rest capped to PAUSE_MAX; undefined when invalid. */
export function validPause(pause, now, mono) {
  if (
    !pause ||
    !finite(pause.until) ||
    !Number.isInteger(pause.count) ||
    pause.count < 1 ||
    !PAUSING.has(pause.code)
  ) {
    return undefined;
  }
  const left = Math.min(Math.max(0, pause.until - now), PAUSE_MAX);
  return {
    until: now + left,
    due: mono + left,
    count: Math.min(pause.count, 16),
    code: pause.code,
    detail: typeof pause.detail === 'string' ? pause.detail.slice(0, 24) : null,
  };
}

export function validRefused(refused) {
  return refused &&
    typeof refused.salt === 'string' &&
    /^[0-9a-f]{32}$/.test(refused.salt) &&
    Number.isInteger(refused.tag) &&
    refused.tag >= 0 &&
    refused.tag < 256
    ? { salt: refused.salt, tag: refused.tag }
    : undefined;
}

function validPublished(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, marks] of Object.entries(value).slice(0, 16)) {
    if (!KEY.test(key) || !marks || typeof marks !== 'object') continue;
    const kept = {};
    for (const kind of KINDS) if (DATE.test(marks[kind] ?? '')) kept[kind] = marks[kind];
    out[key] = kept;
  }
  return out;
}

function validContracts(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, c] of Object.entries(value).slice(0, 16)) {
    if (!KEY.test(key) || !c || typeof c !== 'object' || !DATE.test(c.date ?? '')) continue;
    out[key] = {
      date: c.date,
      offpeak: validRanges(c.offpeak) ? c.offpeak : null,
      power: finite(c.power) && c.power > 0 && c.power <= 1000 ? c.power : undefined,
    };
  }
  return out;
}

function validCalendar(value) {
  return value &&
    KEY.test(value.key ?? '') &&
    DATE.test(value.until ?? '') &&
    validRanges(value.ranges)
    ? { key: value.key, until: value.until, ranges: value.ranges }
    : null;
}

function validRequests(value) {
  if (!value || !DATE.test(value.date ?? '') || typeof value.counts !== 'object') return null;
  const counts = {};
  for (const [key, n] of Object.entries(value.counts ?? {}).slice(0, 16)) {
    if (KEY.test(key) && Number.isInteger(n) && n >= 0) counts[key] = Math.min(n, 1000);
  }
  return { date: value.date, counts };
}

const bound = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const codeOf = (err) => (err instanceof MedError ? err.code : 'bad_response');
const sameRanges = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export class MedApp {
  constructor({
    gladys,
    logger = console,
    now = () => Date.now(),
    monotonic = () => performance.now(),
    timers = { setTimeout, clearTimeout },
    store = new FileStore(),
    fetchImpl = (...args) => globalThis.fetch(...args),
    random = (n) => randomBytes(n),
    requestGap,
    requestTimeout,
    apiUrl,
  }) {
    this.gladys = gladys;
    this.log = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.random = random;
    this.requestGap = requestGap;
    this.requestTimeout = requestTimeout;
    this.apiUrl = apiUrl;

    this.gen = 0;
    this.stopped = false;
    this.stopEpoch = 0;
    this.config = normalizeConfig({});
    this.session = undefined;
    this.token = undefined;

    /** What /data keeps (never a token nor a PDL number). */
    this.data = {
      lastRound: null,
      roundsDate: null,
      rounds: 0,
      requests: null,
      pause: null,
      refused: null,
      published: {},
      contracts: {},
      calendar: null,
      keyTag: null,
    };
    this.storeState = 'pending';
    this.loading = null;
    this.storeTimer = null;
    this.pause = undefined;
    this.refused = undefined;

    /** The meters of the config: { pdl (memory only), key, suffix }. */
    this.meters = [];
    this.created = new Set();
    this.lastRoundMono = undefined;
    this.soon = false;
    this.roundOk = undefined;
    this.lastReadAt = undefined;
    this.problems = new Map();
    this.calendarProblem = undefined;
    this.statesSent = [];

    this.roundTimer = null;
    this.configTimer = null;
    this.configDelay = 0;
    this.running = Promise.resolve();
    this.sleeps = new Set();
    this.lastStatus = undefined;
    this.lastTest = undefined;
    this.dueMono = undefined;
    this.lastDiscovery = undefined;
    this.idKey = undefined;
    this.idKeyPending = undefined;
    this.idKeyDue = undefined;
    this.idKeyFailures = 0;
    this.idKeyTimer = null;
  }

  gone(gen) {
    return this.stopped || gen !== this.gen;
  }

  // --- Lifecycle -------------------------------------------------------------------

  /** Every (re)connection to Gladys: read the config (retried for ever), then start. */
  async connected() {
    const epoch = this.stopEpoch;
    this.stopped = false;
    this.lastStatus = undefined;
    this.lastDiscovery = undefined;
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = null;
    }
    let config;
    try {
      config = await this.gladys.getConfig();
    } catch (err) {
      if (this.stopped || epoch !== this.stopEpoch) return;
      this.configDelay = Math.min(
        CONFIG_RETRY_MAX,
        Math.max(CONFIG_RETRY_MIN, this.configDelay * 2),
      );
      this.log.warn(
        `Configuration not read (${err?.name ?? 'Error'}): again in ${this.configDelay / 1000} s`,
      );
      await this.setStatus(false, both('configUnread'));
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = null;
        this.connected().catch((e) => this.log.error(`Start failed (${e?.name ?? 'Error'})`));
      }, this.configDelay);
      return;
    }
    if (this.stopped || epoch !== this.stopEpoch) return;
    this.configDelay = 0;
    await this.start(config);
  }

  async start(rawConfig) {
    this.stopped = false;
    const gen = ++this.gen;
    const config = normalizeConfig(rawConfig);
    const tokenChanged = this.token !== undefined && config.token !== this.token;
    const pdlsChanged =
      this.config.pdls.length > 0 &&
      JSON.stringify(config.pdls) !== JSON.stringify(this.config.pdls);
    // Another token or other meters entered by the user: read soon (not at a restart).
    if (tokenChanged || pdlsChanged) this.soon = true;
    // A token changed in this process is always tried, even when its 8-bit
    // tag matches the refused one (a restart keeps the tag only).
    if (tokenChanged && this.refused) {
      this.refused = undefined;
      this.data.refused = null;
    }
    this.takeIdKey(rawConfig);
    const optionsChanged =
      config.loadCurve !== this.config.loadCurve ||
      config.production !== this.config.production ||
      config.maxPower !== this.config.maxPower;
    this.config = config;
    if (tokenChanged || !this.session || config.problem) {
      this.session?.close();
      this.session = config.problem
        ? undefined
        : new MedSession({
            token: config.token,
            fetchImpl: this.fetchImpl,
            monotonic: this.monotonic,
            sleep: (ms) => this.sleep(ms),
            ...(this.apiUrl ? { url: this.apiUrl } : {}),
            ...(this.requestTimeout ? { timeout: this.requestTimeout } : {}),
            ...(this.requestGap !== undefined ? { gap: this.requestGap } : {}),
          });
      this.token = config.problem ? undefined : config.token;
      if (tokenChanged) {
        this.problems.clear();
        this.roundOk = undefined;
      }
    }
    if (pdlsChanged || optionsChanged) this.lastDiscovery = undefined;
    this.clearRound();
    await this.ready();
    if (this.gone(gen)) return;
    if (!config.problem) await this.ensureIdKey(gen);
    if (this.gone(gen)) return;
    this.buildMeters();
    await this.refreshCreated(gen);
    if (this.gone(gen)) return;
    await this.publishDiscovery(gen, { onlyChanged: true });
    if (this.gone(gen)) return;
    this.schedule(gen);
    await this.report(gen);
  }

  /** The meters of the config, keyed under the id key (none without it). */
  buildMeters() {
    if (!this.idKey || this.config.problem) {
      this.meters = [];
      return;
    }
    this.meters = this.config.pdls.map((pdl) => ({
      pdl,
      key: keyOf(this.idKey, 'pdl', pdl),
      suffix: pdl.slice(-4),
    }));
  }

  /** The id key stored in the Gladys config (outside the form), when valid. */
  takeIdKey(rawConfig) {
    const key = typeof rawConfig?.id_key === 'string' ? rawConfig.id_key : '';
    if (ID_KEY.test(key)) this.adoptIdKey(key);
  }

  adoptIdKey(key) {
    if (key === this.idKey) return;
    if (this.idKey) this.lastDiscovery = undefined;
    this.idKey = key;
    this.checkKeyTag();
  }

  /**
   * /data keeps 4 bytes of an HMAC of the id key: when the key in use is
   * another one, what /data keeps per meter (keyed by the old one) goes.
   */
  checkKeyTag() {
    if (!this.idKey || this.storeState !== 'ok') return;
    const tag = keyOf(this.idKey, 'tag', 'myelectricaldata').slice(0, 8);
    if (this.data.keyTag && this.data.keyTag !== tag) {
      this.data.published = {};
      this.data.contracts = {};
      this.data.calendar = null;
      this.data.requests = null;
    }
    this.data.keyTag = tag;
  }

  /**
   * The secret of the device keys (HMAC): read from the Gladys config, made
   * once and stored there (never in /data, never shown in the form). Until it
   * is stored, nothing is read nor published (the ids depend on it). One
   * attempt at a time, spaced 5 s doubled up to 5 min after a failure; the
   * key adopted is the one Gladys holds once the write is done (read back).
   */
  ensureIdKey(gen) {
    if (this.idKey) return Promise.resolve(true);
    if (this.idKeyPending) return this.idKeyPending;
    if (this.idKeyDue !== undefined && this.monotonic() < this.idKeyDue) {
      return Promise.resolve(false);
    }
    this.idKeyPending = this.storeIdKey(gen).finally(() => {
      this.idKeyPending = undefined;
    });
    return this.idKeyPending;
  }

  async storeIdKey(gen) {
    const stored = (config) => (ID_KEY.test(config?.id_key ?? '') ? config.id_key : undefined);
    try {
      let key = stored(await this.gladys.getConfig());
      if (!key) {
        await this.gladys.setConfig({ id_key: this.random(32).toString('hex') });
        key = stored(await this.gladys.getConfig());
        if (!key) throw new Error('not stored');
      }
      if (this.stopped && this.gone(gen)) return false;
      this.idKeyFailures = 0;
      this.idKeyDue = undefined;
      this.adoptIdKey(key);
      await this.save();
      return true;
    } catch (err) {
      this.idKeyFailures += 1;
      const wait = Math.min(CONFIG_RETRY_MAX, CONFIG_RETRY_MIN * 2 ** (this.idKeyFailures - 1));
      this.idKeyDue = this.monotonic() + wait;
      this.log.warn(
        `Id key not stored in Gladys (${err?.name ?? 'Error'}): again in ${wait / 1000} s`,
      );
      // Tried again by its own timer: the reads wait for it.
      if (!this.gone(gen)) {
        if (this.idKeyTimer) this.timers.clearTimeout(this.idKeyTimer);
        this.idKeyTimer = this.timers.setTimeout(() => {
          this.idKeyTimer = null;
          if (this.gone(gen) || this.idKey) return;
          this.ensureIdKey(gen).then((ok) => {
            if (ok && !this.gone(gen)) {
              this.buildMeters();
              this.publishDiscovery(gen)
                .then(() => this.schedule(gen))
                .then(() => this.report(gen));
            } else if (!this.gone(gen)) {
              this.report(gen);
            }
          });
        }, wait);
      }
      return false;
    }
  }

  async stop() {
    this.stopped = true;
    this.stopEpoch += 1;
    this.gen += 1;
    this.clearRound();
    for (const timer of [this.configTimer, this.storeTimer, this.idKeyTimer]) {
      if (timer) this.timers.clearTimeout(timer);
    }
    this.configTimer = null;
    this.storeTimer = null;
    this.idKeyTimer = null;
    this.session?.close();
    this.session = undefined;
    this.token = undefined;
    for (const wake of this.sleeps) wake();
    this.sleeps.clear();
    await this.bounded(
      this.running.catch(() => {}),
      STORE_WAIT,
    ).catch(() => {});
    await this.save();
    await this.bounded(Promise.resolve(this.store.flush?.()), STORE_WAIT).catch(() => {});
  }

  /** `promise`, or TIMED_OUT after `ms` (the timer is cleared either way). */
  bounded(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = this.timers.setTimeout(() => resolve(TIMED_OUT), ms);
      promise.then(
        (value) => {
          this.timers.clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          this.timers.clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  /** Resolves after `ms` (injected timers), or at once when the app stops. */
  sleep(ms) {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      let timer;
      const wake = () => {
        this.timers.clearTimeout(timer);
        this.sleeps.delete(wake);
        resolve();
      };
      timer = this.timers.setTimeout(wake, Math.max(0, ms));
      this.sleeps.add(wake);
    });
  }

  // --- /data ----------------------------------------------------------------------

  /** Waits for /data at most STORE_WAIT; without it, nothing is ever saved. */
  async ready() {
    if (this.storeState === 'ok') return;
    const result = await this.bounded(this.loadStore(), STORE_WAIT);
    if (result === TIMED_OUT && this.storeState === 'pending') this.storeState = 'unreadable';
  }

  /** One read of /data at a time; an unreadable one is read again every STORE_RETRY. */
  loadStore() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const raw = await this.store.load();
        const late = this.storeState === 'unreadable';
        this.merge(raw);
        this.storeState = 'ok';
        this.checkKeyTag();
        if (late) await this.afterLateLoad();
      } catch (err) {
        this.storeState = 'unreadable';
        this.log.warn(
          `/data unreadable (${err?.name ?? 'Error'}): read again in ${STORE_RETRY / 1000} s`,
        );
      } finally {
        this.loading = null;
      }
      if (this.storeState !== 'ok' && !this.stopped && !this.storeTimer) {
        this.storeTimer = this.timers.setTimeout(() => {
          this.storeTimer = null;
          this.loadStore();
        }, STORE_RETRY);
      }
    })();
    return this.loading;
  }

  async afterLateLoad() {
    if (this.storeState !== 'ok' || this.stopped) return;
    const gen = this.gen;
    await this.save();
    if (this.gone(gen)) return;
    await this.publishDiscovery(gen, { onlyChanged: true });
    if (this.gone(gen)) return;
    if (this.roundTimer) this.schedule(gen);
    await this.report(gen);
  }

  /** /data read back, merged with what this process learnt meanwhile (the stricter wins). */
  merge(raw) {
    const data = raw && typeof raw === 'object' ? raw : {};
    const now = this.now();
    const mono = this.monotonic();
    // A time of /data in the future is invalid: ignored.
    if (
      finite(data.lastRound) &&
      data.lastRound <= now &&
      !(finite(this.data.lastRound) && this.data.lastRound > data.lastRound)
    ) {
      this.data.lastRound = data.lastRound;
    }
    if (DATE.test(data.roundsDate ?? '') && Number.isInteger(data.rounds) && data.rounds >= 0) {
      if (!this.data.roundsDate || this.data.roundsDate < data.roundsDate) {
        this.data.roundsDate = data.roundsDate;
        this.data.rounds = Math.min(data.rounds, 100);
      } else if (this.data.roundsDate === data.roundsDate) {
        this.data.rounds = Math.max(this.data.rounds, Math.min(data.rounds, 100));
      }
    }
    const requests = validRequests(data.requests);
    if (requests) {
      const mine = this.data.requests;
      if (!mine || mine.date < requests.date) {
        this.data.requests = requests;
      } else if (mine.date === requests.date) {
        for (const [key, n] of Object.entries(requests.counts)) {
          mine.counts[key] = Math.max(mine.counts[key] ?? 0, n);
        }
      }
    }
    const pause = validPause(data.pause, now, mono);
    if (pause && !(this.pause && this.pause.until >= pause.until)) {
      this.pause = pause;
      this.data.pause = {
        until: pause.until,
        count: pause.count,
        code: pause.code,
        detail: pause.detail,
      };
    }
    const refused = validRefused(data.refused);
    if (refused && !this.refused) {
      this.refused = refused;
      this.data.refused = refused;
    }
    const published = validPublished(data.published);
    for (const [key, marks] of Object.entries(published)) {
      const mine = this.data.published[key] ?? {};
      const merged = { ...marks };
      // The later mark wins: a day is never published twice.
      for (const [kind, date] of Object.entries(mine)) {
        if (!merged[kind] || merged[kind] < date) merged[kind] = date;
      }
      this.data.published[key] = merged;
    }
    const contracts = validContracts(data.contracts);
    for (const [key, c] of Object.entries(contracts)) {
      if (!this.data.contracts[key] || this.data.contracts[key].date < c.date) {
        this.data.contracts[key] = c;
      }
    }
    const calendar = validCalendar(data.calendar);
    if (calendar && (!this.data.calendar || this.data.calendar.until < calendar.until)) {
      this.data.calendar = calendar;
    }
    if (typeof data.keyTag === 'string' && /^[0-9a-f]{8}$/.test(data.keyTag) && !this.data.keyTag) {
      this.data.keyTag = data.keyTag;
    }
  }

  async save() {
    if (this.storeState !== 'ok') return false;
    const snapshot = { version: 1, ...this.data };
    try {
      // A slow volume never holds a read: the write goes on in the background.
      const done = this.store.save(snapshot);
      done.catch((err) => this.log.warn(`/data not saved (${err?.name ?? 'Error'})`));
      return (
        (await this.bounded(
          done.then(() => true),
          STORE_WAIT,
        )) === true
      );
    } catch (err) {
      this.log.warn(`/data not saved (${err?.name ?? 'Error'})`);
      return false;
    }
  }

  // --- Pace ------------------------------------------------------------------------

  clearRound() {
    if (this.roundTimer) {
      this.timers.clearTimeout(this.roundTimer);
      this.roundTimer = null;
    }
  }

  pauseActive(mono = this.monotonic()) {
    return Boolean(this.pause && this.pause.due > mono);
  }

  isRefused() {
    return Boolean(
      this.refused &&
      this.token !== undefined &&
      this.refused.tag === tagOf(this.refused.salt, this.token),
    );
  }

  /** The minute of the day of the daily read, proper to the installation. */
  roundMinute() {
    const spread = this.idKey
      ? parseInt(keyOf(this.idKey, 'minute', 'round').slice(0, 6), 16) % ROUND_SPREAD_MINUTES
      : 0;
    return ROUND_HOUR * 60 + spread;
  }

  /** The wall instant of the daily read of the local date `date`. */
  roundAt(date) {
    const [y, mo, d] = date.split('-').map(Number);
    const minute = this.roundMinute();
    return fromParis(y, mo, d, Math.floor(minute / 60), minute % 60);
  }

  /** The created features of a meter for a kind of data, when the option asks for it. */
  wants(meter, kind) {
    if (kind === 'curve' && !this.config.loadCurve) return false;
    if (kind === 'production' && !this.config.production) return false;
    if (kind === 'maxPower' && !this.config.maxPower) return false;
    return this.created.has(idsOf(this.gladys, meter.key).feature(FEATURE_OF[kind]));
  }

  /** What a meter still needs today: the contract once a day, the days up to yesterday. */
  needs(meter, today) {
    const out = [];
    if (this.data.contracts[meter.key]?.date !== today) out.push('contract');
    const yesterday = shiftDate(today, -1);
    for (const kind of KINDS) {
      if (!this.wants(meter, kind)) continue;
      const last = this.data.published[meter.key]?.[kind];
      if (!last || last < yesterday) out.push(kind);
    }
    return out;
  }

  requestsLeft(meter, today) {
    const r = this.data.requests;
    const used = r && r.date === today ? (r.counts[meter.key] ?? 0) : 0;
    return MAX_REQUESTS_PER_DAY - used;
  }

  /**
   * The monotonic time of the next read. One reading of each clock; a wall
   * target is turned into a monotonic delay at that reading.
   */
  nextDue(mono, now) {
    if (!this.session || this.isRefused() || !this.meters.length) return undefined;
    const today = localDate(now);
    // The last read: this process, else /data; /data not read: unknown, a whole gap is waited.
    let last;
    if (this.lastRoundMono !== undefined) last = this.lastRoundMono;
    else if (this.storeState !== 'ok') last = mono;
    else if (finite(this.data.lastRound) && this.data.lastRound <= now) {
      last = mono - (now - this.data.lastRound);
    }
    const gap = (ms) => (last === undefined ? mono : last + ms);
    const wall = (at) => mono + Math.max(0, at - now);
    const tomorrow = wall(this.roundAt(shiftDate(today, 1)));
    const work = this.meters.some(
      (m) => this.needs(m, today).length && this.requestsLeft(m, today) > 0,
    );
    const rounds = this.data.roundsDate === today ? this.data.rounds : 0;
    let due;
    if (!work) due = tomorrow;
    else if (this.soon || last === undefined) due = gap(SOON_GAP);
    else if (rounds >= ROUNDS_PER_DAY) due = tomorrow;
    else if (rounds === 0) due = Math.max(wall(this.roundAt(today)), gap(MIN_ROUND_GAP));
    else due = Math.max(gap(RETRY_GAP), gap(MIN_ROUND_GAP));
    // A pause set by the last read: the read comes back at its end (the
    // doubled pause is the spacing), not after the ordinary retry gap.
    if (this.pause && work && (last === undefined || this.pause.due > last)) due = this.pause.due;
    else if (this.pause) due = Math.max(due, this.pause.due);
    return due;
  }

  /** The next round: when due, never during a pause or a refusal; long waits cut in pieces. */
  schedule(gen) {
    if (this.gone(gen)) return;
    this.clearRound();
    const mono = this.monotonic();
    const due = this.nextDue(mono, this.now());
    if (due === undefined) {
      this.dueMono = undefined;
      return;
    }
    this.dueMono = Math.max(due, mono);
    const wait = this.dueMono - mono;
    this.roundTimer = this.timers.setTimeout(
      () => {
        this.roundTimer = null;
        if (wait > MAX_TIMER) {
          // Only a piece of the wait: the due time is computed again.
          this.schedule(gen);
          return;
        }
        this.running = this.round(gen).catch((err) =>
          this.log.error(`Round failed (${err?.name ?? 'Error'})`),
        );
      },
      Math.min(wait, MAX_TIMER),
    );
  }

  // --- Reads -------------------------------------------------------------------------

  /** Counts a request of a meter in /data BEFORE it leaves; refuses beyond the ceiling. */
  async countRequest(meter) {
    const today = localDate(this.now());
    if (!this.data.requests || this.data.requests.date !== today) {
      this.data.requests = { date: today, counts: {} };
    }
    const counts = this.data.requests.counts;
    if ((counts[meter.key] ?? 0) >= MAX_REQUESTS_PER_DAY) throw new MedError('daily_ceiling');
    counts[meter.key] = (counts[meter.key] ?? 0) + 1;
    await this.save();
  }

  /** One request of a meter, on the session of this generation only. */
  request(gen, meter, path) {
    if (this.gone(gen) || !this.session) return Promise.reject(new MedError('stopped'));
    return this.session.request(path, () => this.countRequest(meter));
  }

  async round(gen) {
    if (this.gone(gen) || !this.session || this.isRefused()) return;
    const mono = this.monotonic();
    const now = this.now();
    if (this.pauseActive(mono)) {
      this.schedule(gen);
      return;
    }
    const due = this.nextDue(mono, now);
    if (due === undefined || due > mono) {
      this.schedule(gen);
      return;
    }
    const today = localDate(now);
    // The attempt is kept BEFORE anything: a restart never reads sooner.
    this.soon = false;
    this.lastRoundMono = mono;
    this.data.lastRound = now;
    if (this.data.roundsDate !== today) {
      this.data.roundsDate = today;
      this.data.rounds = 0;
    }
    this.data.rounds += 1;
    await this.save();
    if (this.gone(gen)) return;
    let answered = 0;
    let denied = 0;
    let contractsTried = 0;
    try {
      for (const meter of this.meters) {
        if (this.gone(gen) || this.pauseActive()) break;
        const result = await this.readMeter(gen, meter, today);
        if (this.gone(gen)) return;
        answered += result.answered;
        if (result.contractTried) contractsTried += 1;
        if (result.denied) denied += 1;
      }
    } catch (err) {
      if (this.gone(gen)) return;
      if (PAUSING.has(err?.code)) {
        // A read cut by the gateway (429, 5xx) is not one of the reads of the
        // day: it comes back at the end of the pause (the requests stay counted).
        if (this.data.roundsDate === today && this.data.rounds > 0) this.data.rounds -= 1;
        await this.setPause(err);
      } else if (err?.code !== 'stopped') this.log.warn(`Round stopped (${codeOf(err)})`);
    }
    if (this.gone(gen)) return;
    // Refused: the contract of EVERY meter answered 401/403, and nothing else answered.
    if (
      contractsTried === this.meters.length &&
      denied === this.meters.length &&
      answered === 0 &&
      this.meters.length > 0
    ) {
      await this.refuse();
    } else if (answered > 0) {
      await this.clearPause();
    }
    this.roundOk = answered > 0;
    this.lastReadAt = this.now();
    // The gaps count from the END of a read: a slow read never shortens them.
    this.lastRoundMono = this.monotonic();
    this.data.lastRound = this.lastReadAt;
    await this.save();
    if (this.gone(gen)) return;
    await this.publishDiscovery(gen, { onlyChanged: true });
    if (this.gone(gen)) return;
    this.schedule(gen);
    await this.report(gen);
  }

  /** The reads of one meter: what it needs today, within its daily ceiling. */
  async readMeter(gen, meter, today) {
    const result = { answered: 0, denied: false, contractTried: false };
    const problems = [];
    for (const task of this.needs(meter, today)) {
      if (this.gone(gen) || this.pauseActive()) break;
      if (this.requestsLeft(meter, today) <= 0) {
        problems.push('daily_ceiling');
        break;
      }
      try {
        if (task === 'contract') {
          result.contractTried = true;
          await this.readContract(gen, meter, today);
        } else {
          await this.readKind(gen, meter, task, today);
        }
        result.answered += 1;
      } catch (err) {
        const code = codeOf(err);
        if (PAUSING.has(code) || code === 'stopped') throw err;
        if (code === 'daily_ceiling') {
          problems.push(code);
          break;
        }
        if (err?.answered) result.answered += 1;
        if (task === 'contract' && code === 'unauthorized') result.denied = true;
        problems.push(task === 'contract' ? `contract_${code}` : `${task}_${code}`);
        this.log.warn(`Meter …${meter.suffix}: ${task} not read (${code})`);
        // A meter whose contract is refused (consent ended for it): nothing more asked today.
        if (task === 'contract' && code === 'unauthorized') break;
      }
    }
    if (this.gone(gen)) return result;
    if (problems.length) this.problems.set(meter.key, problems.slice(0, 3));
    else this.problems.delete(meter.key);
    return result;
  }

  async readContract(gen, meter, today) {
    const body = await this.request(gen, meter, routes.contracts(meter.pdl));
    if (this.gone(gen)) return;
    const contract = parseContract(body, meter.pdl);
    if (!contract) throw new MedError('bad_response');
    this.data.contracts[meter.key] = {
      date: today,
      offpeak: contract.offpeak ?? null,
      power: contract.power,
    };
    await this.save();
    if (this.gone(gen)) return;
    // The calendar follows the first meter of the config.
    if (meter.key === this.meters[0]?.key) await this.publishCalendar(gen, meter, contract, today);
  }

  /**
   * The off-peak calendar from today to CALENDAR_DAYS_AHEAD days ahead; the
   * days since the last publication are filled too when the hours read then
   * are the same (at most 31 days back). Never a range guessed: a meter
   * without readable off-peak hours feeds nothing.
   */
  async publishCalendar(gen, meter, contract, today) {
    if (contract.offpeak === undefined) {
      this.calendarProblem = 'badOffpeak';
      return;
    }
    if (contract.offpeak === null) {
      this.calendarProblem = 'noOffpeak';
      return;
    }
    const kept = this.data.calendar;
    let from = today;
    if (
      kept &&
      kept.key === meter.key &&
      sameRanges(kept.ranges, contract.offpeak) &&
      kept.until < today &&
      kept.until >= shiftDate(today, -MAX_CALENDAR_FILL_DAYS)
    ) {
      from = nextDate(kept.until);
    }
    const until = shiftDate(today, CALENDAR_DAYS_AHEAD);
    const dates = [];
    for (let d = from; d <= until; d = nextDate(d)) dates.push(d);
    const entries = calendarEntries(dates, contract.offpeak);
    try {
      await this.gladys.publishEnergyCalendar(CALENDARS.OFFPEAK, entries);
      if (this.gone(gen)) return;
      this.data.calendar = { key: meter.key, until, ranges: contract.offpeak };
      this.calendarProblem = undefined;
      await this.save();
    } catch (err) {
      if (this.gone(gen)) return;
      // 403: the key belongs to another integration installed first.
      this.calendarProblem = err?.status === 403 ? 'calendarOwned' : 'calendarFailed';
      this.log.warn(`Off-peak calendar not published (${err?.status ?? err?.name ?? 'Error'})`);
    }
  }

  /** The window of a kind: from the day after the last published to yesterday. */
  windowOf(meter, kind, today) {
    const last = this.data.published[meter.key]?.[kind];
    const oldest = shiftDate(today, -FIRST_DAYS[kind]);
    let start = last ? nextDate(last) : oldest;
    if (start < shiftDate(today, -MAX_DAYS[kind])) start = shiftDate(today, -MAX_DAYS[kind]);
    if (kind === 'curve' && start < shiftDate(today, -CURVE_DAYS)) {
      start = shiftDate(today, -CURVE_DAYS);
    }
    return { start, end: today };
  }

  async readKind(gen, meter, kind, today) {
    const { start, end } = this.windowOf(meter, kind, today);
    if (start >= end) return;
    const pdl = meter.pdl;
    const path = routes[kind](pdl, start, end);
    const body = await this.request(gen, meter, path);
    if (this.gone(gen)) return;
    const parse = {
      daily: parseDaily,
      production: parseDaily,
      maxPower: parseMaxPower,
      curve: parseCurve,
    }[kind];
    const values = parse(body, pdl, start, end);
    if (!values) throw new MedError('bad_response');
    const dates = [...values.keys()].sort();
    if (!dates.length) return;
    const feature = idsOf(this.gladys, meter.key).feature(FEATURE_OF[kind]);
    try {
      if (kind === 'daily') {
        const intervals = dates.map((date) => ({ date, kwh: values.get(date) }));
        await this.gladys.publishEnergyConsumption(feature, intervals);
      } else if (kind === 'curve') {
        const intervals = dates.flatMap((date) => values.get(date));
        for (let i = 0; i < intervals.length; i += 2000) {
          await this.gladys.publishEnergyConsumption(feature, intervals.slice(i, i + 2000));
          if (this.gone(gen)) return;
        }
      } else {
        const states = dates.map((date) => ({
          device_feature_external_id: feature,
          state: kind === 'maxPower' ? values.get(date).va : values.get(date),
          created_at: new Date(
            kind === 'maxPower' ? values.get(date).at : parseLocalDate(date),
          ).toISOString(),
        }));
        await this.publishDated(gen, states);
      }
    } catch (err) {
      if (err instanceof MedError) throw err;
      const e = new MedError(err?.status === 404 ? 'not_created' : 'gladys');
      e.answered = true;
      throw e;
    }
    if (this.gone(gen)) return;
    // Published: never asked nor published again.
    this.data.published[meter.key] = {
      ...(this.data.published[meter.key] ?? {}),
      [kind]: dates.at(-1),
    };
    await this.save();
  }

  /** Dated states, at most STATES_PER_MINUTE a minute (every publication of the integration). */
  async publishDated(gen, states) {
    let rest = states;
    while (rest.length) {
      if (this.gone(gen)) throw new MedError('stopped');
      const mono = this.monotonic();
      this.statesSent = this.statesSent.filter((s) => mono - s.at < MINUTE);
      const used = this.statesSent.reduce((n, s) => n + s.count, 0);
      const room = STATES_PER_MINUTE - used;
      if (room <= 0) {
        await this.sleep(this.statesSent[0].at + MINUTE - mono + 1);
        continue;
      }
      const chunk = rest.slice(0, room);
      rest = rest.slice(room);
      this.statesSent.push({ at: mono, count: chunk.length });
      await this.gladys.publishStates(chunk);
    }
  }

  async refuse() {
    const salt = this.random(16).toString('hex');
    this.refused = { salt, tag: tagOf(salt, this.token) };
    this.data.refused = this.refused;
    this.log.warn(
      'MyElectricalData refused the token for every meter: no request until the token changes or Test succeeds',
    );
    this.clearRound();
    await this.save();
  }

  async setPause(err) {
    const now = this.now();
    const mono = this.monotonic();
    const count = Math.min((this.pause?.code === err.code ? this.pause.count : 0) + 1, 16);
    const base = err.code === 'rate_limited' ? RATE_LIMIT_PAUSE : SERVER_PAUSE;
    const asked = finite(err.retryAfter) && err.retryAfter > 0 ? err.retryAfter : 0;
    const ms = Math.min(PAUSE_MAX, Math.max(asked, base * 2 ** (count - 1)));
    const detail = err.status ? `HTTP ${err.status}` : null;
    this.pause = { until: now + ms, due: mono + ms, count, code: err.code, detail };
    this.data.pause = { until: now + ms, count, code: err.code, detail };
    this.log.warn(`MyElectricalData paused until ${dayClock(now + ms)} (${detail ?? err.code})`);
    await this.save();
  }

  /** A request answered: the pause is over and its count forgotten. */
  async clearPause() {
    if (!this.pause && !this.data.pause) return;
    this.pause = undefined;
    this.data.pause = null;
    await this.save();
  }

  // --- Gladys --------------------------------------------------------------------------

  async refreshCreated(gen) {
    try {
      const devices = await this.bounded(Promise.resolve(this.gladys.getDevices()), 10_000);
      if (this.gone(gen) || devices === TIMED_OUT || !Array.isArray(devices)) return;
      this.created = new Set();
      for (const d of devices) this.addCreated(d);
    } catch (err) {
      this.log.warn(`Devices not read from Gladys (${err?.name ?? 'Error'})`);
    }
  }

  addCreated(device) {
    if (!parseDeviceId(device?.external_id)) return;
    this.created.add(device.external_id);
    for (const f of device.features ?? []) if (f?.external_id) this.created.add(f.external_id);
  }

  async onDeviceCreated(device) {
    const id = parseDeviceId(device?.external_id);
    if (!id) return;
    const known = (device.features ?? []).every((f) => this.created.has(f?.external_id));
    this.addCreated(device);
    const gen = this.gen;
    // A new feature to fill: read soon (a minute after the last read at the earliest).
    if (!known) this.soon = true;
    if (!this.gone(gen) && (this.roundTimer || this.dueMono !== undefined)) this.schedule(gen);
  }

  onDeviceDeleted(device) {
    if (!parseDeviceId(device?.external_id)) return;
    for (const f of device.features ?? []) this.created.delete(f?.external_id);
    this.created.delete(device.external_id);
  }

  /** The devices offered in Discovery: the meters of the config. Never a request. */
  async publishDiscovery(gen, { onlyChanged = false } = {}) {
    if (!this.meters.length && !this.lastDiscovery) return;
    const devices = this.meters.map((m) =>
      buildPdlDevice(
        this.gladys,
        { key: m.key, suffix: m.suffix, contract: this.data.contracts[m.key] },
        this.config,
      ),
    );
    const text = JSON.stringify(devices);
    if (onlyChanged && text === this.lastDiscovery) return;
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      if (!this.gone(gen)) this.lastDiscovery = text;
    } catch (err) {
      this.log.warn(`Discovery not published (${err?.name ?? 'Error'})`);
    }
  }

  async scan() {
    await this.publishDiscovery(this.gen);
  }

  // --- Status ------------------------------------------------------------------------

  async report(gen = this.gen) {
    if (this.gone(gen)) return;
    const [connected, message] = this.statusNow();
    if (this.storeState !== 'ok' && this.storeState !== 'pending') {
      for (const lang of ['en', 'fr']) message[lang] += t('storage', lang);
    }
    for (const lang of ['en', 'fr']) message[lang] = bound(message[lang].trim(), MAX_STATUS);
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) return;
    await this.setStatus(connected, message, key);
  }

  async setStatus(connected, message, key = JSON.stringify([connected, message])) {
    try {
      await this.gladys.setConnectionStatus(connected, message);
      this.lastStatus = key;
    } catch (err) {
      this.log.warn(`Status not sent (${err?.name ?? 'Error'})`);
    }
  }

  nextTime() {
    const wait = Math.max(0, (this.dueMono ?? this.monotonic()) - this.monotonic());
    // Rounded up: never a time before the read.
    return dayClock(this.now() + wait + 999);
  }

  statusNow() {
    if (this.config.problem) return [false, both(this.config.problem)];
    if (!this.idKey) {
      const mono = this.monotonic();
      const wait = Math.max(0, (this.idKeyDue ?? mono) - mono);
      return [false, both('idKeyNotStored', { time: dayClock(this.now() + wait + 999) })];
    }
    if (this.isRefused()) return [false, both('refused')];
    if (this.pauseActive()) {
      return [
        false,
        both(this.pause.code === 'rate_limited' ? 'rateLimited' : 'server', {
          time: dayClock(this.pause.until),
          code: this.pause.detail ?? this.pause.code,
        }),
      ];
    }
    const message =
      this.lastReadAt === undefined
        ? both('starting', { count: this.meters.length, time: this.nextTime() })
        : both(this.roundOk ? 'connected' : 'failing', {
            count: this.meters.length,
            time: dayClock(this.lastReadAt),
            next: this.nextTime(),
          });
    const add = (key, values) => {
      for (const lang of ['en', 'fr']) message[lang] += t(key, lang, values);
    };
    for (const meter of this.meters) {
      const problems = this.problems.get(meter.key);
      if (problems?.length)
        add('meterProblems', { suffix: meter.suffix, codes: problems.join(', ') });
    }
    const first = this.meters[0];
    const calendar = this.data.calendar;
    if (this.calendarProblem) {
      add(this.calendarProblem, { suffix: first?.suffix ?? '' });
    } else if (calendar && first && calendar.key === first.key) {
      const [y, mo, d] = calendar.until.split('-');
      add('calendar', {
        suffix: first.suffix,
        hours: rangesText(calendar.ranges),
        until: `${d}/${mo}/${y}`,
      });
    }
    return [this.lastReadAt === undefined ? false : Boolean(this.roundOk), message];
  }

  // --- Test button ------------------------------------------------------------------------

  /** The access of every meter (/valid_access): lifts a refusal when one is accepted. */
  async testConnection() {
    if (this.config.problem) return both(this.config.problem);
    if (!this.idKey || !this.meters.length) return both('testNotReady');
    const mono = this.monotonic();
    if (this.lastTest !== undefined && mono - this.lastTest < TEST_MIN_GAP) {
      return both('testTooSoon');
    }
    if (this.pauseActive(mono)) return both('testPaused', { time: dayClock(this.pause.until) });
    const session = this.session;
    if (!session) return both('missing');
    const gen = this.gen;
    this.lastTest = mono;
    const lines = { en: [], fr: [] };
    let accepted = 0;
    let denied = 0;
    for (const meter of this.meters) {
      let line;
      try {
        const body = await session.request(routes.validAccess(meter.pdl), () =>
          this.countRequest(meter),
        );
        if (this.gone(gen)) return both('testFailed', { code: 'restarted' });
        const access = parseValidAccess(body);
        if (!access) throw new MedError('bad_response');
        accepted += 1;
        const values = {
          suffix: meter.suffix,
          calls: access.calls ?? '?',
          limit: access.limit ?? '?',
          end: access.consentEnd
            ? localDate(access.consentEnd).split('-').reverse().join('/')
            : '?',
        };
        line = both(
          access.banned
            ? 'testBanned'
            : access.valid === false
              ? 'testInvalid'
              : access.quotaReached
                ? 'testQuota'
                : 'testOk',
          values,
        );
      } catch (err) {
        if (this.gone(gen)) return both('testFailed', { code: 'restarted' });
        const code = codeOf(err);
        if (PAUSING.has(code)) {
          await this.setPause(err);
          await this.report(gen);
          return both('testPaused', { time: dayClock(this.pause.until) });
        }
        if (code === 'unauthorized') denied += 1;
        line = both('testMeterFailed', { suffix: meter.suffix, code });
      }
      for (const lang of ['en', 'fr']) lines[lang].push(line[lang]);
    }
    if (accepted > 0) {
      await this.clearPause();
      if (this.refused) {
        this.refused = undefined;
        this.data.refused = null;
        await this.save();
      }
      if (!this.gone(gen)) this.schedule(gen);
    } else if (denied === this.meters.length) {
      await this.refuse();
    }
    await this.report(gen);
    return { en: lines.en.join(' '), fr: lines.fr.join(' ') };
  }
}
