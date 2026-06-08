'use strict';

/**
 * PASH v2 Constraint Engine — Two-Pass Validation
 *
 * FIX: Original spec had a contradiction:
 *   "checks only syntactic integrity BUT rejects on semantic errors"
 *   → Impossible. Semantic checks require schema knowledge.
 *
 * Solution: explicit two-pass architecture.
 *
 * Pass 1 — Syntactic (no schema needed):
 *   - Operator char is valid (+, ~, -, !, @)
 *   - Element ID format: [a-zA-Z0-9_-]+
 *   - Component name: PascalCase or camelCase identifier
 *   - No null bytes, no control chars (except \n as separator)
 *
 * Pass 2 — Semantic (schema required):
 *   - Required fields present and non-empty
 *   - Enum fields contain allowed values
 *   - Parent ID exists in current tree (for MOUNT with @parent)
 *   - UPDATE target field exists in component schema
 *   - UNMOUNT target exists in current tree
 *
 * Both passes emit structured results — never throw.
 * Errors become !error lines in the output stream.
 */

const VALID_ID_RE        = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const VALID_COMPONENT_RE = /^[A-Z][a-zA-Z0-9]*$/;
const VALID_OPERATORS    = new Set(['+', '~', '-', '!', '@']);

// ─── Pass 1: Syntactic ────────────────────────────────────────────────────────

/**
 * Syntactic validation of a parsed operation.
 * Returns { valid: boolean, errors: string[] }
 */
function validateSyntax(op) {
  if (!op) return { valid: false, errors: ['null operation'] };
  if (op.type === 'PARSE_ERROR') {
    return { valid: false, errors: [op.reason] };
  }

  const errors = [];

  switch (op.type) {
    case '+': // MOUNT
      if (!op.id)        errors.push('MOUNT: missing element ID');
      if (op.id && !VALID_ID_RE.test(op.id))
        errors.push(`MOUNT: invalid element ID format "${op.id}" (must match [a-zA-Z][a-zA-Z0-9_-]*)`);
      if (!op.component) errors.push('MOUNT: missing component name');
      if (op.component && !VALID_COMPONENT_RE.test(op.component))
        errors.push(`MOUNT: invalid component name "${op.component}" (must be PascalCase)`);
      if (op.parent && !VALID_ID_RE.test(op.parent))
        errors.push(`MOUNT: invalid parent ID format "${op.parent}"`);
      break;

    case '~': // UPDATE
      if (!op.id)    errors.push('UPDATE: missing element ID');
      if (!op.field) errors.push('UPDATE: missing field name');
      if (op.id && !VALID_ID_RE.test(op.id))
        errors.push(`UPDATE: invalid element ID "${op.id}"`);
      break;

    case '-': // UNMOUNT
      if (!op.id) errors.push('UNMOUNT: missing element ID');
      if (op.id && !VALID_ID_RE.test(op.id))
        errors.push(`UNMOUNT: invalid element ID "${op.id}"`);
      break;

    case '!': // ERROR (pass-through, always syntactically valid if parsed)
    case '@': // DIRECTIVE
      break;

    default:
      errors.push(`Unknown operation type: ${op.type}`);
  }

  return { valid: errors.length === 0, errors };
}

// ─── Pass 2: Semantic ─────────────────────────────────────────────────────────

/**
 * Semantic validation of a MOUNT operation against schema + current tree.
 *
 * @param {Object} op         - parsed MOUNT operation
 * @param {Object} schema     - component schema { fields: [{label, type, required, values}] }
 * @param {Object} treeIndex  - current element tree { [id]: { component, fields, parent } }
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
function validateMountSemantic(op, schema, treeIndex) {
  const errors   = [];
  const warnings = [];

  // Structural checks run regardless of schema availability
  if (treeIndex && treeIndex[op.id]) {
    errors.push(`Element ID "${op.id}" already exists in tree`);
  }

  if (op.parent && treeIndex && !treeIndex[op.parent]) {
    errors.push(`Parent "${op.parent}" not found in current tree`);
  }

  if (!schema) {
    // Unknown component — still allow (warn only) after structural checks
    warnings.push(`Unknown component "${op.component}" — no schema registered`);
    return { valid: errors.length === 0, errors, warnings };
  }

  // Check required fields
  for (const fieldDef of schema.fields) {
    if (!fieldDef.required) continue;
    const val = op.fields[fieldDef.label];
    if (val === undefined || val === null || val === '') {
      errors.push(`Required field "${fieldDef.label}" is missing or empty`);
    }
  }

  // Check enum fields
  for (const fieldDef of schema.fields) {
    if (fieldDef.type !== 'enum' || !Array.isArray(fieldDef.values)) continue;
    const val = op.fields[fieldDef.label];
    if (val && !fieldDef.values.includes(val)) {
      errors.push(
        `Field "${fieldDef.label}" value "${val}" not in allowed values: [${fieldDef.values.join(', ')}]`
      );
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Semantic validation of an UPDATE operation.
 */
