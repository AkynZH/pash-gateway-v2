'use strict';

const crypto = require('crypto');
const { SecurityPipeline } = require('@pash/security');

const securityPipeline = new SecurityPipeline({ strictMode: true });

/**
 * ComponentTree — the virtual UI state maintained by the gateway per session.
 *
 * Supports MOUNT, UPDATE, UNMOUNT with proper cascade semantics.
 *
 * Cascade delete policy (FIX from audit):
 *   When -[id] is received, ALL descendants are recursively deleted.
 *   Orphan prevention: no child can be mounted if parent no longer exists.
 *
 * Structure:
 *   nodes: Map<id, Node>
 *   children: Map<id, Set<childId>>  — parent→children index for O(1) traversal
 *
 * @example
 *   const tree = new ComponentTree();
 *   tree.mount({ id: 'root', component: 'Panel', fields: {}, parent: null });
 *   tree.mount({ id: 'card1', component: 'ProductCard', fields: {...}, parent: 'root' });
 *   tree.unmount('root'); // removes root AND card1
 *   tree.snapshot(); // → { hash, ts, nodes: [...] }
 */
class ComponentTree {
  constructor() {
    /** @type {Map<string, NodeData>} */
    this._nodes    = new Map();
    /** @type {Map<string, Set<string>>} */
    this._children = new Map();
    /** Monotonic sequence for ordering */
    this._seq      = 0;
  }

  // ─── Queries ───────────────────────────────────────────────────────────────

  get size() { return this._nodes.size; }

  has(id) { return this._nodes.has(id); }

  get(id) { return this._nodes.get(id) ?? null; }

  toIndex() {
    const out = Object.create(null);
    for (const [id, node] of this._nodes) out[id] = node;
    return out;
  }

  /** Returns all descendant IDs (breadth-first) including the root ID */
  descendants(rootId) {
    const result = [];
    const queue  = [rootId];
    while (queue.length) {
      const id = queue.shift();
      result.push(id);
      const kids = this._children.get(id);
      if (kids) for (const kid of kids) queue.push(kid);
    }
    return result;
  }

  // ─── Mutations ─────────────────────────────────────────────────────────────

  /**
   * Mount a component into the tree.
   * @returns {{ ok: boolean, error?: string }}
   */
  mount({ id, component, fields, parent = null, namedParams = {} }) {
    if (this._nodes.has(id)) {
      return { ok: false, error: `Element "${id}" already exists` };
    }
    if (parent && !this._nodes.has(parent)) {
      return { ok: false, error: `Parent "${parent}" not found` };
    }

    // Security check: inspect all fields for XSS and secrets
    const safeFields = {};
    for (const [key, value] of Object.entries(fields || {})) {
      safeFields[key] = securityPipeline.inspect(value);
    }

    this._nodes.set(id, {
      id,
      component,
      fields:  safeFields,
      parent,
      meta:    { ...namedParams },
      seq:     ++this._seq,
      mountedAt: Date.now(),
    });

    // Update children index
    if (!this._children.has(id)) this._children.set(id, new Set());
    if (parent) {
      if (!this._children.has(parent)) this._children.set(parent, new Set());
      this._children.get(parent).add(id);
    }

    return { ok: true };
  }

  /**
   * Update a single field on an existing element.
   * @returns {{ ok: boolean, error?: string, prev?: string }}
   */
  update(id, field, value) {
    const node = this._nodes.get(id);
    if (!node) return { ok: false, error: `Element "${id}" not found` };

    // Security check: inspect new value
    const safeValue = securityPipeline.inspect(value);

    const prev = node.fields[field];
    node.fields[field] = safeValue;
    node.updatedAt     = Date.now();

    return { ok: true, prev };
  }

  /**
   * Unmount an element and ALL its descendants (cascade delete).
   * FIX: spec left cascade policy undefined — we always cascade.
   *
   * @returns {{ ok: boolean, removed: string[], error?: string }}
   */
  unmount(id) {
    if (!this._nodes.has(id)) {
      // Idempotent — not an error, just a no-op with warning
      return { ok: true, removed: [], warning: `Element "${id}" not found (idempotent)` };
    }

    // Collect all descendants (BFS) before deletion
    const toRemove = this.descendants(id);

    for (const rid of toRemove) {
      const node = this._nodes.get(rid);
      if (node?.parent) {
        this._children.get(node.parent)?.delete(rid);
      }
      this._nodes.delete(rid);
      this._children.delete(rid);
    }

    return { ok: true, removed: toRemove };
  }

  /**
   * Apply a parsed PASH v2 operation directly to the tree.
   * Returns the result plus any !error/!warn lines to emit.
   * Catches SecurityPipeline violations and formats them as client-facing errors.
   */
  applyOp(op) {
    try {
      switch (op.type) {
        case '+': {
          const result = this.mount({
            id:         op.id,
            component:  op.component,
            fields:     op.fields ?? {},
            parent:     op.parent,
            namedParams: op.namedParams ?? {},
          });
          return {
            ...result,
            errorLine: result.ok ? null
              : `!error|id=${op.id}|component=${op.component}|reason=${result.error}`,
          };
        }

        case '~': {
          const result = this.update(op.id, op.field, op.value);
          return {
            ...result,
            errorLine: result.ok ? null
              : `!error|id=${op.id}|component=unknown|reason=${result.error}`,
          };
        }

        case '-': {
          const result = this.unmount(op.id);
          return {
            ...result,
            warnLine: result.warning
              ? `!warn|id=${op.id}|reason=${result.warning}`
              : null,
          };
        }

        default:
          return { ok: true, errorLine: null };
      }
    } catch (err) {
      if (err.message.startsWith('SECURITY_VIOLATION')) {
        return { 
          ok: false, 
          error: 'SECURITY_VIOLATION',
          errorLine: `!error|id=${op.id}|component=${op.component || 'unknown'}|reason=Security policy violation: ${err.message.replace('SECURITY_VIOLATION: ', '')}`
        };
      }
      throw err; // Re-throw unexpected errors
    }
  }

  // ─── Snapshot ──────────────────────────────────────────────────────────────

  /**
   * Create a deterministic snapshot of the current tree state.
   * FIX: hash algorithm is now explicitly SHA-256 of canonical JSON
   * (keys sorted alphabetically for determinism).
   *
   * @returns {{ hash: string, ts: number, size: number, nodes: Object[] }}
   */
  snapshot() {
    const nodes = Array.from(this._nodes.values())
      .sort((a, b) => a.seq - b.seq)
      .map(n => ({
        id:        n.id,
        component: n.component,
        fields:    sortKeys(n.fields),
        parent:    n.parent,
      }));

    const canonical = JSON.stringify(nodes);
    const hash      = crypto.createHash('sha256').update(canonical).digest('hex');

    return {
      hash,
      ts:    Date.now(),
      size:  this._nodes.size,
      nodes,
    };
  }

  /**
   * Restore tree from snapshot data.
   * Used for Resume after disconnect.
   */
  restoreFromSnapshot(snapshot) {
    this._nodes.clear();
    this._children.clear();
    this._seq = 0;

    // Restore in seq order (parents before children)
    for (const node of snapshot.nodes ?? []) {
      this.mount({
        id:        node.id,
        component: node.component,
        fields:    node.fields ?? {},
        parent:    node.parent,
      });
    }
  }

  /**
   * Verify a client-provided hash matches current state.
   * Used in Resume handshake.
   */
  verifyHash(clientHash) {
    const { hash } = this.snapshot();
    return hash === clientHash;
  }
}

function sortKeys(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

module.exports = { ComponentTree };
