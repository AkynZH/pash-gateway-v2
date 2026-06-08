'use strict';

const { calculateSavings, aggregateSavings, BENCHMARK } = require('../src/savings');

describe('calculateSavings', () => {
  test('JSON baseline formula: 34*N+12', () => {
    const r = calculateSavings({ pashLines: 10, actualPashTokens: 113, baselineFormat: 'json' });
    expect(r.estimatedBaselineTokens).toBe(34*10+12);
    expect(r.tokensSaved).toBe(34*10+12 - 113);
  });

  test('HTML baseline higher than JSON', () => {
    const j = calculateSavings({ pashLines: 10, actualPashTokens: 113, baselineFormat: 'json' });
    const h = calculateSavings({ pashLines: 10, actualPashTokens: 113, baselineFormat: 'html' });
    expect(h.estimatedBaselineTokens).toBeGreaterThan(j.estimatedBaselineTokens);
  });

  test('no negative savings', () => {
    const r = calculateSavings({ pashLines: 1, actualPashTokens: 9999, baselineFormat: 'json' });
    expect(r.tokensSaved).toBeGreaterThanOrEqual(0);
  });

  test('methodology fields present and auditable', () => {
    const r = calculateSavings({ pashLines: 5, actualPashTokens: 55, baselineFormat: 'json' });
    expect(r.methodology).toBe('PASH_BENCHMARK_V1');
    expect(r.methodologyUrl).toContain('github.com');
    expect(typeof r.costSavedUsd).toBe('number');
    expect(r.savingsPct).toBeGreaterThan(0);
  });

  test('custom costPer1M scales linearly', () => {
    const a = calculateSavings({ pashLines: 10, actualPashTokens: 110, costPer1M: 1.0 });
    const b = calculateSavings({ pashLines: 10, actualPashTokens: 110, costPer1M: 15.0 });
    expect(b.costSavedUsd).toBeCloseTo(a.costSavedUsd * 15, 5);
  });
});

describe('aggregateSavings', () => {
  test('sums all numeric fields', () => {
    const e1 = calculateSavings({ pashLines: 10, actualPashTokens: 110, baselineFormat: 'json' });
    const e2 = calculateSavings({ pashLines: 20, actualPashTokens: 220, baselineFormat: 'json' });
    const a  = aggregateSavings([e1, e2]);
    expect(a.totalPashLines).toBe(30);
    expect(a.totalActualTokens).toBe(330);
    expect(a.totalTokensSaved).toBe(e1.tokensSaved + e2.tokensSaved);
    expect(a.totalCostSavedUsd).toBeCloseTo(e1.costSavedUsd + e2.costSavedUsd, 6);
  });

  test('empty array → all zeros', () => {
    const a = aggregateSavings([]);
    expect(a.totalPashLines).toBe(0);
    expect(a.totalTokensSaved).toBe(0);
    expect(a.totalCostSavedUsd).toBe(0);
  });
});
