'use strict';

const { UpstreamClient }        = require('../services/upstream');
const { PromptInjector }        = require('../services/prompt-injector');
const { StreamGuard, BillingCounter } = require('@pash/billing');
const { getRedis }              = require('../services/redis');
const { dispatcher: webhookDispatcher } = require('../services/webhook');
const { 
  preRequestLocLimit, 
  createLocTrackingStream 
} = require('../middleware/loc-limiter');
const config                    = require('../config');

/**
 * POST /v1/chat/completions
 *
 * Drop-in replacement for OpenAI /v1/chat/completions.
 * Client only needs to change baseURL.
 *
 * Handles:
 *   - PASH prompt injection (per-provider caching strategy)
 *   - Streaming (SSE) and non-streaming modes
 *   - Mid-stream billing enforcement
 *   - Client disconnect → abort upstream
 *   - Circuit breaker failover with prompt re-injection
 */
async function completionsRoute(fastify, opts) {
  const { injector, circuitBreaker, sessionManager } = opts;
  const counter = new BillingCounter(getRedis());

  fastify.post('/v1/chat/completions', {
    config: { requireAuth: true },
    preHandler: [preRequestLocLimit],
    schema: {
      body: {
        type: 'object',
        required: ['messages'],
        properties: {
          model:       { type: 'string' },
          messages:    { type: 'array' },
          stream:      { type: 'boolean' },
          temperature: { type: 'number' },
          max_tokens:  { type: 'number' },
        },
      },
    },
  }, async (request, reply) => {
    const { orgId, providerKey, lineLimit, linesUsed, governance = {}, webhookUrl } = request.pashContext;
    const body    = request.body;
    const model   = body.model ?? 'openai/gpt-4o';
    const isStream = body.stream !== false; // default: streaming

    // ── Inject PASH prompt ──────────────────────────────────────────────────
    const injectedMessages = injector.inject(body.messages, model);
    const upstreamBody     = { ...body, messages: injectedMessages };

    // ── Determine provider from model name ───────────────────────────────────
    const providerName = detectProviderName(model);

    // Governance: hard limit for max lines per session/stream (prevents infinite generation)
    const effectiveLimit = governance.maxLines ? Math.min(lineLimit, governance.maxLines) : lineLimit;

    if (isStream) {
      return handleStream(request, reply, {
        upstreamBody, providerKey, providerName, model,
        orgId, lineLimit: effectiveLimit, linesUsed, counter,
        circuitBreaker, injector, governance, webhookUrl,
      });
    } else {
      return handleSync(request, reply, {
        upstreamBody, providerKey, providerName,
        orgId, counter, governance, webhookUrl,
        circuitBreaker, injector,
      });
    }
  });
}

// ─── Streaming Handler ────────────────────────────────────────────────────────

