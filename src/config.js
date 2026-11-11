// -----------------------------------------------------------------------------
// The configuration of the form, normalized: the MyElectricalData token, the
// meter numbers (PDL, 14 digits) and the optional reads. Nothing here talks
// to the network; nothing here is ever written out (the token and the PDL
// numbers stay in memory).
// -----------------------------------------------------------------------------

import { MAX_PDL } from './constants.js';

/** Control characters (CR, LF, tab included): never in a token nor an id. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** A token of the gateway: printable ASCII, no space. */
const TOKEN = /^[\x21-\x7e]{8,512}$/;
const PDL = /^\d{14}$/;

const flag = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

/**
 * `{ token, pdls, loadCurve, production, maxPower, problem }`: `problem`
 * names what keeps the integration from reading (nothing is sent then).
 */
export function normalizeConfig(raw = {}) {
  const config = {
    token: '',
    pdls: [],
    loadCurve: flag(raw?.load_curve, false),
    production: flag(raw?.production, false),
    maxPower: flag(raw?.max_power, true),
    problem: undefined,
  };
  const token = raw?.token;
  if (token !== undefined && token !== null && typeof token !== 'string') {
    config.problem = 'malformed';
    return config;
  }
  const tokenText = (token ?? '').trim();
  const pdlText = typeof raw?.usage_points === 'string' ? raw.usage_points : '';
  if (CONTROL.test(tokenText) || CONTROL.test(pdlText.replace(/[\r\n\t]/g, ' '))) {
    config.problem = 'malformed';
    return config;
  }
  if (tokenText.length > 512 || pdlText.length > 200) {
    config.problem = 'malformed';
    return config;
  }
  // PDL numbers: separated by spaces, commas or semicolons; the same one once.
  const items = pdlText.split(/[\s,;]+/).filter(Boolean);
  const pdls = [...new Set(items)];
  config.token = tokenText;
  if (!tokenText && !pdls.length) {
    config.problem = 'missing';
  } else if (!tokenText) {
    config.problem = 'missingToken';
  } else if (!TOKEN.test(tokenText)) {
    config.problem = 'badToken';
  } else if (!pdls.length) {
    config.problem = 'missingPdl';
  } else if (pdls.some((p) => !PDL.test(p))) {
    // Never shown back: the status only says that one is not 14 digits.
    config.problem = 'badPdl';
  } else if (pdls.length > MAX_PDL) {
    config.problem = 'tooManyPdl';
  }
  if (!config.problem) config.pdls = pdls;
  return config;
}
