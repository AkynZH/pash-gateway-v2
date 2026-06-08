#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const fs   = require('fs');
const path = require('path');
const { Client } = require('pg');

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // Create migrations table
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const migrationsDir = __dirname;
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const version = path.basename(file, '.sql');

    const { rows } = await client.query(
      'SELECT 1 FROM schema_migrations WHERE version = $1',
      [version]
    );

    if (rows.length) {
      console.log(`[Migration] ${version} — already applied`);
      continue;
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (version) VALUES ($1)',
        [version]
      );
      await client.query('COMMIT');
      console.log(`[Migration] ${version} — applied ✓`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[Migration] ${version} — FAILED:`, err.message);
      process.exit(1);
    }
  }

  await client.end();
  console.log('[Migration] All done');
}

run().catch(err => { console.error(err); process.exit(1); });
