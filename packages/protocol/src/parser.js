'use strict';

const { RE, OPERATORS }         = require('./grammar');
const { tokenizeLine }          = require('./tokenizer');
const { validateSyntax }        = require('./validator');

/**
 * PASH v2 Parser
 *
 * Two-pass processing per line:
 *   Pass 1 — Syntactic repair: close truncated pipes, detect operator
 *   Pass 2 — Semantic validation: check against schema (if provided)
 *
 * Returns structured ParsedLine objects, never throws.
 * Errors are surfaced as { type: 'ERROR', ... } objects for the Error Channel.
 */

// ─── Parsed Line Types ────────────────────────────────────────────────────────

/**
 * @typedef {Object} MountOp
 * @property {'MOUNT'} type
 * @property {string}  id         - element ID
 * @property {string}  component  - component name
 * @property {Object}  fields     - { label: value } map (after schema resolution)
 * @property {string[]} rawFields - raw positional field values
 * @property {string|null} parent - parent element ID
 */

/**
 * @typedef {Object} UpdateOp
 * @property {'UPDATE'} type
 * @property {string}   id
 * @property {string}   field
 * @property {string}   value
 */

/**
 * @typedef {Object} UnmountOp
 * @property {'UNMOUNT'} type
 * @property {string}    id
 */

/**
 * @typedef {Object} ErrorLine
 * @property {'ERROR'} type
 * @property {'error'|'warn'} level
 * @property {Object}  params
 */

/**
 * @typedef {Object} DirectiveLine
 * @property {'DIRECTIVE'} type
 * @property {string} name
 * @property {Object} params
 */

/**
 * @typedef {Object} ParseError
 * @property {'PARSE_ERROR'} type
 * @property {string} raw
 * @property {string} reason
 */

// ─── Line Parser ──────────────────────────────────────────────────────────────

/**
 * Parse a single PASH v2 line into a structured operation.
 *
 * @param {string} rawLine
 * @param {Object} [schema] - optional component schema for field labeling
 * @returns {MountOp|UpdateOp|UnmountOp|ErrorLine|DirectiveLine|ParseError}
 */
function parseLine(rawLine, schema) {
  const line = syntacticRepair(rawLine.trimEnd());
  if (!line) return null;

  const first = line[0];

  // ── MOUNT: +[id]|Component|f1|f2|@parent=id ──────────────────────────────
  if (first === '+') {
    const m = RE.MOUNT.exec(line);
    if (!m) return parseError(rawLine, 'Invalid MOUNT syntax: ' + line);

    const id   = m.groups.id;
    const rest = m.groups.rest;
    const { fields, namedParams } = tokenizeLine(rest);

    const component  = fields[0] ?? '';
    const rawFields  = fields.slice(1);
    const parent     = namedParams.parent ?? null;

    // Resolve field labels from schema if provided
    const labeledFields = resolveFields(rawFields, schema, component);

    return {
      type:      OPERATORS.MOUNT,
      id,
      component,
      fields:    labeledFields,
      rawFields,
      parent,
      namedParams,
    };
  }

  // ── UPDATE: ~[id]|field|value ─────────────────────────────────────────────
  if (first === '~') {
    const m = RE.UPDATE.exec(line);
    if (!m) return parseError(rawLine, 'Invalid UPDATE syntax: ' + line);

    return {
      type:  OPERATORS.UPDATE,
      id:    m.groups.id,
      field: m.groups.field,
      value: m.groups.value,
    };
  }

  // ── UNMOUNT: -[id] ────────────────────────────────────────────────────────
  if (first === '-') {
    const m = RE.UNMOUNT.exec(line);
    if (!m) return parseError(rawLine, 'Invalid UNMOUNT syntax: ' + line);

    return {
      type: OPERATORS.UNMOUNT,
      id:   m.groups.id,
    };
  }

  // ── ERROR / WARN channel: !error|... / !warn|... ──────────────────────────
  if (first === '!') {
    const m = RE.ERROR.exec(line);
    if (!m) return parseError(rawLine, 'Invalid ERROR syntax: ' + line);

    return {
      type:   OPERATORS.ERROR,
      level:  m.groups.level,
      params: parseKvList(m.groups.params),
    };
  }

  // ── DIRECTIVE: @name|k=v|k2=v2 ───────────────────────────────────────────
  if (first === '@') {
    const m = RE.DIRECTIVE.exec(line);
    if (!m) return parseError(rawLine, 'Invalid DIRECTIVE syntax: ' + line);

    return {
      type:   OPERATORS.DIRECTIVE,
      name:   m.groups.name,
      params: parseKvList(m.groups.params),
    };
  }

  return parseError(rawLine, 'Unknown operator: ' + first);
}

/**
 * Parse a full PASH v2 stream string into an array of operations.
 *
 * @param {string} stream
 * @param {function(string): Object} [schemaResolver] - (componentName) => schema
 * @returns {{ version: string|null, ops: Array }}
 */
function parseStream(stream, schemaResolver) {
  const lines   = String(stream ?? '').split('\n');
  let version   = null;
  const ops     = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line) continue;

    // Version header (must be first non-empty line)
    if (!version && !ops.length) {
      const vm = RE.VERSION_HEADER.exec(line);
      if (vm) {
        version = vm[1];
        continue;
      }
    }

    const schema = schemaResolver ? schemaResolver(guessComponent(line)) : null;
    const op     = parseLine(line, schema);
    if (op) ops.push(op);
  }

  return { version, ops };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Pass 1: Syntactic repair.
 * Only closes a truncated trailing pipe — nothing semantic.
 */
function syntacticRepair(line) {
  if (!line) return line;
  // If line ends with unescaped |, it's a truncated chunk — close it
  if (line.endsWith('|') && !line.endsWith('\\|')) {
    return line + '';  // field is empty string — valid
  }
  return line;
}

/**
 * Resolve raw positional fields to { label: value } map using schema.
 * If no schema available, uses positional indices as labels (f0, f1, ...).
 */
function resolveFields(rawFields, schema, componentName) {
  const out = Object.create(null);

  if (!schema || !Array.isArray(schema.fields)) {
    rawFields.forEach((v, i) => { out[`f${i}`] = v; });
    return out;
  }

  schema.fields.forEach((fieldDef, i) => {
    out[fieldDef.label] = rawFields[i] !== undefined ? rawFields[i] : '';
  });

  return out;
}

/**
 * Parse a list of key=value pairs separated by |
 * e.g. "id=usr_402|component=UserCard|reason=missing_field_role"
 */
function parseKvList(str) {
  const out = Object.create(null);
  if (!str) return out;

  for (const part of str.split('|')) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      out[part] = true;
    } else {
      out[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  return out;
}

/** Quick extraction of component name for schema lookup, without full parse */
function guessComponent(line) {
  if (line[0] !== '+') return null;
  const bracket = line.indexOf(']|');
  if (bracket === -1) return null;
  const rest  = line.slice(bracket + 2);
  const pipe  = rest.indexOf('|');
  return pipe === -1 ? rest : rest.slice(0, pipe);
}

function parseError(raw, reason) {
  return { type: 'PARSE_ERROR', raw, reason };
}

module.exports = { parseLine, parseStream };
