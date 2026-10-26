// Price book rules for the live server.
//
// A quote is only as fresh as the exchange timestamp it carries. Packets that arrive
// without a valid exchange time (pre-open or replayed packets) must never be stamped
// with the server clock, because that makes old data look live.

const MAX_FUTURE_MS = 10 * 60 * 1000;
const MAX_PAST_MS = 30 * 24 * 60 * 60 * 1000;
const STALE_GAP_MS = 6 * 60 * 60 * 1000;

// Returns epoch ms, or 0 when the value is not a plausible exchange time.
export function exchangeTimeMs(value, now = Date.now()) {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const ms = raw > 1e12 ? raw : (raw > 1e9 ? raw * 1000 : 0);
  if (!ms || ms > now + MAX_FUTURE_MS || ms < now - MAX_PAST_MS) return 0;
  return ms;
}

// Stores a quote unless it is older than the one already held. Returns true if stored.
export function storeQuote(book, symbol, quote) {
  const held = book[symbol];
  const heldTs = Number(held?.ts) || 0;
  const nextTs = Number(quote?.ts) || 0;
  if (heldTs > 0 && nextTs < heldTs) return false;
  book[symbol] = quote;
  return true;
}

// Quotes that are safe to serve: a verified exchange time, and not left behind by
// more than STALE_GAP_MS compared with the newest verified quote in the book.
export function servableQuotes(book, symbols) {
  const keys = symbols && symbols.length ? symbols : Object.keys(book);
  let newest = 0;
  for (const key of Object.keys(book)) newest = Math.max(newest, Number(book[key]?.ts) || 0);
  const result = {};
  for (const key of keys) {
    const quote = book[key];
    const ts = Number(quote?.ts) || 0;
    if (!quote || ts <= 0) continue;
    if (newest - ts > STALE_GAP_MS) continue;
    result[key] = quote;
  }
  return result;
}
