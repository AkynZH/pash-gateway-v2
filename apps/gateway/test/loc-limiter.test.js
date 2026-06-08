'use strict';

const {
  calculateWeightedLoc,
  __resetStore,
  TIER_LIMITS,
} = require('../src/middleware/loc-limiter');

describe('LOC Limiter', () => {
  beforeEach(() => {
    __resetStore();
  });

  describe('calculateWeightedLoc', () => {
    test('calculates 1 LoC for a normal line under 256 chars', () => {
      const chars = 100;
      const weighted = calculateWeightedLoc(chars, 'openrouter/owl-alpha:free');
      expect(weighted).toBe(1); // ceil(100/256) * 1.0 = 1
    });

    test('calculates weighted LoC for long lines (anti-abuse)', () => {
      // 512 chars on a free model = 2 * 1.0 = 2 LoC
      const charsFree = 512;
      expect(calculateWeightedLoc(charsFree, 'openrouter/owl-alpha:free')).toBe(2);

      // 512 chars on a pro model (e.g., openai/gpt-4o) = 2 * 10.0 = 20 LoC
      const charsPro = 512;
      expect(calculateWeightedLoc(charsPro, 'openai/gpt-4o')).toBe(20);
    });

    test('applies correct multipliers from dynamic registry and falls back for unknown models', () => {
      // Uses dynamic registry
      expect(calculateWeightedLoc(256, 'openai/gpt-4o-mini')).toBe(3); // ceil(256/256) * 2.5 = 3 (rounded up from 2.5)
      expect(calculateWeightedLoc(256, 'openai/gpt-4o')).toBe(10); // ceil(256/256) * 10.0 = 10
      
      // calculateWeightedLoc falls back to default (1.0) for unknown models
      expect(calculateWeightedLoc(256, 'unknown-model')).toBe(1);
    });
  });

  describe('Tier Limits', () => {
    test('defines correct limits for community tier', () => {
      expect(TIER_LIMITS.community.locLimit).toBe(50000);
      expect(TIER_LIMITS.community.rpm).toBe(10);
      expect(TIER_LIMITS.community.rph).toBe(100);
    });

    test('defines correct limits for startup tier', () => {
      expect(TIER_LIMITS.startup.locLimit).toBe(250000);
    });

    test('defines infinite limits for pro tier', () => {
      expect(TIER_LIMITS.pro.locLimit).toBe(Infinity);
    });
  });
});
