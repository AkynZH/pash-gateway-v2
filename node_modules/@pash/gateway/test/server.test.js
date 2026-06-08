'use strict';

process.env.NODE_ENV = 'test';

// Stub heavy dependencies before requiring server
jest.mock('fastify', () => require('./__mocks__/fastify-mock'));
jest.mock('@fastify/cors', () => async () => {});
jest.mock('@fastify/rate-limit', () => async () => {});

const { buildApp }       = require('../src/server');
const { AuthService }    = require('../src/services/auth');
const { getRedis }       = require('../src/services/redis');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(overrides = {}) {
  return {
    headers:        { authorization: 'Bearer pash_test_abc123' },
    body:           {},
    params:         {},
    ip:             '127.0.0.1',
    raw:            { on: jest.fn() },
    pashContext:    null,
    log:            { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    routeOptions:   { config: {} },
    ...overrides,
  };
}

function makeReply() {
  const reply = {
    _code: 200,
    _body: null,
    _headers: {},
    code: jest.fn(function(c) { this._code = c; return this; }),
    send: jest.fn(function(b) { this._body = b; return this; }),
    raw:  {
      writeHead: jest.fn(),
      write:     jest.fn(),
      end:       jest.fn(),
      headersSent: false,
    },
    sent: false,
  };
  return reply;
}

// ─── Auth Middleware ──────────────────────────────────────────────────────────

describe('AuthService', () => {
  const auth = new AuthService(null); // null db → test mode

  test('accepts pash_test_ key in test mode', async () => {
    const result = await auth.verify('pash_test_abc123456789');
    expect(result.valid).toBe(true);
    expect(result.orgId).toBe('org_test');
  });

  test('rejects key without pash_ prefix', async () => {
    const result = await auth.verify('sk-openai-xxx');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Invalid key format/);
  });

  test('maskKey hides sensitive chars', () => {
    const masked = AuthService.maskKey('pash_live_abc123def456');
    expect(masked).toContain('****');
    expect(masked).not.toContain('abc123def456');
  });
});

// ─── Redis (memory fallback) ──────────────────────────────────────────────────

describe('Redis memory fallback', () => {
  const redis = getRedis();

  test('get/set works', async () => {
    await redis.set('test:key', 'hello');
    expect(await redis.get('test:key')).toBe('hello');
  });

  test('incrby is atomic', async () => {
    await redis.del('test:counter');
    await redis.incrby('test:counter', 5);
    await redis.incrby('test:counter', 3);
    expect(await redis.get('test:counter')).toBe('8');
  });

  test('expire removes key after ttl', async () => {
    await redis.set('test:exp', 'val');
    await redis.expire('test:exp', 0); // 0 seconds = immediate
    // Force expiry check
    await new Promise(r => setTimeout(r, 10));
    expect(await redis.get('test:exp')).toBeNull();
  });
});

// ─── BillingCounter ───────────────────────────────────────────────────────────

describe('BillingCounter', () => {
  const { BillingCounter } = require('@pash/billing');

  test('checkLimit: allowed when under limit', async () => {
    const redis   = getRedis();
    const counter = new BillingCounter(redis);
    await redis.del('test:lines:org_check');
    // Redis key prefix not set in test, use raw
    const r = await counter.checkLimit('org_check', 300_000);
    expect(r.allowed).toBe(true);
    expect(r.current).toBe(0);
    expect(r.remaining).toBe(300_000);
  });

  test('checkLimit: denied when at limit', async () => {
    const redis   = getRedis();
    const counter = new BillingCounter(redis);
    const key     = 'pash:lines:org_over'; // matches REDIS_KEY_PREFIX
    await redis.set(key, '300000');
    const r = await counter.checkLimit('org_over', 300_000);
    expect(r.allowed).toBe(false);
    await redis.del(key);
  });

  test('increment returns new total', async () => {
    const redis   = getRedis();
    const counter = new BillingCounter(redis);
    const key     = 'pash:lines:org_inc';
    await redis.del(key);
    const v = await counter.increment('org_inc', 42);
    expect(v).toBe(42);
    await redis.del(key);
  });
});

