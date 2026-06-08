#!/usr/bin/env node
'use strict';

const { program } = require('commander');
const { checkSchema } = require('../src/schema-checker');
const { consistencyScore } = require('../src/consistency-checker');

program
  .name('pash')
  .description('PASH GitOps CLI for schema validation and LLM consistency testing')
  .version('1.0.0');

program
  .command('check-schema <oldFile> <newFile>')
  .description('Check for breaking changes between two PASH schema files')
  .action(async (oldFile, newFile) => {
    try {
      const result = await checkSchema(oldFile, newFile);
      if (result.hasBreakingChanges) {
        console.error('❌ PASH SCHEMA CHECK: FAILED');
        result.breakingChanges.forEach(change => {
          console.error(`   - ${change}`);
        });
        process.exit(1);
      } else {
        console.log('✅ PASH SCHEMA CHECK: PASSED');
        process.exit(0);
      }
    } catch (err) {
      console.error('❌ Error checking schema:', err.message);
      process.exit(1);
    }
  });

program
  .command('consistency-score <promptFile> [options]')
  .description('Run LLM prompt multiple times and calculate consistency score')
  .option('-n, --runs <number>', 'Number of runs (default: 50)', '50')
  .option('-t, --temperature <number>', 'LLM temperature (default: 0.5)', '0.5')
  .action(async (promptFile, options) => {
    try {
      const runs = parseInt(options.runs, 10);
      const temperature = parseFloat(options.temperature);
      const result = await consistencyScore(promptFile, runs, temperature);
      
      console.log(`\n📊 Consistency Score Report`);
      console.log(`Runs: ${result.totalRuns}`);
      console.log(`Identical Outputs: ${result.identicalOutputs}`);
      console.log(`Score: ${(result.score * 100).toFixed(1)}%`);
      
      if (result.score >= 0.95) {
        console.log('✅ Prompt meets enterprise consistency criteria (>= 95%)');
        process.exit(0);
      } else {
        console.error('❌ Prompt fails enterprise consistency criteria (< 95%)');
        console.error('Action required: Refine prompt to reduce LLM hallucination.');
        process.exit(1);
      }
    } catch (err) {
      console.error('❌ Error calculating consistency score:', err.message);
      process.exit(1);
    }
  });

program.parse(process.argv);
