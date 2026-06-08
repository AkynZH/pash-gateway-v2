'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Calculate consistency score by simulating LLM runs.
 * In a real environment, this would call the actual LLM provider.
 * For CLI testing, it simulates variance based on a mock hash.
 */
async function consistencyScore(promptFilePath, totalRuns = 50, temperature = 0.5) {
  const promptContent = fs.readFileSync(path.resolve(promptFilePath), 'utf8');
  
  let identicalOutputs = 0;
  const outputs = new Map();

  for (let i = 0; i < totalRuns; i++) {
    // Simulate LLM generation: 
    // At temperature 0.0, output is always identical.
    // At temperature > 0.0, we introduce a small chance of variation.
    const variationChance = temperature * 0.1; // e.g., 0.5 temp = 5% chance of variation
    const isIdentical = Math.random() > variationChance;

    const outputHash = isIdentical 
      ? crypto.createHash('sha256').update(promptContent + 'canonical').digest('hex')
      : crypto.createHash('sha256').update(promptContent + i).digest('hex');

    if (outputs.has(outputHash)) {
      outputs.set(outputHash, outputs.get(outputHash) + 1);
    } else {
      outputs.set(outputHash, 1);
    }
  }

  // The most common output is considered the "canonical" one
  let maxCount = 0;
  for (const count of outputs.values()) {
    if (count > maxCount) {
      maxCount = count;
    }
  }

  identicalOutputs = maxCount;
  const score = identicalOutputs / totalRuns;

  return {
    totalRuns,
    identicalOutputs,
    score,
    distribution: Object.fromEntries(outputs),
  };
}

module.exports = { consistencyScore };
