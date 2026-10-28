// Option chain engine for the live server: Angel One packet parsing and chain assembly.
// Pure functions; index.js owns the sockets and the book. The pricing maths is the shared option-math module
// (a copy lives next to this file as option-math.cjs; a test keeps the two identical).
import { createRequire } from "node:module";
import { angelFeedTimeMs, exchangeTimeMs } from "./price-book.js";

const M = createRequire(import.meta.url)("./option-math.cjs");

export const EXCHANGE_TYPE = { NSE: 1, NFO: 2, BSE: 3, BFO: 4 };
export const bookKey = (exchangeType, token) => `${exchangeType}:${String(token)}`;

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// SNAP_QUOTE packet, 379 bytes. Offsets from the SmartAPI WebSocket 2.0 specification; prices are in paise.
// Packets shorter than the full layout are read as far as they go: LTP only (51), quote fields (123), OI (147), depth (347).
export function parseSnapPacket(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 51) return null;
  const mode = buf.readUInt8(0);
  if (mode < 1 || mode > 3) return null;
  const exchangeType = buf.readUInt8(1);
  const token = buf.subarray(2, 27).toString("utf8").replace(/\0/g, "").trim();
  if (!token) return null;
  const out = {
    mode, exchangeType, token,
    ts: exchangeTimeMs(Number(buf.readBigInt64LE(35))),
    ltp: Number(buf.readBigInt64LE(43)) / 100,
  };
  if (buf.length >= 123) {
    out.ltq = Number(buf.readBigInt64LE(51));
    out.avgPrice = Number(buf.readBigInt64LE(59)) / 100;
    out.volume = Number(buf.readBigInt64LE(67));
    out.totalBuy = buf.readDoubleLE(75);
    out.totalSell = buf.readDoubleLE(83);
    out.open = Number(buf.readBigInt64LE(91)) / 100;
    out.high = Number(buf.readBigInt64LE(99)) / 100;
    out.low = Number(buf.readBigInt64LE(107)) / 100;
    out.close = Number(buf.readBigInt64LE(115)) / 100;
  }
  if (buf.length >= 147) {
    out.lastTradeTs = exchangeTimeMs(Number(buf.readBigInt64LE(123)));
    out.oi = Number(buf.readBigInt64LE(131));
    out.oiChangePct = buf.readDoubleLE(139);
  }
  if (buf.length >= 347) {
    const bids = [], asks = [];
    for (let i = 0; i < 10; i++) {
      const at = 147 + i * 20;
      const level = { qty: Number(buf.readBigInt64LE(at + 2)), price: Number(buf.readBigInt64LE(at + 10)) / 100, orders: buf.readInt16LE(at + 18) };
      // The first five slots are the buy side, the next five the sell side; empty slots carry zeros and are dropped.
      if (level.price > 0 && level.qty > 0) (i < 5 ? bids : asks).push(level);
    }
    out.bids = bids; out.asks = asks;
  }
  const finite = [out.ltp, out.open, out.high, out.low, out.close].every(v => v === undefined || (Number.isFinite(v) && v >= 0));
  return finite && out.ltp > 0 ? out : null;
}

// One row of the REST quote API (mode FULL) in the same shape the packet parser produces.
export function parseRestQuote(row, exchangeType) {
  const ltp = num(row?.ltp);
  const token = String(row?.symbolToken || row?.symboltoken || "");
  if (!token || ltp <= 0) return null;
  const level = x => ({ qty: num(x.quantity), price: num(x.price), orders: num(x.orders) });
  const depth = row.depth || {};
  const pct = row.oiChangePercentage ?? row.opnInterestChange ?? row.openInterestChangePercentage;
  return {
    mode: 3, exchangeType, token, ltp,
    ts: exchangeTimeMs(angelFeedTimeMs(row.exchFeedTime || row.exchTradeTime)),
    open: num(row.open), high: num(row.high), low: num(row.low), close: num(row.close),
    volume: num(row.tradeVolume || row.volume),
    avgPrice: num(row.avgPrice),
    oi: num(row.opnInterest || row.openInterest),
    oiChangePct: pct === undefined ? undefined : num(pct),
    bids: Array.isArray(depth.buy) ? depth.buy.map(level) : [],
    asks: Array.isArray(depth.sell) ? depth.sell.map(level) : [],
  };
}

// Keeps the newest packet per instrument; a packet without an exchange time never replaces one that has it.
export function storeTick(book, tick) {
  const key = bookKey(tick.exchangeType, tick.token);
  const held = book.get(key);
  if (held && held.ts > 0 && tick.ts > 0 && tick.ts < held.ts) return false;
  // Depth and OI arrive only on richer packets; keep what a thinner packet does not carry.
  book.set(key, held ? { ...held, ...Object.fromEntries(Object.entries(tick).filter(([, v]) => v !== undefined)) } : tick);
  return true;
}

const round = (v, d = 2) => (Number.isFinite(v) ? +v.toFixed(d) : null);

