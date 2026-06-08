'use strict';

const { escapeValue } = require('./tokenizer');

/**
 * PASH v2 Serializer
 * Converts structured operation objects back to PASH v2 stream strings.
 */

function serializeMount(op) {
  const fields = Array.isArray(op.rawFields)
    ? op.rawFields.map(escapeValue)
    : Object.values(op.fields ?? {}).map(escapeValue);

  const parts = [`+[${op.id}]`, op.component, ...fields];

  // Named params at end
  if (op.parent) parts.push(`@parent=${op.parent}`);
  if (op.namedParams) {
    for (const [k, v] of Object.entries(op.namedParams)) {
      if (k !== 'parent') parts.push(`@${k}=${v}`);
    }
  }

  return parts.join('|');
}

function serializeUpdate(op) {
  return `~[${op.id}]|${op.field}|${escapeValue(op.value)}`;
}

function serializeUnmount(op) {
  return `-[${op.id}]`;
}

function serializeError(op) {
  const kvParts = Object.entries(op.params ?? {})
    .map(([k, v]) => `${k}=${escapeValue(String(v))}`);
  return `!${op.level}|${kvParts.join('|')}`;
}

function serializeDirective(op) {
  const kvParts = Object.entries(op.params ?? {})
    .map(([k, v]) => `${k}=${escapeValue(String(v))}`);
  return `@${op.name}|${kvParts.join('|')}`;
}

function serializeOp(op) {
  switch (op.type) {
    case '+': return serializeMount(op);
    case '~': return serializeUpdate(op);
    case '-': return serializeUnmount(op);
    case '!': return serializeError(op);
    case '@': return serializeDirective(op);
    default:  throw new Error(`Unknown op type: ${op.type}`);
  }
}

/**
 * Serialize an array of operations to a PASH v2 stream string.
 */
function serializeStream(ops, version = '2') {
  const lines = ops.map(serializeOp);
  return `v:${version}\n${lines.join('\n')}`;
}

module.exports = { serializeMount, serializeUpdate, serializeUnmount,
                   serializeError, serializeDirective, serializeOp, serializeStream };