async function handleStream(request, reply, opts) {
  const { upstreamBody, providerKey, providerName, orgId,
          lineLimit, linesUsed, counter, circuitBreaker, injector, governance, webhookUrl } = opts;

  // FIX (audit #10): AbortController for client disconnect
  const abortController = new AbortController();

  // Detect client disconnect
  request.raw.on('close', () => {
    if (!reply.sent) abortController.abort('client_disconnect');
  });

  reply.raw.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const guard = new StreamGuard({
    orgId,
    limit:        lineLimit,
    currentCount: linesUsed,
  });

  let currentProvider = providerName;
  let currentBody     = { ...upstreamBody };
  let didFailover     = false;

  try {
    // FIX (audit #4 / CB): On failover, re-inject PASH prompt for new provider
    const response = await circuitBreaker.executeWithFailover(
      async (provider) => {
        currentProvider = provider;
        const client = new UpstreamClient({ providerApiKey: providerKey, providerName: provider });
        return client.fetchStream(currentBody, abortController.signal);
      },
      (newProvider) => {
        didFailover = true;
        // Re-inject PASH prompt for the new provider
        request.log.warn({ msg: 'Failover: re-injecting PASH prompt', provider: newProvider });
        const reinjected   = injector.inject(upstreamBody.messages, newProvider);
        currentBody        = { ...upstreamBody, messages: reinjected };
      }
    );

    // Dispatch systemic webhook for failover
    if (didFailover && webhookUrl) {
      webhookDispatcher.dispatch(orgId, 'pash.provider.failover', {
        fromProvider: providerName,
        toProvider: currentProvider,
      });
    }

    const utf8   = new TextDecoder();
    
    // Integrating LoC tracking stream
    const locTracker = createLocTrackingStream(request);
    const transformedReader = response.body.pipeThrough(locTracker).getReader();

    while (true) {
      let chunk;
      try {
        const res = await transformedReader.read();
        if (res.done) break;
        chunk = res.value;
      } catch (err) {
        if (abortController.signal.aborted) break; // client disconnected or limit reached
        throw err;
      }

      const text   = typeof chunk === 'string' ? chunk : utf8.decode(chunk, { stream: true });
      
      // Check if the chunk contains our limit-exceeded marker
      if (text.includes('!error|reason=community_limit_exceeded')) {
        reply.raw.write(text);
        reply.raw.write('data: [DONE]\n\n');
        abortController.abort('limit_exceeded');
        
        if (webhookUrl) {
          webhookDispatcher.dispatch(orgId, 'pash.limit.exceeded', {
            linesUsed: guard.totalSession,
            limit: lineLimit,
          });
        }
        break;
      }

      const result = guard.push(text);

      // FIX (audit #11): Mid-stream limit enforcement — structured error event
      if (result.shouldStop) {
        if (result.limitLine) {
          reply.raw.write(result.limitLine);
        }
        reply.raw.write('data: [DONE]\n\n');
        abortController.abort('limit_exceeded');

        // Dispatch systemic webhook for limit exceeded
        if (webhookUrl) {
          webhookDispatcher.dispatch(orgId, 'pash.limit.exceeded', {
            linesUsed: guard.totalSession,
            limit: lineLimit,
          });
        }
        break;
      }

      reply.raw.write(text);
    }

    // Flush remaining buffer
    const finalLines = guard.flush();

    // Persist line count to Redis
    if (finalLines > 0) {
      await counter.increment(orgId, finalLines).catch(err => {
        request.log.error({ msg: 'Failed to persist line count', err: err.message });
      });
    }

    circuitBreaker.recordSuccess(currentProvider);

  } catch (err) {
    if (!abortController.signal.aborted) {
      request.log.error({ msg: 'Stream error', err: err.message, provider: currentProvider });
      circuitBreaker.recordFailure(currentProvider, err);

      if (!reply.raw.headersSent) {
        reply.raw.writeHead(502, { 'Content-Type': 'application/json' });
        reply.raw.write(JSON.stringify({ error: 'Upstream error', details: err.message }));
      } else {
        // Already streaming — send error event
        reply.raw.write(`data: ${JSON.stringify({ error: 'STREAM_ERROR', message: err.message })}\n\n`);
        reply.raw.write('data: [DONE]\n\n');
        
        // Dispatch systemic webhook for error
        if (webhookUrl) {
          webhookDispatcher.dispatch(orgId, 'pash.error', {
            type: 'stream_error',
            provider: currentProvider,
            message: err.message,
          });
        }
      }
    }
  } finally {
    reply.raw.end();
  }
}

// ─── Sync (non-streaming) Handler ────────────────────────────────────────────

async function handleSync(request, reply, opts) {
  const { upstreamBody, providerKey, providerName,
          orgId, counter, circuitBreaker, injector } = opts;

  let currentProvider = providerName;
  let currentBody     = { ...upstreamBody };

  try {
    const data = await circuitBreaker.executeWithFailover(
      async (provider) => {
        currentProvider = provider;
        const client = new UpstreamClient({ providerApiKey: providerKey, providerName: provider });
        return client.fetchSync(currentBody);
      },
      (newProvider) => {
        // Re-inject for failover
        const reinjected = injector.inject(upstreamBody.messages, newProvider);
        currentBody      = { ...upstreamBody, messages: reinjected };
      }
    );

    // Count any PASH lines in non-streaming response
    const content = data?.choices?.[0]?.message?.content ?? '';
    const lines   = countPashLines(content);
    if (lines > 0) {
      await counter.increment(orgId, lines).catch(() => {});
    }

    circuitBreaker.recordSuccess(currentProvider);
    return reply.send(data);

  } catch (err) {
    circuitBreaker.recordFailure(currentProvider, err);
    request.log.error({ msg: 'Sync request error', err: err.message });
    return reply.code(502).send({ error: 'Upstream error', details: err.message });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function detectProviderName(model) {
  if (!model) return 'openrouter';
  const m = model.toLowerCase();
  if (m.startsWith('claude'))  return 'anthropic';
  if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3')) return 'openai';
  return 'openrouter';
}

function countPashLines(text) {
  return (text.split('\n') || [])
    .filter(l => l.trim() && ['+', '~', '-'].includes(l.trim()[0]))
    .length;
}

module.exports = completionsRoute;