// ─── StreamGuard ──────────────────────────────────────────────────────────────

describe('StreamGuard', () => {
  const { StreamGuard } = require('@pash/billing');

  test('counts only PASH operator lines', () => {
    const guard = new StreamGuard({ orgId: 'x', limit: 1000, currentCount: 0 });
    const chunk = '+[a]|ProductCard|X|Y\n~[a]|price|100\nSome text without operator\n-[a]\n';
    const { newLines } = guard.push(chunk);
    expect(newLines).toBe(3); // +, ~, - but not plain text
  });

  test('stops when limit reached', () => {
    const guard = new StreamGuard({ orgId: 'x', limit: 2, currentCount: 1 });
    const chunk = '+[a]|X|y\n+[b]|X|y\n';
    const r = guard.push(chunk);
    expect(r.shouldStop).toBe(true);
    expect(r.limitLine).toContain('PASH_LIMIT_EXCEEDED');
  });

  test('v:2 header line is NOT counted', () => {
    const guard = new StreamGuard({ orgId: 'x', limit: 100, currentCount: 0 });
    const { newLines } = guard.push('v:2\n+[a]|Badge|text\n');
    expect(newLines).toBe(1); // only the + line
  });
});

// ─── CircuitBreaker ───────────────────────────────────────────────────────────

describe('CircuitBreakerManager', () => {
  const { CircuitBreakerManager, STATE } = require('../src/services/circuit-breaker');

  test('returns first available provider', () => {
    const cb = new CircuitBreakerManager(['openrouter', 'openai'], { failureThreshold: 3 });
    expect(cb.getAvailable()).toBe('openrouter');
  });

  test('skips open circuits', () => {
    const cb = new CircuitBreakerManager(['openrouter', 'openai'], { failureThreshold: 2 });
    cb.recordFailure('openrouter', new Error('timeout'));
    cb.recordFailure('openrouter', new Error('timeout'));
    expect(cb.getAvailable()).toBe('openai');
  });

  test('all open returns null', () => {
    const cb = new CircuitBreakerManager(['openrouter'], { failureThreshold: 1 });
    cb.recordFailure('openrouter', new Error('x'));
    expect(cb.getAvailable()).toBeNull();
  });

  test('failover calls onFailover callback', async () => {
    const cb         = new CircuitBreakerManager(['openrouter', 'openai'], { failureThreshold: 1 });
    const failovers  = [];
    let callCount    = 0;

    await cb.executeWithFailover(
      async (provider) => {
        callCount++;
        if (provider === 'openrouter') throw new Error('fail');
        return 'ok';
      },
      (next) => failovers.push(next)
    ).catch(() => {});

    expect(failovers).toContain('openai');
  });
});

// ─── PromptInjector ───────────────────────────────────────────────────────────

describe('PromptInjector', () => {
  const { PromptInjector } = require('../src/services/prompt-injector');
  const BLOCK = 'PASH RULES: use +[id]|Component|fields';

  test('injects into empty messages', () => {
    const inj  = new PromptInjector({ pashBlock: BLOCK });
    const msgs = inj.inject([{ role: 'user', content: 'hello' }], 'gpt-4o');
    const sys  = msgs.find(m => m.role === 'system');
    expect(sys).toBeTruthy();
    expect(sys.content).toContain(BLOCK);
  });

  test('prepends to existing system message', () => {
    const inj  = new PromptInjector({ pashBlock: BLOCK });
    const msgs = inj.inject([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user',   content: 'hi' },
    ], 'gpt-4o');
    const sys = msgs.find(m => m.role === 'system');
    expect(sys.content).toContain(BLOCK);
    expect(sys.content).toContain('You are helpful.');
  });

  test('prevents double injection', () => {
    const inj  = new PromptInjector({ pashBlock: BLOCK });
    const msgs = [{ role: 'system', content: '# PASH_PROTOCOL_BLOCK_V2\n' + BLOCK }];
    const result = inj.inject(msgs, 'gpt-4o');
    const count  = result[0].content.split('PASH_PROTOCOL_BLOCK_V2').length - 1;
    expect(count).toBe(1); // only one occurrence
  });

  test('Anthropic: uses cache_control content blocks', () => {
    const inj  = new PromptInjector({ pashBlock: BLOCK });
    const msgs = inj.inject([{ role: 'user', content: 'hi' }], 'claude-3-5-sonnet');
    const sys  = msgs.find(m => m.role === 'system');
    expect(Array.isArray(sys.content)).toBe(true);
    expect(sys.content[0].cache_control).toEqual({ type: 'ephemeral' });
  });
});

