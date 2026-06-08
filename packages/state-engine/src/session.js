'use strict';

const { ComponentTree }  = require('./tree');
const { SchemaResolver } = require('./schema-resolver');
const crypto             = require('crypto');

/**
 * SessionManager — manages per-connection UI state.
 *
 * Each session has:
 *   - A ComponentTree (virtual DOM)
 *   - A SchemaResolver (negotiated capabilities)
 *   - Line counter (for billing)
 *   - Snapshot for Resume after disconnect
 *
 * FIX (audit): Snapshots stored in external store (Redis/KV), not in-process memory.
 *              In-process map is only a fast index of metadata.
 *              Full snapshot is persisted to snapshotStore.
 *
 * FIX (audit): Line counter is per-session; final flush goes to Redis INCR.
 */
class SessionManager {
  /**
   * @param {Object} opts
   * @param {Object} opts.snapshotStore       - { save(sessionId, snapshot), load(sessionId) }
   * @param {Object} opts.observabilityStore  - { append(sessionId, entry), getLogs(sessionId) }
   * @param {Object} opts.lineCounter         - { increment(orgId, count) } async
   * @param {number} opts.snapshotTtlMs       - snapshot TTL in ms (default: 30 minutes)
   */
  constructor(opts = {}) {
    this._snapshotStore = opts.snapshotStore       ?? memoryStore();
    this._obsStore      = opts.observabilityStore  ?? memoryObsStore();
    this._lineCounter   = opts.lineCounter         ?? noopCounter();
    this._snapshotTtl   = opts.snapshotTtlMs       ?? 30 * 60 * 1000;

    /** Fast in-process index: sessionId → SessionMeta */
    this._sessions = new Map();
  }

  // ─── Session Lifecycle ─────────────────────────────────────────────────────

  /**
   * Create a new session.
   * @param {Object} opts
   * @param {string} opts.orgId
   * @param {string} opts.apiKeyId
   * @param {string} [opts.env]      - 'dev', 'staging', 'prod'
   * @param {Object[]} opts.clientSchemas   - from /v1/presentation/init
   * @param {SchemaResolver} opts.baseSchemas - server-side base schemas
   * @param {string} [opts.webhookUrl]      - optional callback for async events (Stage 5)
   * @param {Object} [opts.governance]      - { maxLines, allowedComponents, blockedComponents }
   * @returns {Session}
   */
  create({ orgId, apiKeyId, env = 'prod', clientSchemas = [], baseSchemas = null, webhookUrl = null, governance = {} }) {
    const sessionId = generateSessionId();
    const resolver  = baseSchemas ?? new SchemaResolver();
    const { negotiated, warnings } = resolver.negotiateCapabilities(clientSchemas);

    const session = {
      id:          sessionId,
      orgId,
      apiKeyId,
      env,
      webhookUrl,
      governance:  governance || {},
      createdAt:   Date.now(),
      lastActiveAt: Date.now(),
      tree:        new ComponentTree(governance),
      resolver,
      negotiated,
      capWarnings: warnings,
      lineCount:   0,      // lines generated this session (flushed to Redis on close)
      tokensSaved: 0,      // billing: estimated savings
    };

    this._sessions.set(sessionId, session);
    return session;
  }

  /**
   * Get an active session.
   * @returns {Session|null}
   */
  get(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return null;
    session.lastActiveAt = Date.now();
    return session;
  }

  /**
   * Close a session: flush line count to Redis, persist final snapshot, and trigger webhook.
   */
  async close(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return;

    // Persist final snapshot for potential resume
    const snapshot = session.tree.snapshot();
    await this._snapshotStore.save(sessionId, snapshot, this._snapshotTtl);

    // Flush line count to distributed counter
    if (session.lineCount > 0) {
      await this._lineCounter.increment(session.orgId, session.lineCount);
    }

    // Stage 5: Trigger webhook if configured
    if (session.webhookUrl) {
      this._triggerWebhook(session.webhookUrl, {
        event: 'session.closed',
        sessionId,
        orgId: session.orgId,
        stats: {
          linesGenerated: session.lineCount,
          tokensSaved: session.tokensSaved,
          finalTreeSize: snapshot.size,
        },
        snapshotHash: snapshot.hash,
      }).catch(err => {
        // Log error but do not fail the close operation
        console.error(`[SessionManager] Webhook failed for ${sessionId}:`, err.message);
      });
    }

    this._sessions.delete(sessionId);
    return { linesGenerated: session.lineCount, finalSnapshot: snapshot };
  }

