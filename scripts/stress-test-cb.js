'use strict';

/**
 * Скрипт нагрузочного тестирования Circuit Breaker и Failover.
 * Проверяет устойчивость механизма при высокой конкурентности.
 * 
 * Запуск: node scripts/stress-test-cb.js
 */

const { CircuitBreakerManager } = require('../apps/gateway/src/services/circuit-breaker');

// Конфигурация стресс-теста
const CONFIG = {
  concurrentRequests: 50, // Количество одновременных запросов
  failureThreshold: 2,    // Порог срабатывания Circuit Breaker
  recoveryTimeout: 5000,  // Время до попытки восстановления (мс)
};

async function runStressTest() {
  console.log('🚀 Запуск стресс-теста Circuit Breaker...');
  console.log(`   Конкурентных запросов: ${CONFIG.concurrentRequests}`);
  console.log(`   Порог срабатывания (failureThreshold): ${CONFIG.failureThreshold}\n`);

  const manager = new CircuitBreakerManager(
    ['primary-llm', 'fallback-llm'],
    { failureThreshold: CONFIG.failureThreshold, resetTimeoutMs: CONFIG.recoveryTimeout }
  );

  const startTime = Date.now();
  const promises = [];
  const results = {
    success: 0,
    shortCircuited: 0,
    failed: 0,
  };

  console.log('⚡ Отправка пакета конкурентных запросов...');
  
  for (let i = 0; i < CONFIG.concurrentRequests; i++) {
    promises.push(
      manager.executeWithFailover(
        async (provider) => {
          if (provider === 'primary-llm') {
            throw new Error('Simulated LLM Timeout');
          }
          // fallback-llm succeeds
          return { success: true, provider };
        },
        (newProvider) => {
          // onFailover callback
          // console.log(`[Test] Failover triggered to ${newProvider}`);
        }
      )
        .then(() => {
          results.success++;
        })
        .catch((err) => {
          if (err.message.includes('All providers unavailable (circuit open)')) {
            results.shortCircuited++;
          } else {
            results.failed++;
            console.error(`[Test] Unexpected error: ${err.message}`);
          }
        })
    );
  }

  await Promise.allSettled(promises);
  const duration = Date.now() - startTime;

  const status = manager.allStatus();
  const primaryStatus = status.find(s => s.name === 'primary-llm');

  console.log('\n📊 Результаты стресс-теста:');
  console.log(`   Общее время выполнения: ${duration} мс`);
  console.log(`   Успешно (через failover): ${results.success}`);
  console.log(`   Отклонено (Circuit OPEN): ${results.shortCircuited}`);
  console.log(`   Ошибок: ${results.failed}`);

  console.log(`\n🔍 Состояние primary-llm Circuit: ${primaryStatus.state}`);
  console.log(`   Зафиксировано отказов: ${primaryStatus.failures}`);

  // Валидация: primary-llm должен быть в состоянии OPEN, и часть запросов должна быть отклонена
  // или успешно переключена на fallback до открытия цепи.
  const successThreshold = 2; // Минимум 2 запроса должны успеть пройти через fallback до открытия цепи
  if (primaryStatus.state === 'OPEN' && primaryStatus.failures >= CONFIG.failureThreshold && results.success >= successThreshold) {
    console.log('\n✅ ТЕСТ ПРОЙДЕН: Circuit Breaker корректно открылся и защитил систему.');
    console.log('✅ Failover успешно обработал запросы до исчерпания лимита отказов.');
  } else {
    console.error('\n❌ ТЕСТ ПРОВАЛЕН: Circuit Breaker не перешел в состояние OPEN или failover не сработал.');
    process.exit(1);
  }
}

runStressTest().catch((err) => {
  console.error('Критическая ошибка при проведении стресс-теста:', err);
  process.exit(1);
});
