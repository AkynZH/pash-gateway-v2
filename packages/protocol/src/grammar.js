'use strict';

/**
 * PASH v2 Grammar
 *
 * BREAKING CHANGE from v1:
 *   v1: COMP_ID|field1|field2|...           (positional, numeric ID)
 *   v2: OPERATOR[elem_id]|Component|f1|f2|@parent=id (named IDs, tree ops)
 *
 * Stream version detection:
 *   First line must be "v:2" for v2 streams.
 *   Absence of version header or "v:1" → fallback to v1 parser.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OPERATORS
 *
 *   + Mount:
 *     +[elem_id]|ComponentName|field1|field2|...|@parent=parent_id
 *     Example: +usr_402|UserCard|Felix|Lead Dev|@parent=list_panel
 *
 *   ~ Update (incremental diff on specific field):
 *     ~[elem_id]|field_label|new_value
 *     Example: ~usr_402|status|Active
 *
 *   - Unmount (cascade-deletes all children):
 *     -[elem_id]
 *     Example: -list_panel
 *
 *   ! Error/warning channel:
 *     !error|id=elem_id|component=Name|reason=missing_field_role
 *     !warn|id=elem_id|reason=schema_downgrade|dropped_fields=field1,field2
 *
 *   @ Control directives (internal):
 *     @snapshot|hash=SHA256|ts=unix_ms
 *     @version|pash=2|schema_version=1.1
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ESCAPING
 *   | inside a field value: \|
 *   @ inside a field value (not a named param): \@
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NAMED PARAMS (suffix of field list, start with @)
 *   @parent=id       — mount inside parent
 *   @key=value       — arbitrary metadata (extensible)
 */

const OPERATORS = Object.freeze({
  MOUNT:     '+',
  UPDATE:    '~',
  UNMOUNT:   '-',
  ERROR:     '!',
  DIRECTIVE: '@',
});

const OPERATOR_CHARS = new Set(['+', '~', '-', '!', '@']);

/**
 * Regex patterns — pre-compiled for performance.
 * All named groups for clarity.
 */
const RE = Object.freeze({
  VERSION_HEADER: /^v:(\d+(?:\.\d+)?)$/,
  MOUNT:    /^\+\[(?<id>[^\]]+)\]\|(?<rest>.+)$/,
  UPDATE:   /^~\[(?<id>[^\]]+)\]\|(?<field>[^|]+)\|(?<value>.*)$/s,
  UNMOUNT:  /^-\[(?<id>[^\]]+)\]$/,
  ERROR:    /^!(?<level>error|warn)\|(?<params>.+)$/,
  DIRECTIVE:/^@(?<name>[a-z_]+)\|(?<params>.+)$/,
  NAMED_PARAM: /^@(?<key>[a-zA-Z_][a-zA-Z0-9_]*)=(?<value>.*)$/,
});

/** Separator used in streams */
const SEP = '|';

/** Escape sequences */
const ESC_PIPE = '\\|';
const ESC_AT   = '\\@';

module.exports = { OPERATORS, OPERATOR_CHARS, RE, SEP, ESC_PIPE, ESC_AT };
