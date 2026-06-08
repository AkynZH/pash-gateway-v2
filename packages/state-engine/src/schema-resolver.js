'use strict';

const { buildSchemaDowngradeWarn } = require('@pash/protocol');

/**
 * SchemaResolver — resolves and version-negotiates component schemas.
 *
 * FIX (audit): Schema downgrade (v3→v1) now emits !warn with dropped_fields.
 * FIX (audit): Client cannot claim schemas without server validation.
 *
 * Registry structure:
 *   { ComponentName: { [version]: SchemaDefinition } }
 *
 * Resolution algorithm:
 *   1. Find requested version exactly
 *   2. If not found, find highest version ≤ requested (downgrade)
 *   3. If downgrade occurred, emit !warn with dropped fields
 *   4. If no compatible version, return null
 */
class SchemaResolver {
  constructor() {
    /** @type {Map<string, Map<number, Object>>} component → version → schema */
    this._registry = new Map();
  }

  /**
   * Register a schema version.
   * @param {string} componentName
   * @param {number} version
   * @param {Object} schema - { fields: FieldDef[], metadata?: Object }
   */
  register(componentName, version, schema) {
    if (!this._registry.has(componentName)) {
      this._registry.set(componentName, new Map());
    }
    this._registry.get(componentName).set(version, {
      ...schema,
      _version: version,
      _component: componentName,
    });
  }

  /**
   * Resolve a schema with version negotiation.
   *
   * @param {string} componentName
   * @param {number} requestedVersion
   * @param {string} elemId - for !warn line generation
   * @returns {{ schema: Object|null, warnLine: string|null, actualVersion: number|null }}
   */
  resolve(componentName, requestedVersion = 1, elemId = 'unknown') {
    const versions = this._registry.get(componentName);
    if (!versions || versions.size === 0) {
      return { schema: null, warnLine: null, actualVersion: null };
    }

    // Exact match
    if (versions.has(requestedVersion)) {
      return {
        schema:        versions.get(requestedVersion),
        warnLine:      null,
        actualVersion: requestedVersion,
      };
    }

    // Find highest version ≤ requestedVersion (downgrade)
    const available     = Array.from(versions.keys()).sort((a, b) => b - a);
    const degradeTarget = available.find(v => v <= requestedVersion);

    if (!degradeTarget) {
      return { schema: null, warnLine: null, actualVersion: null };
    }

    // Determine dropped fields (fields in requested that don't exist in degradeTarget)
    const targetSchema  = versions.get(degradeTarget);
    const requestedSch  = versions.get(Math.max(...available)); // highest known
    const targetLabels  = new Set(targetSchema.fields.map(f => f.label));
    const droppedFields = (requestedSch?.fields ?? [])
      .map(f => f.label)
      .filter(l => !targetLabels.has(l));

    const warnLine = droppedFields.length > 0
      ? buildSchemaDowngradeWarn(elemId, droppedFields)
      : `!warn|id=${elemId}|reason=schema_downgrade|from=${requestedVersion}|to=${degradeTarget}`;

    return {
      schema:        targetSchema,
      warnLine,
      actualVersion: degradeTarget,
    };
  }

  /**
   * Validate a client-provided schema introspection against server registry.
   * FIX: Client cannot self-certify schemas — server always validates.
   *
   * @param {Object[]} clientSchemas - [{ name, version, fields }]
   * @returns {{ valid: boolean, negotiated: Object[], warnings: string[] }}
   */
  negotiateCapabilities(clientSchemas) {
    const negotiated = [];
    const warnings   = [];

    for (const claimed of clientSchemas) {
      const { schema, warnLine, actualVersion } = this.resolve(
        claimed.name,
        claimed.version ?? 1,
        `cap_${claimed.name}`
      );

      if (!schema) {
        warnings.push(`Unknown component "${claimed.name}" — will use fallback rendering`);
        continue;
      }

      if (warnLine) warnings.push(warnLine);

      negotiated.push({
        name:           claimed.name,
        requestedVersion: claimed.version,
        actualVersion,
        schema,
        degraded: actualVersion !== claimed.version,
      });
    }

    return { valid: true, negotiated, warnings };
  }

  /**
   * Get all registered component names.
   */
  listComponents() {
    return Array.from(this._registry.keys());
  }

  /**
   * Resolve by component name only — returns highest registered version.
   */
  resolveLatest(componentName) {
    const versions = this._registry.get(componentName);
    if (!versions || versions.size === 0) return null;
    const latest = Math.max(...versions.keys());
    return versions.get(latest);
  }
}

module.exports = { SchemaResolver };