function validateUpdateSemantic(op, treeIndex, schemaResolver) {
  const errors   = [];
  const warnings = [];

  if (!treeIndex || !treeIndex[op.id]) {
    errors.push(`UPDATE: element "${op.id}" not found in tree`);
    return { valid: false, errors, warnings };
  }

  const elem   = treeIndex[op.id];
  const schema = schemaResolver ? schemaResolver(elem.component) : null;

  if (!schema) {
    warnings.push(`UPDATE: no schema for component "${elem.component}" — field check skipped`);
    return { valid: true, errors, warnings };
  }

  const fieldExists = schema.fields.some(f => f.label === op.field);
  if (!fieldExists) {
    errors.push(
      `UPDATE: field "${op.field}" does not exist in schema "${elem.component}"`
    );
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Semantic validation of UNMOUNT.
 */
function validateUnmountSemantic(op, treeIndex) {
  const errors   = [];
  const warnings = [];

  if (!treeIndex || !treeIndex[op.id]) {
    // Unmounting non-existent ID — idempotent, warn only
    warnings.push(`UNMOUNT: element "${op.id}" not found in tree (idempotent)`);
  }

  return { valid: true, errors, warnings };
}

/**
 * Full two-pass validation of an operation.
 * Returns combined result plus an !error or !warn line if needed.
 *
 * @returns {{ valid, errors, warnings, errorLine: string|null }}
 */
function validate(op, schema, treeIndex, schemaResolver) {
  // Pass 1
  const syntactic = validateSyntax(op);
  if (!syntactic.valid) {
    return {
      valid:     false,
      errors:    syntactic.errors,
      warnings:  [],
      errorLine: buildErrorLine(op, syntactic.errors.join('; ')),
    };
  }

  // Pass 2
  let semantic = { valid: true, errors: [], warnings: [] };

  if (op.type === '+') {
    semantic = validateMountSemantic(op, schema, treeIndex);
  } else if (op.type === '~') {
    semantic = validateUpdateSemantic(op, treeIndex, schemaResolver);
  } else if (op.type === '-') {
    semantic = validateUnmountSemantic(op, treeIndex);
  }

  const allErrors   = [...syntactic.errors,   ...semantic.errors];
  const allWarnings = [...semantic.warnings];

  let errorLine = null;
  if (allErrors.length > 0) {
    errorLine = buildErrorLine(op, allErrors.join('; '));
  } else if (allWarnings.length > 0) {
    errorLine = buildWarnLine(op, allWarnings.join('; '));
  }

  return {
    valid:     allErrors.length === 0,
    errors:    allErrors,
    warnings:  allWarnings,
    errorLine,
  };
}

// ─── Error Line Builders ──────────────────────────────────────────────────────

function buildErrorLine(op, reason) {
  const id        = op?.id || 'unknown';
  const component = op?.component || 'unknown';
  return `!error|id=${id}|component=${component}|reason=${escapeParam(reason)}`;
}

function buildWarnLine(op, reason) {
  const id = op?.id || 'unknown';
  return `!warn|id=${id}|reason=${escapeParam(reason)}`;
}

/**
 * FIX for schema downgrade (v3→v1): emit !warn with dropped fields list.
 */
function buildSchemaDowngradeWarn(elemId, droppedFields) {
  return `!warn|id=${elemId}|reason=schema_downgrade|dropped_fields=${droppedFields.join(',')}`;
}

function escapeParam(str) {
  return String(str).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

module.exports = {
  validateSyntax,
  validateMountSemantic,
  validateUpdateSemantic,
  validateUnmountSemantic,
  validate,
  buildErrorLine,
  buildWarnLine,
  buildSchemaDowngradeWarn,
};
