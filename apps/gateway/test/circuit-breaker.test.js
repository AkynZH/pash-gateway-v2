'use strict';

const { CircuitBreakerManager, ProviderCircuit, STATE } =
  require('../src/services/circuit-breaker');

describe('ProviderCircuit', () => {
  test('starts CLOSED and available', () => {
    const c = new ProviderCircuit('p', { failureThreshold: 3 });
    expect(c.state).toBe(STATE.CLOSED);
    expect(c.isAvailable()).toBe(true);
  });

  test('opens after failureThreshold reached', () => {
    const c = new ProviderCircuit('p', { failureThreshold: 2 });
    c.recordFailure(new Error('e1'));
    expect(c.state).toBe(STATE.CLOSED);
    c.recordFailure(new Error('e2'));
    expect(c.state).toBe(STATE.OPEN);
    expect(c.isAvailable()).toBe(false);
  });

  test('OPEN → HALF_OPEN after resetTimeout', () => {
    const c = new ProviderCircuit('p', { failureThreshold: 1, resetTimeoutMs: 50 });
    c.recordFailure(new Error('e'));
    c.openedAt = Date.now() - 100;
    expect(c.isAvailable()).toBe(true);
    expect(c.state).toBe(STATE.HALF_OPEN);
  });

  test('HALF_OPEN → CLOSED on success', () => {
    const c = new ProviderCircuit('p', { failureThreshold: 1, resetTimeoutMs: 1 });
    c.recordFailure(new Error('e'));
    c.openedAt = Date.now() - 100;
    c.isAvailable();
    c.recordSuccess();
    expect(c.state).toBe(STATE.CLOSED);
  });

  test('HALF_OPEN → OPEN on probe failure', () => {
    const c = new ProviderCircuit('p', { failureThreshold: 1, resetTimeoutMs: 1 });
    c.recordFailure(new Error('e'));
    c.openedAt = Date.now() - 100;
    c.isAvailable();
    c.recordFailure(new Error('probe fail'));
    expect(c.state).toBe(STATE.OPEN);
  });
});

describe('CircuitBreakerManager', () => {
  test('first provider used when available', () => {
    const cb = new CircuitBreakerManager(['pA', 'pB'], { failureThreshold: 5 });
    expect(cb.getAvailable()).toBe('pA');
  });

  test('skips OPEN circuit, returns next', () => {
    const cb = new CircuitBreakerManager(['pA', 'pB'], { failureThreshold: 2 });
    cb.recordFailure('pA', new Error('x'));
    cb.recordFailure('pA', new Error('x'));
    expect(cb.getAvailable()).toBe('pB');
  });

  test('returns null when all OPEN', () => {
    const cb = new CircuitBreakerManager(['pA'], { failureThreshold: 1 });
    cb.recordFailure('pA', new Error('x'));
    expect(cb.getAvailable()).toBeNull();
  });

  test('executeWithFailover succeeds on first try', async () => {
    const cb = new CircuitBreakerManager(['pA', 'pB'], { failureThreshold: 5 });
    const r  = await cb.executeWithFailover(async (p) => `ok:${p}`, jest.fn());
    expect(r).toBe('ok:pA');
  });

  test('executeWithFailover fails over and calls onFailover callback', async () => {
    const cb       = new CircuitBreakerManager(['pA', 'pB'], { failureThreshold: 1 });
    const failovers = [];
    const r = await cb.executeWithFailover(
      async (p) => { if (p === 'pA') throw new Error('down'); return `ok:${p}`; },
      (next) => failovers.push(next)
    );
    expect(r).toBe('ok:pB');
    expect(failovers).toContain('pB');
  });

  test('throws when all providers exhausted', async () => {
    const cb = new CircuitBreakerManager(['pA'], { failureThreshold: 1 });
    await expect(
      cb.executeWithFailover(async () => { throw new Error('fail'); }, jest.fn())
    ).rejects.toThrow('All providers unavailable');
  });

  test('allStatus returns entry for each provider', () => {
    const cb = new CircuitBreakerManager(['pA', 'pB', 'pC'], { failureThreshold: 5 });
    expect(cb.allStatus()).toHaveLength(3);
    expect(cb.allStatus().every(s => s.state === STATE.CLOSED)).toBe(true);
  });
});
