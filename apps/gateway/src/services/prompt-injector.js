'use strict';

const PASH_SIGNATURE = '# PASH_PROTOCOL_BLOCK_V2';

/**
 * PromptInjector — injects PASH system prompt into LLM messages array.
 *
 * FIX (audit #7): Different caching strategies per provider:
 *   - Anthropic: uses cache_control marker for explicit prompt caching
 *   - OpenAI:    caching is automatic for stable prefixes
 *   - Others:    prefix placement for best-effort caching
 *
 * FIX (audit #8): Double-injection prevention — checks for PASH signature.
 *
 * FIX (audit): PASH block must be IDENTICAL across all requests for caching.
 *              It is generated once per gateway startup, then reused.
 */
class PromptInjector {
  /**
   * @param {Object} opts
   * @param {string} opts.pashBlock  - pre-generated PASH system prompt (static)
   * @param {string} opts.placement  - 'prefix' | 'suffix'
   */
  constructor({ pashBlock, placement = 'prefix' }) {
    if (!pashBlock) throw new Error('PromptInjector: pashBlock required');
    this._pashBlock = pashBlock;
    this._placement = placement;
  }

  /**
   * Inject PASH block into messages array.
   * Detects provider from model name to apply correct caching strategy.
   *
   * @param {Object[]} messages  - original messages array
   * @param {string}   model     - model identifier (e.g. "gpt-4o", "claude-3-5-sonnet")
   * @returns {Object[]} modified messages (never mutates original)
   */
  inject(messages, model) {
    const provider = detectProvider(model);
    const msgs     = messages.map(m => ({ ...m })); // shallow copy

    // FIX: Double-injection guard
    const systemIdx = msgs.findIndex(m => m.role === 'system');
    if (systemIdx !== -1 && msgs[systemIdx].content?.includes(PASH_SIGNATURE)) {
      // Already injected — log warning but don't inject again
      console.warn('[PromptInjector] Double injection prevented for model:', model);
      return msgs;
    }

    switch (provider) {
      case 'anthropic':
        return this._injectAnthropic(msgs);
      case 'openai':
        return this._injectOpenAI(msgs);
      default:
        return this._injectGeneric(msgs);
    }
  }

  /**
   * Anthropic strategy: explicit cache_control marker.
   * PASH block goes as the FIRST system content block with cache_control.
   * Client's system message follows as a separate block.
   *
   * Anthropic prompt caching docs:
   * https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
   */
  _injectAnthropic(msgs) {
    const systemIdx = msgs.findIndex(m => m.role === 'system');

    const pashContentBlock = {
      type: 'text',
      text: `${PASH_SIGNATURE}\n${this._pashBlock}`,
      cache_control: { type: 'ephemeral' },
    };

    if (systemIdx === -1) {
      // No system message — create one
      msgs.unshift({
        role:    'system',
        content: [pashContentBlock],
      });
    } else {
      const existing = msgs[systemIdx];
      const clientContent = typeof existing.content === 'string'
        ? [{ type: 'text', text: existing.content }]
        : Array.isArray(existing.content) ? existing.content : [];

      // PASH block first (cached), client content second (uncached)
      msgs[systemIdx] = {
        ...existing,
        content: [pashContentBlock, ...clientContent],
      };
    }

    return msgs;
  }

  /**
   * OpenAI strategy: prepend PASH block to system message string.
   * OpenAI caches stable prefixes automatically.
   * PASH block at prefix → cached; client-specific content follows.
   */
  _injectOpenAI(msgs) {
    const systemIdx = msgs.findIndex(m => m.role === 'system');
    const pashText  = `${PASH_SIGNATURE}\n${this._pashBlock}\n\n---\n\n`;

    if (systemIdx === -1) {
      msgs.unshift({ role: 'system', content: pashText });
    } else {
      const existing = msgs[systemIdx];
      const clientText = typeof existing.content === 'string'
        ? existing.content
        : JSON.stringify(existing.content);

      msgs[systemIdx] = {
        ...existing,
        content: this._placement === 'prefix'
          ? pashText + clientText
          : clientText + '\n\n---\n\n' + `${PASH_SIGNATURE}\n${this._pashBlock}`,
      };
    }

    return msgs;
  }

  /** Generic (OpenRouter, local models, etc.) — same as OpenAI string approach */
  _injectGeneric(msgs) {
    return this._injectOpenAI(msgs);
  }

  get pashBlock() { return this._pashBlock; }
}

/**
 * Detect provider from model name.
 * FIX (audit #7): per-provider caching strategy requires provider detection.
 */
function detectProvider(model) {
  if (!model) return 'generic';
  const m = model.toLowerCase();
  if (m.startsWith('claude')) return 'anthropic';
  if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3')) return 'openai';
  if (m.includes('/')) return 'openrouter'; // openrouter format: "provider/model"
  return 'generic';
}

/**
 * Build the static PASH prompt block.
 * This is called ONCE at startup; result is reused for all requests.
 * Guaranteed identical across all requests → enables Prompt Caching.
 */
function buildStaticPashBlock(schemas, opts = {}) {
  try {
    // Try to use @pash/prompt if available
    const { PromptEngine } = require('@pash/prompt');
    const engine = new PromptEngine({ schemas });
    return engine.generate({ lang: opts.lang ?? 'ru', mode: opts.mode ?? 'pash' });
  } catch {
    // Fallback minimal prompt if @pash/prompt not installed
    return [
      'You generate UI in PASH v2 format.',
      'Use operators: +[id]|Component|fields, ~[id]|field|value, -[id]',
      'Do not output HTML, Markdown, or plain text for UI responses.',
    ].join('\n');
  }
}

module.exports = { PromptInjector, detectProvider, buildStaticPashBlock };
