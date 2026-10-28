(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ZenithOptionMath = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  // Option pricing, implied volatility and Greeks for the option chain. Pure functions, no I/O.
  // Index options are priced with Black-76 on the forward implied by the chain itself (put-call parity), which is how
  // Indian brokers' option analytics treat index options: the forward already contains rates and dividends.

  const MINUTES_PER_YEAR = 365 * 24 * 60;
  const RATE = 0.065;
  const IST_OFFSET_MIN = 330;

  function normPdf(x) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }

  // Abramowitz-Stegun 26.2.17 with a refinement step; accurate to about 1e-7.
  function normCdf(x) {
    const sign = x < 0 ? -1 : 1;
    const ax = Math.abs(x) / Math.SQRT2;
    const t = 1 / (1 + 0.3275911 * ax);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
    return 0.5 * (1 + sign * y);
  }

  // Years left to 15:30 IST on the expiry date (YYYY-MM-DD). Never below a few minutes, so expiry-day maths stays finite.
  function yearsToExpiry(expiryIso, nowMs = Date.now()) {
    const end = Date.parse(`${expiryIso}T15:30:00+05:30`);
    if (!Number.isFinite(end)) return 0;
    return Math.max((end - nowMs) / 60000, 3) / MINUTES_PER_YEAR;
  }

  function daysToExpiry(expiryIso, nowMs = Date.now()) {
    const end = Date.parse(`${expiryIso}T15:30:00+05:30`);
    if (!Number.isFinite(end)) return 0;
    return Math.max(0, Math.ceil((end - nowMs) / 86400000));
  }

  // Black-76: forward F, strike K, time T in years, volatility sigma, rate r.
  function price(type, F, K, T, sigma, r = RATE) {
    const df = Math.exp(-r * T);
    if (!(T > 0) || !(sigma > 0)) return df * Math.max(type === "CE" ? F - K : K - F, 0);
    const sd = sigma * Math.sqrt(T);
    const d1 = (Math.log(F / K) + 0.5 * sd * sd) / sd;
    const d2 = d1 - sd;
    return type === "CE"
      ? df * (F * normCdf(d1) - K * normCdf(d2))
      : df * (K * normCdf(-d2) - F * normCdf(-d1));
  }

  // Implied volatility by bisection (robust where Newton is not, deep in or out of the money). Returns null when the
  // price breaks arbitrage bounds or cannot be matched.
  function impliedVol(type, premium, F, K, T, r = RATE) {
    if (![premium, F, K, T].every(Number.isFinite) || premium <= 0 || F <= 0 || K <= 0 || T <= 0) return null;
    const df = Math.exp(-r * T);
    const intrinsic = df * Math.max(type === "CE" ? F - K : K - F, 0);
    const upper = df * (type === "CE" ? F : K);
    if (premium < intrinsic - 1e-9 || premium > upper) return null;
    let lo = 0.0005, hi = 5;
    if (price(type, F, K, T, hi, r) < premium) return null;
    if (price(type, F, K, T, lo, r) > premium) return null;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      if (price(type, F, K, T, mid, r) < premium) lo = mid; else hi = mid;
      if (hi - lo < 1e-6) break;
    }
    return (lo + hi) / 2;
  }

  // Delta is with respect to the forward; theta is per calendar day; vega is per one volatility point (1%).
  function greeks(type, F, K, T, sigma, r = RATE) {
    if (!(T > 0) || !(sigma > 0) || !(F > 0) || !(K > 0)) return null;
    const df = Math.exp(-r * T);
    const sd = sigma * Math.sqrt(T);
    const d1 = (Math.log(F / K) + 0.5 * sd * sd) / sd;
    const d2 = d1 - sd;
    const pdf = normPdf(d1);
    const delta = df * (type === "CE" ? normCdf(d1) : normCdf(d1) - 1);
    const gamma = df * pdf / (F * sd);
    const vega = df * F * pdf * Math.sqrt(T) / 100;
    const value = price(type, F, K, T, sigma, r);
    const theta = (r * value - df * F * pdf * sigma / (2 * Math.sqrt(T))) / 365;
    return { delta, gamma, theta, vega };
  }

  // Forward from the strike where call and put premiums are closest: F = K + (C - P) * e^(rT).
  function impliedForward(rows, T, r = RATE) {
    let best = null;
    for (const row of rows) {
      const c = row.ce?.ltp, p = row.pe?.ltp;
      if (!(c > 0) || !(p > 0)) continue;
      const gap = Math.abs(c - p);
      if (!best || gap < best.gap) best = { gap, strike: row.strike, forward: row.strike + (c - p) * Math.exp(r * T) };
    }
    return best ? best.forward : null;
  }

  // Strike that costs option writers the least at expiry, by total payout across the listed strikes.
  function maxPain(rows) {
    const usable = rows.filter(r => (r.ce?.oi || 0) > 0 || (r.pe?.oi || 0) > 0);
    if (!usable.length) return null;
    let best = null;
    for (const target of usable) {
      let pain = 0;
      for (const row of usable) {
        pain += Math.max(target.strike - row.strike, 0) * (row.ce?.oi || 0);
        pain += Math.max(row.strike - target.strike, 0) * (row.pe?.oi || 0);
      }
      if (!best || pain < best.pain) best = { pain, strike: target.strike };
    }
    return best.strike;
  }

  function putCallRatio(rows) {
    let ce = 0, pe = 0;
    for (const row of rows) { ce += row.ce?.oi || 0; pe += row.pe?.oi || 0; }
    return ce > 0 ? pe / ce : null;
  }

  return { normCdf, yearsToExpiry, daysToExpiry, price, impliedVol, greeks, impliedForward, maxPain, putCallRatio, RATE };
});