  /**
   * Fire-and-forget webhook delivery.
   */
  async _triggerWebhook(url, payload) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000), // 5s timeout
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (err) {
      // Re-throw to be caught by the caller's .catch()
      throw new Error(`Webhook delivery failed: ${err.message}`);
    }
  }

  // ─── Resume (Reconnect) ────────────────────────────────────────────────────

  /**
   * Resume a disconnected session from persisted snapshot.
   * FIX (audit): Snapshot stored externally (KV), not in-process.
   *
   * @param {string} sessionId
   * @param {string} clientHash - client's last known state hash
   * @returns {{ session, resumed: boolean, hashMatch: boolean, warnLine?: string }}
   */
  async resume(sessionId, clientHash) {
    // Check if session still active in-process
    const existing = this._sessions.get(sessionId);
    if (existing) {
      const hashMatch = existing.tree.verifyHash(clientHash);
      return { session: existing, resumed: false, hashMatch };
    }

    // Try to restore from persistent store
    const snapshot = await this._snapshotStore.load(sessionId);
    if (!snapshot) {
      return { session: null, resumed: false, hashMatch: false,
               warnLine: `!warn|id=session|reason=snapshot_expired|session=${sessionId}` };
    }

    // Verify snapshot hash matches client's last known state
    const hashMatch = snapshot.hash === clientHash;

    // Reconstruct session with restored tree
    const session = {
      id:          sessionId,
      orgId:       snapshot.orgId ?? 'unknown',
      apiKeyId:    snapshot.apiKeyId ?? 'unknown',
      createdAt:   snapshot.createdAt ?? Date.now(),
      lastActiveAt: Date.now(),
      tree:        new ComponentTree(),
      resolver:    new SchemaResolver(),
      negotiated:  snapshot.negotiated ?? [],
      capWarnings: [],
      lineCount:   0,
      tokensSaved: snapshot.tokensSaved ?? 0,
      resumedFrom: snapshot.hash,
    };

    session.tree.restoreFromSnapshot(snapshot);
    this._sessions.set(sessionId, session);

    return {
      session,
      resumed:   true,
      hashMatch,
      warnLine: hashMatch ? null
        : `!warn|id=session|reason=hash_mismatch|expected=${snapshot.hash}|received=${clientHash}`,
    };
  }

  // ─── Line Counting (Billing) ───────────────────────────────────────────────

  /**
   * Increment line count for a session.
   * Batches in-memory; flushes to Redis on session close or every N lines.
   */
  async incrementLines(sessionId, count = 1) {
    const session = this._sessions.get(sessionId);
    if (!session) return;

    session.lineCount += count;

    // Flush to Redis every 100 lines to reduce write pressure
    if (session.lineCount % 100 === 0) {
      await this._lineCounter.increment(session.orgId, count);
    }
  }

  // ─── Snapshot Directives ──────────────────────────────────────────────────

  /**
   * Save a snapshot and return the @snapshot directive line.
   */
  async saveSnapshot(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return null;

    const snapshot = session.tree.snapshot();
    await this._snapshotStore.save(sessionId, snapshot, this._snapshotTtl);

    return `@snapshot|hash=${snapshot.hash}|ts=${snapshot.ts}|size=${snapshot.size}`;
  }

  // ─── Stats ────────────────────────────────────────────────────────────────

  activeSessions() { return this._sessions.size; }

  stats(sessionId) {
    const s = this._sessions.get(sessionId);
    if (!s) return null;
    return {
      id:          s.id,
      orgId:       s.orgId,
      treeSize:    s.tree.size,
      lineCount:   s.lineCount,
      tokensSaved: s.tokensSaved,
      ageMs:       Date.now() - s.createdAt,
    };
  }

  // ─── Observability & Replay ───────────────────────────────────────────────

  /**
   * Log an observability event for a session.
   * @param {string} sessionId
   * @param {'raw' | 'constraint' | 'pash' | 'snapshot'} level
   * @param {Object} data
   */
  async logEvent(sessionId, level, data) {
    await this._obsStore.append(sessionId, {
      ts: Date.now(),
      level,
      ...data,
    });
  }

  /**
   * Replay Engine: Reconstructs the UI tree at a specific step.
   * @param {string} sessionId
   * @param {number} targetStep
   * @returns {Promise<Object>}
   */
  async replay(sessionId, targetStep) {
    const logs = await this._obsStore.getLogs(sessionId);
    if (!logs || logs.length === 0) {
      return { error: 'No logs found for session', sessionId };
    }

    // Filter only PASH operations (level: 'pash') to rebuild the tree
    const pashOps = logs.filter(l => l.level === 'pash' && l.op);
    const totalSteps = pashOps.length;
    
    // Clamp targetStep to valid range
    const step = Math.max(0, Math.min(targetStep, totalSteps));
    
    // Rebuild tree up to `step`
    const tree = new ComponentTree();
    for (let i = 0; i < step; i++) {
      tree.applyOp(pashOps[i].op);
    }

    const snapshot = tree.snapshot();

    return {
      snapshot,
      logs: logs.slice(0, step + 1),
      step,
      totalSteps,
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateSessionId() {
  return 'sess_' + crypto.randomBytes(16).toString('hex');
}

/** In-memory snapshot store for testing / single-node development */
function memoryStore() {
  const store = new Map();
  return {
    async save(id, snapshot, ttlMs) {
      store.set(id, { snapshot, expiresAt: Date.now() + ttlMs });
      // Cleanup expired
      for (const [k, v] of store) {
        if (v.expiresAt < Date.now()) store.delete(k);
      }
    },
    async load(id) {
      const entry = store.get(id);
      if (!entry) return null;
      if (entry.expiresAt < Date.now()) { store.delete(id); return null; }
      return entry.snapshot;
    },
  };
}

function noopCounter() {
  return { async increment() {} };
}

/**
 * In-memory observability store for 4-level logging (Raw, Constraint, PASH, Snapshot).
 * Uses a ring buffer to prevent memory leaks in long-running sessions.
 */
function memoryObsStore(maxEntries = 1000) {
  const store = new Map();
  return {
    async append(sessionId, entry) {
      if (!store.has(sessionId)) store.set(sessionId, []);
      const logs = store.get(sessionId);
      logs.push(entry);
      // Ring buffer: keep only last N entries
      if (logs.length > maxEntries) logs.shift();
    },
    async getLogs(sessionId) {
      return store.get(sessionId) ?? [];
    },
    async clear(sessionId) {
      store.delete(sessionId);
    },
  };
}

/**
 * Replay Engine: Reconstructs the UI tree at a specific step.
 * @param {string} sessionId
 * @param {number} targetStep - The step index to replay to (0 = initial state)
 * @returns {{ snapshot: Object, logs: Array, step: number, totalSteps: number }}
 */
async function replaySession(sessionId, targetStep, obsStore, snapshotStore) {
  const logs = await obsStore.getLogs(sessionId);
  if (!logs || logs.length === 0) {
    return { error: 'No logs found for session', sessionId };
  }

  // Filter only PASH operations (level: 'pash') to rebuild the tree
  const pashOps = logs.filter(l => l.level === 'pash' && l.op);
  const totalSteps = pashOps.length;
  
  // Clamp targetStep to valid range
  const step = Math.max(0, Math.min(targetStep, totalSteps));
  
  // Rebuild tree up to `step`
  const tree = new (require('./tree').ComponentTree)();
  for (let i = 0; i < step; i++) {
    tree.applyOp(pashOps[i].op);
  }

  const snapshot = tree.snapshot();

  return {
    snapshot,
    logs: logs.slice(0, step + 1), // Return logs up to this step
    step,
    totalSteps,
  };
}

module.exports = { SessionManager, replaySession };
