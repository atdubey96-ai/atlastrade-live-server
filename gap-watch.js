// Per-instrument gap detection for the live tick feed.
//
// A silent stock is not necessarily a broken feed: a thinly traded name can go minutes between trades. So each instrument is
// compared with ITS OWN usual rhythm (a running average of the time between its ticks). While the market is open, an instrument
// that has been silent for much longer than that rhythm is "gapped": its price may be stale because ticks were missed. Gapped
// instruments get a fresh price from the REST snapshot; the count of gapped instruments is a direct measure of feed coverage.

const IST_OFFSET_MS = 5.5 * 3600 * 1000;

// Today's 09:15 IST as epoch ms (the instant the cash market opened).
export function openedAtIst(now = Date.now()) {
  const ist = new Date(now + IST_OFFSET_MS);
  return Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 9, 15) - IST_OFFSET_MS;
}

export function createGapWatch({ minThresholdMs = 90000, maxThresholdMs = 600000, factor = 8, minTicks = 6, alpha = 0.2, learnLimitMs = 15 * 60000, defaultThresholdMs = 300000 } = {}) {
  const book = new Map();      // symbol -> { last, ewma, ticks, open }
  const closed = [];           // times gaps ended (a tick arrived after a gap was open)
  let triggered = 0;

  function observe(symbol, ts, now = Date.now()) {
    const t = Number(ts) || 0;
    if (!symbol || t <= 0) return;
    let s = book.get(symbol);
    if (!s) { s = { last: 0, ewma: 0, ticks: 0, open: false, checkedAt: 0 }; book.set(symbol, s); }
    if (t <= s.last) return;                      // not a new tick
    if (s.last > 0) {
      const gap = t - s.last;
      // Only learn the rhythm from gaps inside a session: an overnight or weekend gap says nothing about trading frequency.
      if (gap <= learnLimitMs) s.ewma = s.ewma ? alpha * gap + (1 - alpha) * s.ewma : gap;
    }
    s.last = t; s.ticks += 1;
    if (s.open) { s.open = false; closed.push(now); }
  }
  // The snapshot was asked about this instrument and had nothing newer: it is genuinely quiet, so do not ask again until a
  // full threshold has passed.
  function checked(symbol, now = Date.now()) { const s = book.get(symbol); if (s) s.checkedAt = now; }
  function thresholdFor(s) {
    if (s.ticks < minTicks || !s.ewma) return defaultThresholdMs;
    return Math.min(maxThresholdMs, Math.max(minThresholdMs, factor * s.ewma));
  }
  // Instruments silent for longer than their own threshold. marketOpen false => nothing is expected, so nothing is a gap.
  function gapped(now = Date.now(), marketOpen = false, openedAt = openedAtIst(now)) {
    if (!marketOpen) return [];
    const out = [];
    for (const [symbol, s] of book) {
      // Silence is measured from the later of the last tick and the market opening: yesterday's last tick is not a gap today.
      const silentFor = now - Math.max(s.last, openedAt);
      if (silentFor > thresholdFor(s) && now - openedAt > thresholdFor(s) && now - s.checkedAt > thresholdFor(s)) { out.push(symbol); if (!s.open) { s.open = true; triggered += 1; } }
    }
    return out;
  }
  function stats(now = Date.now(), marketOpen = false, openedAt = openedAtIst(now)) {
    const gappedNow = gapped(now, marketOpen, openedAt).length;
    while (closed.length && now - closed[0] > 3600000) closed.shift();
    return { watching: book.size, gappedNow, gapsClosedLastHour: closed.length, gapsOpenedTotal: triggered, coverage: book.size ? 1 - gappedNow / book.size : 1 };
  }
  function forget(symbol) { book.delete(symbol); }
  return { observe, checked, gapped, stats, forget, size: () => book.size };
}
