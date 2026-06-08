'use strict';

const { AuthService } = require('../services/auth');
const { BillingCounter } = require('@pash/billing');
const { getRedis }    = require('../services/redis');
const config          = require('../config');

/**
 * buildAuthMiddleware — Fastify preHandler that:
 *   1. Validates PASH_API_KEY from Authorization header
 *   2. Extracts optional X-PASH-Provider-Key (BYOK)
 *   3. Checks line limit BEFORE allowing request through (pre-check fix)
 *   4. Attaches org context to request
 *
 * FIX (audit #2): Provider key extracted and masked; never logged.
 * FIX (audit #6): Pre-check billing limit before upstream fetch.
 */
function buildAuthMiddleware(db) {
  const auth    = new AuthService(db);
  const counter = new BillingCounter(getRedis());

  return async function authMiddleware(request, reply) {
    // ── Extract PASH API Key ─────────────────────────────────────────────────
    const authHeader = request.headers['authorization'] ?? '';
    if (!authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Missing Authorization header' });
    }

    const pashKey = authHeader.slice(7).trim();
    const org     = await auth.verify(pashKey);

    if (!org.valid) {
      return reply.code(401).send({ error: 'Invalid or revoked API key', reason: org.reason });
    }

    // ── Extract Provider Key (BYOK) ──────────────────────────────────────────
    // FIX: Key extracted, NEVER logged — only first 4 chars logged for tracing
    const providerKey = request.headers['x-pash-provider-key'] ?? null;
    if (providerKey) {
      request.log.info({
        msg:    'BYOK key provided',
        prefix: AuthService.maskKey(providerKey),
        // FIX: the actual key is NOT in the log
      });
    }

    // Determine which API key to use for upstream
    const effectiveProviderKey = providerKey
      ?? config.providers.openrouter.apiKey
      ?? config.providers.openai.apiKey;

    if (!effectiveProviderKey) {
      return reply.code(402).send({
        error: 'No provider key available. Pass X-PASH-Provider-Key header or configure gateway key.',
      });
    }

    // ── Pre-check Billing Limit ──────────────────────────────────────────────
    // FIX (audit #6): Check BEFORE initiating upstream — provider doesn't get called if over limit
    const limitCheck = await counter.checkLimit(org.orgId, org.lineLimit);
    if (!limitCheck.allowed) {
      return reply.code(402).send({
        error:      'PASH_LIMIT_EXCEEDED',
        lines_used: limitCheck.current,
        limit:      limitCheck.limit,
        message:    'Monthly PASH line limit reached. Upgrade your plan.',
      });
    }

    // ── Attach to request ────────────────────────────────────────────────────
    request.pashContext = {
      orgId:            org.orgId,
      plan:             org.plan,
      lineLimit:        org.lineLimit,
      linesUsed:        limitCheck.current,
      linesRemaining:   limitCheck.remaining,
      providerKey:      effectiveProviderKey,  // FIX: stored in context, not re-read from headers
      isByok:           !!providerKey,
    };
  };
}

module.exports = { buildAuthMiddleware };