// ─── Savings Calculator ───────────────────────────────────────────────────────

describe('SavingsCalculator', () => {
  const { calculateSavings, aggregateSavings } = require('@pash/billing');

  test('calculates savings vs JSON baseline', () => {
    const r = calculateSavings({
      pashLines:        10,
      actualPashTokens: 110,  // 10 lines * 11 tokens avg
      baselineFormat:   'json',
    });
    expect(r.estimatedBaselineTokens).toBe(10 * 34 + 12); // = 352
    expect(r.tokensSaved).toBeGreaterThan(0);
    expect(r.savingsPct).toBeGreaterThan(0);
    expect(r.methodology).toBe('PASH_BENCHMARK_V1');
    expect(r.methodologyUrl).toContain('github.com');
  });

  test('aggregates multiple events', () => {
    const events = [
      calculateSavings({ pashLines: 5,  actualPashTokens: 55,  baselineFormat: 'json' }),
      calculateSavings({ pashLines: 10, actualPashTokens: 110, baselineFormat: 'json' }),
    ];
    const agg = aggregateSavings(events);
    expect(agg.totalPashLines).toBe(15);
    expect(agg.totalTokensSaved).toBeGreaterThan(0);
  });
});


// ─── SchemaResolver (state-engine) ───────────────────────────────────────────

describe('SchemaResolver — full negotiation', () => {
  const { SchemaResolver } = require('@pash/state-engine');

  test('exact version resolves cleanly', () => {
    const r = new SchemaResolver();
    r.register('Badge', 1, { fields: [{ label: 'text', type: 'string', required: true }] });
    const { schema, warnLine, actualVersion } = r.resolve('Badge', 1, 'b1');
    expect(actualVersion).toBe(1);
    expect(warnLine).toBeNull();
    expect(schema.fields[0].label).toBe('text');
  });

  test('downgrade emits !warn', () => {
    const r = new SchemaResolver();
    r.register('Widget', 1, { fields: [] });
    const { warnLine, actualVersion } = r.resolve('Widget', 3, 'w1');
    expect(actualVersion).toBe(1);
    expect(warnLine).toMatch(/^!warn\|/);
  });
});

// ─── ComponentTree — via state-engine ────────────────────────────────────────

describe('ComponentTree — session integration', () => {
  const { ComponentTree } = require('@pash/state-engine');

  test('cascade unmount clears all children', () => {
    const tree = new ComponentTree();
    tree.mount({ id: 'root', component: 'Panel', fields: {} });
    tree.mount({ id: 'child1', component: 'Card', fields: {}, parent: 'root' });
    tree.mount({ id: 'child2', component: 'Card', fields: {}, parent: 'root' });
    tree.mount({ id: 'grandchild', component: 'Badge', fields: {}, parent: 'child1' });

    const r = tree.unmount('root');
    expect(r.removed).toHaveLength(4);
    expect(tree.size).toBe(0);
  });

  test('snapshot hash is deterministic', () => {
    const t1 = new ComponentTree();
    const t2 = new ComponentTree();
    t1.mount({ id: 'a', component: 'X', fields: { k: 'v' } });
    t2.mount({ id: 'a', component: 'X', fields: { k: 'v' } });
    expect(t1.snapshot().hash).toBe(t2.snapshot().hash);
  });
});
