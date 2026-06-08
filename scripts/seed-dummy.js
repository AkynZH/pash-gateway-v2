#!/usr/bin/env node
'use strict';

/**
 * Seed database with realistic dummy data for Dashboard testing.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { Client } = require('pg');
const crypto = require('crypto');

async function seedDummy() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });
  await client.connect();

  try {
    console.log('🌱 Добавляем тестовые организации...');
    
    const orgs = [
      { name: 'CyberDyne Systems', plan: 'enterprise', limit: 5000000 },
      { name: 'NeoTokyo AI Labs', plan: 'pro', limit: 1000000 },
      { name: 'Felix Internal R&D', plan: 'free', limit: 100000 },
    ];

    for (const org of orgs) {
      await client.query(`
        INSERT INTO organizations (name, plan, line_limit)
        VALUES ($1, $2, $3)
        ON CONFLICT DO NOTHING
      `, [org.name, org.plan, org.limit]);
    }

    console.log('🔑 Генерируем тестовые API-ключи...');
    
    // Получаем ID организаций
    const orgRows = await client.query('SELECT id, name FROM organizations');
    
    for (const org of orgRows.rows) {
      const isLive = org.name.includes('CyberDyne');
      const prefix = isLive ? `pash_live_${crypto.randomBytes(3).toString('hex')}` : `pash_test_${crypto.randomBytes(3).toString('hex')}`;
      const keyHash = crypto.createHash('sha256').update(prefix + '_secret').digest('hex');
      const env = isLive ? 'live' : 'test';
      const plan = isLive ? 'enterprise' : 'pro';
      const limit = isLive ? 5000000 : 1000000;

      await client.query(`
        INSERT INTO api_keys (org_id, key_hash, key_prefix, env, plan, line_limit, status)
        VALUES ($1, $2, $3, $4, $5, $6, 'active')
        ON CONFLICT (key_hash) DO NOTHING
      `, [org.id, keyHash, prefix, env, plan, limit]);
    }

    console.log('💰 Генерируем тестовые события биллинга (экономия по моделям)...');
    
    const models = [
      { name: 'openai/gpt-4o', provider: 'openai', costPer1k: 0.015 },
      { name: 'anthropic/claude-3-5-sonnet', provider: 'anthropic', costPer1k: 0.015 },
      { name: 'meta-llama/llama-3-8b-instruct', provider: 'openrouter', costPer1k: 0.0002 },
      { name: 'google/gemini-1.5-pro', provider: 'google', costPer1k: 0.007 }
    ];

    for (const org of orgRows.rows) {
      // Генерируем по 5-8 событий биллинга на организацию
      const eventsCount = 5 + Math.floor(Math.random() * 4);
      
      for (let i = 0; i < eventsCount; i++) {
        const model = models[Math.floor(Math.random() * models.length)];
        // PASH экономит от 5 000 до 45 000 токенов на запрос за счет удаления JSON-оверхеда
        const tokensSaved = 5000 + Math.floor(Math.random() * 40000);
        // Рассчитываем сэкономленные доллары
        const costSaved = (tokensSaved / 1000) * model.costPer1k;

        await client.query(`
          INSERT INTO billing_events (
            org_id, pash_lines, actual_pash_tokens, estimated_baseline_tokens, 
            tokens_saved, cost_saved_usd, baseline_format, methodology, provider, model, is_byok
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [
          org.id,
          Math.floor(Math.random() * 50) + 10, // pash_lines
          Math.floor(Math.random() * 2000) + 500, // actual_pash_tokens
          Math.floor(Math.random() * 5000) + 2000, // estimated_baseline_tokens
          tokensSaved,
          costSaved.toFixed(6),
          'json',
          'PASH_BENCHMARK_V1',
          model.provider,
          model.name,
          Math.random() > 0.5 // is_byok
        ]);
      }
    }

    console.log('✅ Тестовые данные успешно добавлены!');
    console.log('👉 Обнови страницу http://localhost:3002, чтобы увидеть финансовую аналитику.');

  } catch (err) {
    console.error('❌ Ошибка при добавлении данных:', err.message);
  } finally {
    await client.end();
  }
}

seedDummy();