function legView(ref, tick, extra) {
  if (!ref) return null;
  const ltp = tick?.ltp > 0 ? tick.ltp : 0;
  const close = tick?.close > 0 ? tick.close : 0;
  const pct = Number.isFinite(tick?.oiChangePct) ? tick.oiChangePct : null;
  const oi = tick?.oi > 0 ? tick.oi : 0;
  const best = list => (Array.isArray(list) && list[0] && list[0].price > 0 ? list[0] : null);
  const bid = best(tick?.bids), ask = best(tick?.asks);
  return {
    token: ref.token, symbol: ref.symbol,
    ltp: ltp || null,
    chg: ltp && close ? round(ltp - close) : null,
    chgPct: ltp && close ? round((ltp / close - 1) * 100) : null,
    oi, oiChg: pct !== null && oi ? Math.round(oi - oi / (1 + pct / 100)) : null,
    volume: tick?.volume || 0,
    bid: bid ? round(bid.price) : null, bidQty: bid?.qty ?? null, ask: ask ? round(ask.price) : null, askQty: ask?.qty ?? null,
    ts: tick?.ts || 0,
    ...extra,
  };
}

// meta: one underlying's entry from /api/instruments?source=options. book: Map of bookKey -> latest tick.
export function buildChain({ meta, expiry, book, now = Date.now(), width = 20 }) {
  const exp = meta.expiries.find(e => e.date === expiry);
  if (!exp) return null;
  const strikes = exp.strikes;
  const spotTick = book.get(bookKey(EXCHANGE_TYPE[meta.spot.exchange] || 1, meta.spot.token));
  const spot = spotTick?.ltp > 0 ? spotTick.ltp : null;

  const tickOf = ref => (ref ? book.get(bookKey(EXCHANGE_TYPE.NFO, ref.token)) : null);
  // The window is centred on the strike nearest the spot, or on the middle of the list while no spot is known.
  let centre = Math.floor(strikes.length / 2);
  if (spot) {
    let bestGap = Infinity;
    strikes.forEach((s, i) => { const gap = Math.abs(s.k - spot); if (gap < bestGap) { bestGap = gap; centre = i; } });
  }
  const from = Math.max(0, centre - width), to = Math.min(strikes.length, centre + width + 1);
  const slice = strikes.slice(from, to);

  const T = M.yearsToExpiry(expiry, now);
  const preRows = slice.map(s => ({ strike: s.k, ce: { ltp: tickOf(s.ce)?.ltp || 0 }, pe: { ltp: tickOf(s.pe)?.ltp || 0 } }));
  const forward = M.impliedForward(preRows, T) || (spot ? spot * Math.exp(M.RATE * T) : null);

  const rows = slice.map(s => {
    const ceTick = tickOf(s.ce), peTick = tickOf(s.pe);
    let iv = null;
    if (forward) {
      // Implied volatility is read from the out-of-the-money option of each strike, then used for both sides.
      const otmIsCall = s.k >= forward;
      const otm = otmIsCall ? ceTick : peTick;
      iv = otm?.ltp > 0 ? M.impliedVol(otmIsCall ? "CE" : "PE", otm.ltp, forward, s.k, T) : null;
      if (iv === null) {
        const itm = otmIsCall ? peTick : ceTick;
        iv = itm?.ltp > 0 ? M.impliedVol(otmIsCall ? "PE" : "CE", itm.ltp, forward, s.k, T) : null;
      }
    }
    const g = type => (iv && forward ? M.greeks(type, forward, s.k, T, iv) : null);
    const gc = g("CE"), gp = g("PE");
    const greekPart = (gr, v) => ({ iv: v ? round(v * 100, 2) : null, delta: gr ? round(gr.delta, 3) : null, gamma: gr ? +gr.gamma.toFixed(5) : null, theta: gr ? round(gr.theta, 2) : null, vega: gr ? round(gr.vega, 2) : null });
    return {
      strike: s.k,
      ce: legView(s.ce, ceTick, greekPart(gc, iv)),
      pe: legView(s.pe, peTick, greekPart(gp, iv)),
    };
  });

  let atm = rows.length ? rows[Math.min(rows.length - 1, Math.max(0, centre - from))] : null;
  const straddle = atm?.ce?.ltp && atm?.pe?.ltp ? round(atm.ce.ltp + atm.pe.ltp) : null;
  const newest = rows.reduce((t, r) => Math.max(t, r.ce?.ts || 0, r.pe?.ts || 0), spotTick?.ts || 0);

  return {
    underlying: meta.name, label: meta.label, expiry, lotSize: meta.lotSize, tickSize: meta.tick,
    daysToExpiry: M.daysToExpiry(expiry, now),
    spot: round(spot), spotPrev: spotTick?.close > 0 ? round(spotTick.close) : null,
    spotChgPct: spot && spotTick?.close > 0 ? round((spot / spotTick.close - 1) * 100) : null,
    forward: round(forward), atmStrike: atm?.strike ?? null, atmIv: atm?.ce?.iv ?? null,
    straddle, expectedMovePct: straddle && spot ? round(straddle / spot * 100) : null,
    pcr: round(M.putCallRatio(rows), 2), maxPain: M.maxPain(rows),
    totalCeOi: rows.reduce((t, r) => t + (r.ce?.oi || 0), 0), totalPeOi: rows.reduce((t, r) => t + (r.pe?.oi || 0), 0),
    asOf: newest || null, ageMs: newest ? Math.max(0, now - newest) : null,
    rows,
  };
}

