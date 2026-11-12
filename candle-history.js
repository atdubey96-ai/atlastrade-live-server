// Validate the broker envelope before treating a request as successful. A 200
// response containing HTML, an error object or null data is not candle history.
export async function recoverCandleHistory(body, request, parse, now = Date.now(), recoverSession) {
  let lastError, sessionRecovered = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = { ...body };
    if (attempt === 2) {
      const day = new Date(now - 7 * 86400000 + 19800000).toISOString().slice(0, 10);
      current.fromdate = day + ' 00:00';
    }
    try {
      const { ok, status, json } = await request(current, attempt);
      if (!ok || json?.status !== true || !Array.isArray(json.data)) {
        const brokerCode = String(json?.errorcode || json?.errorCode || '').toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 24);
        const error = new Error((status === 401 || status === 403 ? 'Broker history access is temporarily unavailable' : 'The broker returned an invalid history response') + (brokerCode ? ' (' + brokerCode + ')' : ''));
        error.brokerCode = brokerCode;
        error.status = status;
        // A websocket may remain connected after its REST token expires. Repair
        // only explicit authentication failures, at most once per chart request.
        if (!sessionRecovered && recoverSession && (status === 401 || ['AG8001', 'AG8002', 'AB1010', 'AB8050'].includes(brokerCode))) {
          sessionRecovered = true;
          await recoverSession();
        }
        throw error;
      }
      const candles = parse(json.data, body.interval);
      if (candles.length) return candles;
      lastError = new Error('The broker has no historical candles for this contract and interval');
      lastError.code = 'HISTORY_EMPTY';
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

// Coalesce requests for the exact contract and interval. Never substitute a
// different contract/timeframe or silently return expired cached history.
export function createCandleHistoryStore({ now = Date.now, maxEntries = 200 } = {}) {
  const cache = new Map(), pending = new Map();
  return {
    async load(key, ttl, fetchHistory) {
      const held = cache.get(key);
      if (held && now() - held.at < ttl) return held.payload;
      if (pending.has(key)) return pending.get(key);
      const task = (async () => {
        await Promise.resolve();
        try {
          const payload = await fetchHistory();
          if (!Array.isArray(payload?.candles) || !payload.candles.length) throw new Error('No valid contract history');
          const at = now();
          cache.delete(key); cache.set(key, { at, payload: { ...payload, stale: false, fetchedAt: at } });
          if (cache.size > maxEntries) cache.delete(cache.keys().next().value);
          return cache.get(key).payload;
        } finally { pending.delete(key); }
      })();
      pending.set(key, task);
      return task;
    }
  };
}
