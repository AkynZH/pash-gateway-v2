'use strict';

const {
  calculateWeightedLoc,
  __resetStore,
  TIER_LIMITS,
  MODEL_MULTIPLIERS,
} = require('../src/middleware/loc-limiter');

describe('LOC Limiter', () => {
  beforeEach(() => {
    __resetStore();
  });

  describe('calculateWeightedLoc', () => {
    test('calculates 1 LoC for a normal line under 256 chars', () => {
      const chars = 100;
      const weighted = calculateWeightedLoc(chars, 'owl-alpha:free');
      expect(weighted).toBe(1); // ceil(100/256) * 1.0 = 1
    });

    test('calculates weighted LoC for long lines (anti-abuse)', () => {
      // 512 chars on a free model = 2 * 1.0 = 2 LoC
      const charsFree = 512;
      expect(calculateWeightedLoc(charsFree, 'owl-alpha:free')).toBe(2);

      // 512 chars on a pro model (e.g., gpt-4o) = 2 * 10.0 = 20 LoC
      const charsPro = 512;
      expect(calculateWeightedLoc(charsPro, 'gpt-4o')).toBe(20);
    });

    test('applies correct multipliers for different models', () => {
      expect(MODEL_MULTIPLIERS['minimax-m2.5:free']).toBe(1.0);
      expect(MODEL_MULTIPLIERS['gpt-4o-mini']).toBe(2.5);
      expect(MODEL_MULTIPLIERS['gpt-4o']).toBe(10.0);
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
