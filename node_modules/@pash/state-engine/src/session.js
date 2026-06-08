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
   * @param {Object} opts.snapshotStore  - { save(sessionId, snapshot), load(sessionId) }
   * @param {Object} opts.lineCounter    - { increment(orgId, count) } async
   * @param {number} opts.snapshotTtlMs  - snapshot TTL in ms (default: 30 minutes)
   */
  constructor(opts = {}) {
    this._snapshotStore = opts.snapshotStore   ?? memoryStore();
    this._lineCounter   = opts.lineCounter      ?? noopCounter();
    this._snapshotTtl   = opts.snapshotTtlMs   ?? 30 * 60 * 1000;

    /** Fast in-process index: sessionId → SessionMeta */
    this._sessions = new Map();
  }

  // ─── Session Lifecycle ─────────────────────────────────────────────────────

  /**
   * Create a new session.
   * @param {Object} opts
   * @param {string} opts.orgId
   * @param {string} opts.apiKeyId
   * @param {Object[]} opts.clientSchemas   - from /v1/presentation/init
   * @param {SchemaResolver} opts.baseSchemas - server-side base schemas
   * @returns {Session}
   */
  create({ orgId, apiKeyId, clientSchemas = [], baseSchemas = null }) {
    const sessionId = generateSessionId();
    const resolver  = baseSchemas ?? new SchemaResolver();
    const { negotiated, warnings } = resolver.negotiateCapabilities(clientSchemas);

    const session = {
      id:          sessionId,
      orgId,
      apiKeyId,
      createdAt:   Date.now(),
      lastActiveAt: Date.now(),
      tree:        new ComponentTree(),
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
   * Close a session: flush line count to Redis and persist final snapshot.
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

    this._sessions.delete(sessionId);
    return { linesGenerated: session.lineCount, finalSnapshot: snapshot };
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

module.exports = { SessionManager };
