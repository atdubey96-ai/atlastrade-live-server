// Turns the site's data-health reports into at most a few useful messages.
//
// A single bad check is often a blip, so a source must be unhealthy on two checks in a row before anyone is told, the same
// problem is not repeated for six hours, and when the source recovers (two good checks in a row) one "recovered" message follows.

const NAMES = { liveServer: "Indian live prices", usFeed: "US prices", crypto: "Crypto prices", mutualFunds: "Mutual fund NAV", calendar: "Market calendar", database: "Cloud database" };
export const CHECKS_BEFORE_ALERT = 2;
export const REPEAT_AFTER_MS = 6 * 60 * 60 * 1000;

export function emptyState() { return {}; }

// state: { [feed]: { bad: n, good: n, alerted: "degraded"|"down"|null, alertedAt: ms } } ; report: { feeds: { name: { status, detail } } }
export function evaluate(state, report, now = Date.now()) {
  const next = { ...state };
  const messages = [];
  for (const [feed, result] of Object.entries(report?.feeds || {})) {
    const label = NAMES[feed] || feed;
    const held = { bad: 0, good: 0, alerted: null, alertedAt: 0, ...(state[feed] || {}) };
    const healthy = result.status === "ok";
    if (healthy) {
      held.bad = 0; held.good += 1;
      if (held.alerted && held.good >= CHECKS_BEFORE_ALERT) { messages.push(`✅ ${label} recovered.`); held.alerted = null; held.alertedAt = 0; }
    } else {
      held.good = 0; held.bad += 1;
      const sameProblemRecently = held.alerted === result.status && now - held.alertedAt < REPEAT_AFTER_MS;
      if (held.bad >= CHECKS_BEFORE_ALERT && !sameProblemRecently) {
        const word = result.status === "down" ? "is not responding" : "is slow or stale";
        messages.push(`⚠️ ${label} ${word}${result.detail ? ` (${result.detail})` : ""}. Prices from this source may be old; your other data is unaffected.`);
        held.alerted = result.status; held.alertedAt = now;
      }
    }
    next[feed] = held;
  }
  return { state: next, messages };
}
