// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. No version is
// pinned: only its shape and its agreement across files.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { ACTIONS, CALENDARS, CALENDAR_VALUES, TEMPLATES } from '../src/constants.js';
import { buildPdlDevice } from '../src/devices.js';
import { ALL_TEXTS } from '../src/i18n.js';

const CORE = '/home/claude/code/Gladys/server';
const normalizeSupportedOptions = existsSync(`${CORE}/utils/normalizeSupportedOptions.js`)
  ? createRequire(import.meta.url)(`${CORE}/utils/normalizeSupportedOptions.js`)
      .normalizeSupportedOptions
  : undefined;
// The units the core accepts per category (its constants when the clone is
// here, the ones this integration uses otherwise).
const UNITS = existsSync(`${CORE}/utils/constants.js`)
  ? createRequire(import.meta.url)(`${CORE}/utils/constants.js`).DEVICE_FEATURE_UNITS_BY_CATEGORY
  : {
      'energy-sensor': ['kilowatt-hour', 'volt-ampere'],
      'energy-production-sensor': ['kilowatt-hour'],
    };

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const handlers = read('src/handlers.js');
const field = (key) => manifest.config_schema.find((f) => f.key === key);

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) yield* texts(entry, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

test('the store basics, the version agreeing everywhere, never pinned', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  // publishEnergyConsumption and the energy contracts arrived with Gladys 5.2.0.
  assert.equal(manifest.gladys_version, '>=5.2.0');
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.name, 'gladys-myelectricaldata');
  assert.equal(lock.name, pkg.name);
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(
    manifest.docker_image,
    `ghcr.io/lm1lc3n7/gladys-myelectricaldata:${manifest.version}`,
  );
  assert.match(
    manifest.cover_image,
    /^https:\/\/raw\.githubusercontent\.com\/LM1LC3N7\/gladys-myelectricaldata\//,
  );
  assert.deepEqual(manifest.transports, ['cloud']);
  assert.deepEqual(manifest.categories, ['energy']);
  assert.equal(manifest.keywords, undefined);
  assert.equal(manifest.countries, undefined);
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
  assert.equal(pkg.license, 'Apache-2.0');
  assert.deepEqual(Object.keys(pkg.dependencies), ['@gladysassistant/integration-sdk']);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`);
    assert.ok(docs.length >= 300);
    assert.match(
      docs,
      /never been tested with a real Linky|jamais été testée avec un vrai compteur Linky/,
    );
  }
});

test('every text is in English and French; sections within their limits', () => {
  for (const [path, entry] of texts(manifest)) {
    for (const lang of ['en', 'fr']) assert.ok(entry[lang]?.trim(), `${path} needs ${lang}`);
  }
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    for (const lang of ['en', 'fr'])
      assert.ok(section.description[lang].length <= 1000, `${section.key}.${lang}`);
    assert.ok((section.links ?? []).every((l) => l.url.startsWith('https://')));
  }
});

test('no key starts with gladys_; secrets have no default; nothing said encrypted', () => {
  const all = [...manifest.config_schema, ...manifest.actions.flatMap((a) => a.fields ?? [])];
  for (const f of all) assert.doesNotMatch(f.key, /^gladys_/);
  const secrets = manifest.config_schema.filter((f) => f.type === 'secret');
  assert.deepEqual(
    secrets.map((f) => f.key),
    ['token'],
  );
  for (const f of secrets) {
    assert.equal(f.default, undefined);
    assert.match(
      f.description.en,
      /Kept by Gladys in its database, never shown again, sent only to MyElectricalData/,
    );
    assert.match(f.description.fr, /Gard(é|ée) par Gladys dans sa base, jamais réaffiché/);
  }
  for (const file of [
    'gladys-assistant-integration.json',
    'docs/en.md',
    'docs/fr.md',
    'README.md',
    'CHANGELOG.md',
    'TODO.md',
    'CLAUDE.md',
    'src/i18n.js',
    'THIRD_PARTY_NOTICES.md',
  ]) {
    // "chiffres" (digits) is fine; "chiffré" (encrypted) never.
    assert.doesNotMatch(read(file), /chiffr(é|ement)|encrypt|hachage/i, file);
  }
});

test('the config fields are the ones the code reads', () => {
  assert.deepEqual(
    manifest.config_schema.filter((f) => f.type !== 'section').map((f) => f.key),
    ['token', 'usage_points', 'load_curve', 'max_power', 'production'],
  );
  assert.equal(field('usage_points').type, 'string');
  assert.equal(field('load_curve').default, false);
  assert.equal(field('max_power').default, true);
  assert.equal(field('production').default, false);
  const config = read('src/config.js');
  for (const f of manifest.config_schema.filter((x) => x.type !== 'section')) {
    assert.ok(config.includes(`.${f.key}`), f.key);
  }
});

test('the action and the contract template are the ones the code handles', () => {
  assert.deepEqual(
    manifest.actions.map((a) => a.key),
    Object.values(ACTIONS),
  );
  assert.ok(handlers.includes('onAction(ACTIONS.TEST'));
  for (const a of manifest.actions) assert.ok(a.timeout_seconds >= 5 && a.timeout_seconds <= 120);
  // Read-only: no command handler at all.
  assert.ok(!handlers.includes('onSetValue'));
  // Priced by the engine of Gladys: no delegated pricing.
  assert.ok(!handlers.includes('onEnergyPrice') && !handlers.includes('onEnergyCurrent'));
  const { templates, calendars } = manifest.energy_contracts;
  assert.deepEqual(
    calendars.map((c) => c.key),
    Object.values(CALENDARS),
  );
  const [calendar] = calendars;
  assert.equal(calendar.granularity, 'thirty_minutes');
  assert.equal(calendar.timezone, 'Europe/Paris');
  assert.deepEqual(calendar.values, Object.values(CALENDAR_VALUES));
  assert.deepEqual(
    templates.map((x) => x.key),
    Object.values(TEMPLATES),
  );
  const [tpl] = templates;
  assert.match(tpl.key, /^[a-z0-9][a-z0-9-]{0,63}$/);
  for (const lang of ['en', 'fr']) assert.ok(tpl.name[lang].length <= 64, lang);
  assert.equal(tpl.country, 'FR');
  assert.equal(tpl.currency, 'EUR');
  assert.equal(tpl.timezone, 'Europe/Paris');
  assert.equal(tpl.pricing_mode, 'rules');
  assert.deepEqual(tpl.calendars, [CALENDARS.OFFPEAK]);
  assert.deepEqual(tpl.tariff.calendars, [CALENDARS.OFFPEAK]);
  const inputs = tpl.inputs.map((i) => i.key);
  for (const [, key] of JSON.stringify(tpl.tariff).matchAll(/\{\{input:(\w+)\}\}/g))
    assert.ok(inputs.includes(key), key);
  for (const i of tpl.inputs) assert.notEqual(i.type, 'secret');
  assert.deepEqual(inputs, ['price_peak', 'price_offpeak', 'subscription']);
  // No price guessed for the user: the two prices have no default.
  assert.equal(tpl.inputs[0].default, undefined);
  assert.equal(tpl.inputs[1].default, undefined);
});

test('the energy_contracts field passes the validator of the Gladys core (when the clone is here)', (t) => {
  const path = `${CORE}/lib/external-integration/externalIntegration.validateManifest.js`;
  if (!existsSync(path)) {
    t.skip('no Gladys clone');
    return;
  }
  // The core opens its DuckDB file in the working directory: a directory of this test.
  const dir = mkdtempSync(join(tmpdir(), 'myelectricaldata-core-'));
  const cwd = process.cwd();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  process.chdir(dir);
  try {
    const { validateManifest } = createRequire(import.meta.url)(path);
    assert.doesNotThrow(() => validateManifest(structuredClone(manifest)));
  } finally {
    process.chdir(cwd);
  }
});

test('the devices: units of the core only, every feature read-only, no switch', () => {
  const gladys = createFakeGladys({ selector: 'myelectricaldata' });
  const devices = [
    buildPdlDevice(
      gladys,
      { key: '0123456789abcdef', suffix: '1234', contract: { offpeak: [[1320, 360]], power: 9 } },
      { loadCurve: true, production: true, maxPower: true },
    ),
  ];
  for (const device of devices) {
    for (const f of device.features) {
      assert.equal(f.read_only, true);
      assert.notEqual(f.category, 'switch');
      if (f.unit) assert.ok(UNITS[f.category].includes(f.unit), f.external_id);
      const options = f.supported_options ?? [];
      for (const o of options) {
        assert.equal(typeof o.label, 'string');
        assert.ok(o.label.trim() === o.label && o.label.length > 0);
        assert.deepEqual(Object.keys(o).sort(), ['label', 'value']);
      }
      assert.equal(new Set(options.map((o) => o.value)).size, options.length);
      if (normalizeSupportedOptions && options.length) {
        assert.deepEqual(normalizeSupportedOptions(options), options);
      }
    }
  }
  assert.deepEqual(
    devices[0].features.map((f) => [f.category, f.type]),
    [
      ['energy-sensor', 'daily-consumption'],
      ['energy-sensor', 'thirty-minutes-consumption'],
      ['energy-sensor', 'power'],
      ['energy-production-sensor', 'daily-production'],
    ],
  );
  // Never a cumulative index: nothing can ever go down.
  assert.ok(devices[0].features.every((f) => f.type !== 'index' && f.type !== 'energy'));
});

test('every runtime text exists in both languages', () => {
  for (const [key, entry] of Object.entries(ALL_TEXTS)) {
    assert.deepEqual(Object.keys(entry).sort(), ['en', 'fr'], key);
    for (const lang of ['en', 'fr']) assert.ok(entry[lang].trim(), `${key}.${lang}`);
    const names = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(names(entry.fr), names(entry.en), key);
  }
});
