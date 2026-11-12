// Validate the broker envelope before treating a request as successful. A 200
// response containing HTML, an error object or null data is not candle history.
export async function recoverCandleHistory(body, request, parse, now = Date.now()) {
  let lastError;
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
