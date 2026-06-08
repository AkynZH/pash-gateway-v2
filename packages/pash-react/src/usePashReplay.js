'use strict';

import { useState, useCallback } from 'react';

/**
 * Хук для взаимодействия с Time Travel Replay API PASH Gateway.
 * Позволяет восстановить состояние Component Tree на любом историческом шаге.
 * 
 * @param {string} baseUrl - Базовый URL PASH Gateway (например, 'http://localhost:3000/v1')
 * @returns {Object} { replayState, isLoading, error, fetchReplay }
 */
export function usePashReplay(baseUrl = 'http://localhost:3000/v1') {
  const [replayState, setReplayState] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchReplay = useCallback(async (sessionId, targetStep) => {
    if (!sessionId || targetStep === undefined || targetStep < 0) {
      setError(new Error('sessionId и корректный targetStep являются обязательными'));
      return null;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(`${baseUrl}/presentation/replay/${sessionId}?targetStep=${targetStep}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          // 'Authorization': `Bearer ${token}` // Раскомментируйте при необходимости
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      setReplayState(data);
      return data;
    } catch (err) {
      setError(err);
      console.error('[PASH Replay] Ошибка при восстановлении состояния:', err);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [baseUrl]);

  const clearReplay = useCallback(() => {
    setReplayState(null);
    setError(null);
  }, []);

  return {
    replayState,
    isLoading,
    error,
    fetchReplay,
    clearReplay,
  };
}
