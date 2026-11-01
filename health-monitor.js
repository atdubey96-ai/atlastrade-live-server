// Turns the site's data-health reports into at most a few useful messages.
//
// A single bad check is often a blip, so a source must be unhealthy on two checks in a row before anyone is told, the same
// problem is not repeated for six hours, and when the source recovers (two good checks in a row) one "recovered" message follows.

const NAMES = { quoteQuality: "Device quote validation", liveServer: "Indian live prices", usFeed: "US prices", crypto: "Crypto prices", mutualFunds: "Mutual fund NAV", calendar: "Market calendar", database: "Cloud database" };
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
    // No device reports (or the same cached report twice) cannot establish recovery.
    const unknown = !["ok","degraded","down"].includes(result.status) ||
      (feed === "quoteQuality" && (result.reportingDevices === 0 || result.blockingFailureRate === null));
    if (unknown) { held.good=0; held.bad=0; next[feed]=held; continue; }
    if (feed === "quoteQuality" && Number.isFinite(result.observationAt)) {
      if (result.observationAt <= (held.observationAt || 0)) { next[feed]=held; continue; }
      held.observationAt=result.observationAt;
    }
    // A recovery needs a clear margin below the 20% failure threshold.
    if(feed === "quoteQuality" && result.status === "ok" && result.blockingFailureRate > 0.1) {
      held.good=0;held.bad=0;next[feed]=held;continue;
    }
    const healthy = result.status === "ok";
    if (healthy) {
      held.bad = 0; held.badStatus=null; held.good += 1;
      if (held.alerted && held.good >= CHECKS_BEFORE_ALERT) { messages.push(`✅ ${label} recovered.`); held.alerted = null; held.alertedAt = 0; }
    } else {
      held.good = 0; held.bad = held.badStatus === result.status ? held.bad+1 : 1; held.badStatus=result.status;
      const previousSeverity=held.lastSeverity || held.alerted;
      const sameProblemRecently = !!previousSeverity && now - (held.lastNotificationAt ?? held.alertedAt) < REPEAT_AFTER_MS && !(result.status === "down" && previousSeverity !== "down");
      if (held.bad >= CHECKS_BEFORE_ALERT && !sameProblemRecently) {
        const word = result.status === "down" ? "is not responding" : feed === "quoteQuality" ? "is rejecting quote updates" : "is slow or stale";
        const impact = feed === "quoteQuality" ? (result.status === "down" ? "Device validation reporting is unavailable; current device quality cannot be verified." : "Rejected values are not applied. Check device data health before relying on displayed prices.") :
          feed === "calendar" ? "Exchange holiday verification is unavailable; market-session status may be uncertain. This is not a price-feed outage." :
          feed === "database" ? "Cloud access may be affected; check sync status before editing on another device." :
          "This source may have delayed or missing prices; check its timestamp before relying on them.";
        messages.push(`⚠️ ${label} ${word}${result.detail ? ` (${result.detail})` : ""}. ${impact}`);
        held.alerted = result.status; held.alertedAt = now; held.lastNotificationAt=now;held.lastSeverity=result.status;
      }
    }
    next[feed] = held;
  }
  return { state: next, messages };
}
