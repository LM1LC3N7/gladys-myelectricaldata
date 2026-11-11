import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';

const TOKEN = 'abcdefghij0123456789';

test('the form: a token and 14-digit PDL numbers, nothing sent otherwise', () => {
  const ok = normalizeConfig({
    token: ` ${TOKEN} `,
    usage_points: '01234567891234, 09876543215678',
  });
  assert.equal(ok.problem, undefined);
  assert.equal(ok.token, TOKEN);
  assert.deepEqual(ok.pdls, ['01234567891234', '09876543215678']);
  assert.equal(ok.loadCurve, false);
  assert.equal(ok.production, false);
  assert.equal(ok.maxPower, true, 'the peak power is read by default');
  // Separated by spaces, new lines, semicolons; the same one once.
  assert.deepEqual(
    normalizeConfig({
      token: TOKEN,
      usage_points: '01234567891234;\n01234567891234 09876543215678',
    }).pdls,
    ['01234567891234', '09876543215678'],
  );
  assert.equal(normalizeConfig({}).problem, 'missing');
  assert.equal(normalizeConfig(undefined).problem, 'missing');
  assert.equal(normalizeConfig({ usage_points: '01234567891234' }).problem, 'missingToken');
  assert.equal(normalizeConfig({ token: TOKEN }).problem, 'missingPdl');
  // Leading zeros dropped (13 digits), letters, 15 digits: refused, never sent.
  for (const bad of ['1234567891234', '0123456789123A', '012345678912345']) {
    const c = normalizeConfig({ token: TOKEN, usage_points: bad });
    assert.equal(c.problem, 'badPdl', bad);
    assert.deepEqual(c.pdls, []);
  }
  assert.equal(
    normalizeConfig({
      token: TOKEN,
      usage_points: Array(6)
        .fill(0)
        .map((_, i) => `0123456789123${i}`)
        .join(','),
    }).problem,
    'tooManyPdl',
  );
  assert.equal(
    normalizeConfig({ token: 'short', usage_points: '01234567891234' }).problem,
    'badToken',
  );
  assert.equal(
    normalizeConfig({ token: 'with space inside', usage_points: '01234567891234' }).problem,
    'badToken',
  );
  assert.equal(
    normalizeConfig({ token: `${TOKEN}\r\nX: 1`, usage_points: '01234567891234' }).problem,
    'malformed',
  );
  assert.equal(normalizeConfig({ token: 42, usage_points: '01234567891234' }).problem, 'malformed');
  assert.equal(
    normalizeConfig({ token: 'x'.repeat(513), usage_points: '01234567891234' }).problem,
    'malformed',
  );
  assert.equal(
    normalizeConfig({ token: TOKEN, usage_points: '01234567891234\u0000' }).problem,
    'malformed',
  );
  const options = normalizeConfig({
    token: TOKEN,
    usage_points: '01234567891234',
    load_curve: true,
    production: true,
    max_power: false,
  });
  assert.deepEqual([options.loadCurve, options.production, options.maxPower], [true, true, false]);
  // Not a boolean: the default.
  assert.equal(
    normalizeConfig({ token: TOKEN, usage_points: '01234567891234', max_power: 'no' }).maxPower,
    true,
  );
});