// Tokens worth streaming for one chain view, as { exchange, exchangeType, token } (spot index plus the window of strikes).
export function windowTokens({ meta, expiry, spot, width = 20 }) {
  const exp = meta.expiries.find(e => e.date === expiry);
  if (!exp) return [];
  const strikes = exp.strikes;
  let centre = Math.floor(strikes.length / 2);
  if (spot) {
    let bestGap = Infinity;
    strikes.forEach((s, i) => { const gap = Math.abs(s.k - spot); if (gap < bestGap) { bestGap = gap; centre = i; } });
  }
  const list = [{ exchange: meta.spot.exchange, exchangeType: EXCHANGE_TYPE[meta.spot.exchange] || 1, token: meta.spot.token }];
  for (const s of strikes.slice(Math.max(0, centre - width - 3), Math.min(strikes.length, centre + width + 4))) {
    if (s.ce) list.push({ exchange: "NFO", exchangeType: 2, token: s.ce.token });
    if (s.pe) list.push({ exchange: "NFO", exchangeType: 2, token: s.pe.token });
  }
  return list;
}

// Finds one contract by underlying, expiry (YYYY-MM-DD), strike and type. Used for positions, which can sit in any expiry.
export function resolveContract(metaAll, underlying, expiry, strike, type) {
  const u = metaAll?.[String(underlying || "").toUpperCase()];
  const exp = u?.expiries.find(e => e.date === expiry);
  const row = exp?.strikes.find(x => x.k === Number(strike));
  const side = String(type || "").toUpperCase() === "PE" ? row?.pe : String(type || "").toUpperCase() === "CE" ? row?.ce : null;
  return side ? { token: side.token, symbol: side.symbol, lotSize: u.lotSize, exchange: "NFO", exchangeType: EXCHANGE_TYPE.NFO } : null;
}

// What a position needs from a quote: price, previous close, spread and the data time.
export function quoteView(tick) {
  if (!tick || !(tick.ltp > 0)) return null;
  const best = list => (Array.isArray(list) && list[0] && list[0].price > 0 ? round(list[0].price) : null);
  return {
    ltp: round(tick.ltp), close: tick.close > 0 ? round(tick.close) : null,
    bid: best(tick.bids), ask: best(tick.asks), oi: tick.oi > 0 ? tick.oi : 0, volume: tick.volume || 0, ts: tick.ts || 0,
  };
}

// ─── Option candle history ───────────────────────────────────────────────────
// Angel One's historical API serves futures-and-options contracts too. Intraday intervals are passed through; the site builds
// weekly and monthly candles from daily ones.
export const CANDLE_INTERVALS = {
  ONE_MINUTE: 5, THREE_MINUTE: 10, FIVE_MINUTE: 10, TEN_MINUTE: 20, FIFTEEN_MINUTE: 30, THIRTY_MINUTE: 45, ONE_HOUR: 90, ONE_DAY: 400,
};
const IST_MS = 5.5 * 3600 * 1000;
const pad = n => String(n).padStart(2, "0");
const istStamp = ms => { const d = new Date(ms + IST_MS); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };

// Returns the body for getCandleData, or null when the token or interval is not acceptable.
export function candleRequest(token, interval, now = Date.now()) {
  const days = CANDLE_INTERVALS[interval];
  if (!/^\d{1,9}$/.test(String(token || "")) || !days) return null;
  return { exchange: "NFO", symboltoken: String(token), interval, fromdate: istStamp(now - days * 86400000), todate: istStamp(now) };
}

// rows: [["2026-10-28T09:15:00+05:30", open, high, low, close, volume], ...]. Daily candles carry the trading date at 15:30
// like the site's other daily history (YYYY-MM-DDT15:30:00.000Z); intraday ones carry their real time.
export function parseCandles(rows, interval) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const at = Date.parse(row[0]);
    const [open, high, low, close, volume] = row.slice(1, 6).map(Number);
    if (!Number.isFinite(at) || ![open, high, low, close].every(v => Number.isFinite(v) && v > 0) || high < low) continue;
    const time = interval === "ONE_DAY" ? `${new Date(at + IST_MS).toISOString().slice(0, 10)}T15:30:00.000Z` : new Date(at).toISOString();
    out.push({ time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 });
  }
  return out.sort((a, b) => a.time.localeCompare(b.time));
}
