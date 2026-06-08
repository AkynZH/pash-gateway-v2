'use strict';

const { replaySession } = require('@pash/state-engine');

/**
 * POST /v1/presentation/init
 *
 * Runtime Handshake — client declares supported components,
 * server negotiates versions and returns session context.
 *
 * FIX (audit #2): Client cannot self-certify schemas.
 *   Server always validates against its registry.
 *   Unknown components get a warning, not an error.
 *
 * FIX (audit #3): Schema degrade emits !warn with dropped_fields.
 *
 * Request body:
 * {
 *   "schemas": [{ "name": "ProductCard", "version": 2 }],
 *   "resume":  { "sessionId": "sess_...", "stateHash": "sha256..." }
 * }
 *
 * Response:
 * {
 *   "sessionId": "sess_...",
 *   "negotiated": [...],
 *   "warnings": ["!warn|..."],
 *   "resumed": false
 * }
 */
async function presentationRoute(fastify, opts) {
  const { sessionManager, baseSchemas } = opts;

  fastify.post('/v1/presentation/init', {
    config: { requireAuth: true },
    schema: {
      body: {
        type: 'object',
        properties: {
          schemas: { type: 'array', default: [] },
          webhookUrl: { type: 'string', format: 'uri' }, // Stage 5: Async task callbacks
          resume:  {
            type: 'object',
            properties: {
              sessionId: { type: 'string' },
              stateHash: { type: 'string' },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { orgId, apiKeyId = 'unknown', env, governance = {} } = request.pashContext;
    const { schemas = [], webhookUrl, resume } = request.body;

    // ── Resume existing session ────────────────────────────────────────────
    if (resume?.sessionId) {
      const { session, resumed, hashMatch, warnLine } =
        await sessionManager.resume(resume.sessionId, resume.stateHash);

      if (!session) {
        return reply.code(404).send({
          error:   'Session not found or snapshot expired',
          warnLine,
        });
      }

      return reply.send({
        sessionId:  session.id,
        negotiated: session.negotiated ?? [],
        warnings:   warnLine ? [warnLine] : [],
        resumed,
        hashMatch,
        treeSize:   session.tree.size,
      });
    }

    // ── Create new session ────────────────────────────────────────────────
    const session = sessionManager.create({
      orgId,
      apiKeyId,
      env,
      clientSchemas: schemas,
      baseSchemas,
      webhookUrl,
      governance,
    });

    return reply.send({
      sessionId:  session.id,
      negotiated: session.negotiated,
      warnings:   session.capWarnings,
      resumed:    false,
      hashMatch:  null,
      treeSize:   0,
    });
  });

  // ── GET /v1/presentation/session/:id/state ─────────────────────────────
  fastify.get('/v1/presentation/session/:id/state', {
    config: { requireAuth: true },
  }, async (request, reply) => {
    const { id } = request.params;
    const snap   = await sessionManager.saveSnapshot(id);

    if (!snap) {
      return reply.code(404).send({ error: 'Session not found' });
    }

    const stats = sessionManager.stats(id);
    return reply.send({ snapshot: snap, stats });
  });

  // ── GET /v1/presentation/replay/:id ─────────────────────────────────────
  fastify.get('/v1/presentation/replay/:id', {
    config: { requireAuth: true },
  }, async (request, reply) => {
    const { id } = request.params;
    const targetStep = parseInt(request.query.step || '0', 10);

    // Access the obsStore via sessionManager's internal reference (or expose it)
    // For now, we'll pass a dummy or we can expose it from sessionManager
    // Let's add getObsStore to sessionManager or just use sessionManager directly if we update it.
    // Actually, let's just make sessionManager expose a replay method.
    
    const result = await sessionManager.replay(id, targetStep);
    
    if (result.error) {
      return reply.code(404).send({ error: result.error });
    }

    return reply.send({
      sessionId: id,
      step: result.step,
      totalSteps: result.totalSteps,
      snapshot: result.snapshot,
      logs: result.logs,
    });
  });

  // ── DELETE /v1/presentation/session/:id ───────────────────────────────
  fastify.delete('/v1/presentation/session/:id', {
    config: { requireAuth: true },
  }, async (request, reply) => {
    const { id }  = request.params;
    const result  = await sessionManager.close(id);

    if (!result) {
      return reply.code(404).send({ error: 'Session not found' });
    }

    return reply.send({ closed: true, ...result });
  });
}

module.exports = presentationRoute;
