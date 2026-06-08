'use strict';

const { SEP } = require('./grammar');

/**
 * Tokenize a PASH v2 line by | respecting \| escapes and @named params.
 *
 * Returns:
 *   { fields: string[], namedParams: Record<string, string> }
 *
 * Named params (starting with @key=value) are separated from positional fields.
 * They can appear anywhere in the token list and are extracted separately.
 *
 * @param {string} line
 * @returns {{ fields: string[], namedParams: Record<string, string> }}
 */
function tokenizeLine(line) {
  const raw = [];
  let cur    = '';

  for (let i = 0; i < line.length; i++) {
    const ch   = line[i];
    const next = line[i + 1];

    if (ch === '\\' && (next === '|' || next === '@')) {
      cur += next;
      i++;
    } else if (ch === SEP) {
      raw.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  raw.push(cur);

  // Separate named params from positional fields
  const fields      = [];
  const namedParams = Object.create(null);

  for (const token of raw) {
    if (token.startsWith('@') && token.includes('=')) {
      const eq  = token.indexOf('=');
      const key = token.slice(1, eq);
      const val = token.slice(eq + 1);
      namedParams[key] = val;
    } else {
      fields.push(token);
    }
  }

  return { fields, namedParams };
}

/**
 * Escape a string value for use as a PASH field.
 * Replaces | with \| and @ with \@ (only leading @).
 */
function escapeValue(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/^@/, '\\@');
}

/**
 * Unescape a raw field token.
 */
function unescapeValue(token) {
  return token
    .replace(/\\\|/g, '|')
    .replace(/\\@/g, '@');
}

module.exports = { tokenizeLine, escapeValue, unescapeValue };
