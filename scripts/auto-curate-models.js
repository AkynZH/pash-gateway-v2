'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Автономный скрипт синхронизации и курации моделей из OpenRouter.
 * Забирает данные, применяет умные правила фильтрации и обновляет config/models-registry.json.
 * Запуск: node scripts/auto-curate-models.js
 */
async function autoCurateModels() {
  console.log('🤖 [Auto-Curator] Начало автономной синхронизации с OpenRouter...');
  
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models');
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    
    const data = await response.json();
    const rawModels = data.data || [];

    const configPath = path.join(__dirname, '..', 'config', 'models-registry.json');
    let existingRegistry = { version: "1.0.0", models: [] };
    
    if (fs.existsSync(configPath)) {
      existingRegistry = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }

    const existingIds = new Set(existingRegistry.models.map(m => m.id));
    const newModels = [];
    const updatedModels = [];

    for (const model of rawModels) {
      const priceIn = model.pricing?.prompt ? parseFloat(model.pricing.prompt) * 1_000_000 : 0;
      const priceOut = model.pricing?.completion ? parseFloat(model.pricing.completion) * 1_000_000 : 0;
      const contextLength = model.context_length || 8192;

      // Эвристики для автоматической курации
      let multiplier = 5.0;
      let allowedTiers = ['pro'];
      
      if (priceIn === 0 && priceOut === 0) {
        // Полностью бесплатные модели: низкий множитель, доступны для всех
        multiplier = 1.0;
        allowedTiers = ['community', 'startup', 'pro'];
      } else if (priceIn < 0.20 && priceOut < 0.50) {
        // Очень дешевые модели
        multiplier = 2.0;
        allowedTiers = ['startup', 'pro'];
      } else if (priceIn < 1.00 && priceOut < 3.00) {
        // Модели среднего уровня
        multiplier = 5.0;
        allowedTiers = ['pro'];
      } else {
        // Дорогие флагманы
        multiplier = 10.0;
        allowedTiers = ['pro'];
      }

      // Фильтр: минимальный контекст 8k для генерации UI
      if (contextLength < 8000) continue;

      // Фильтр: игнорируем явно экспериментальные или нишевые модели по ключевым словам
      const skipKeywords = ['kobold', 'pygmalion', 'mythomax', 'roleplay', 'chat'];
      if (skipKeywords.some(keyword => model.id.toLowerCase().includes(keyword))) continue;

      const modelData = {
        id: model.id,
        name: model.name,
        provider: model.id.split('/')[0],
        contextLength,
        pricingInputUsdPer1M: priceIn,
        pricingOutputUsdPer1M: priceOut,
        multiplier,
        allowedTiers,
        status: existingIds.has(model.id) ? existingRegistry.models.find(m => m.id === model.id).status : 'active'
      };

      if (existingIds.has(model.id)) {
        // Обновляем цены и контекст для существующих, сохраняя ручной статус
        const existing = existingRegistry.models.find(m => m.id === model.id);
        if (existing.pricingInputUsdPer1M !== priceIn || existing.contextLength !== contextLength) {
          existing.pricingInputUsdPer1M = priceIn;
          existing.pricingOutputUsdPer1M = priceOut;
          existing.contextLength = contextLength;
          updatedModels.push(model.id);
        }
      } else {
        newModels.push(modelData);
      }
    }

    // Объединяем и сохраняем
    const finalModels = [
      ...existingRegistry.models.filter(m => newModels.some(nm => nm.id === m.id) || updatedModels.includes(m.id)),
      ...newModels
    ];

    // Сортируем: сначала бесплатные для community, потом по цене
    finalModels.sort((a, b) => {
      const aFree = a.allowedTiers.includes('community');
      const bFree = b.allowedTiers.includes('community');
      if (aFree && !bFree) return -1;
      if (!aFree && bFree) return 1;
      return a.pricingInputUsdPer1M - b.pricingInputUsdPer1M || a.id.localeCompare(b.id);
    });

    const newRegistry = {
      version: existingRegistry.version,
      lastUpdated: new Date().toISOString(),
      models: finalModels
    };

    fs.writeFileSync(configPath, JSON.stringify(newRegistry, null, 2), 'utf8');

    console.log(`✅ Синхронизация завершена!`);
    console.log(`   🆕 Новых моделей добавлено: ${newModels.length}`);
    console.log(`   🔄 Обновлены цены/контекст: ${updatedModels.length}`);
    console.log(`   📦 Всего активных моделей в реестре: ${finalModels.filter(m => m.status === 'active').length}`);
    console.log(`💾 Конфигурация сохранена в: config/models-registry.json`);
    console.log('💡 Шлюз автоматически подхватит изменения при следующем запросе (Hot Reload).');

  } catch (error) {
    console.error('❌ Ошибка автономной синхронизации:', error.message);
    process.exit(1);
  }
}

autoCurateModels();
