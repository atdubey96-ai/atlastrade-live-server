import test from "node:test";
import assert from "node:assert/strict";
import { parseSnapPacket, parseRestQuote, storeTick, buildChain, windowTokens, bookKey, resolveContract, quoteView, candleRequest, parseCandles } from "./options.js";
import { createRequire } from "node:module";
const M = createRequire(import.meta.url)("./option-math.cjs");

const NOW = Date.parse("2026-10-28T06:00:00Z");

function packet({ exchangeType = 2, token = "39756", ltp = 150.25, volume = 1234, open = 140, high = 160, low = 135, close = 145, oi = 54000, oiPct = 5.5, bids = [[100, 150.2, 3]], asks = [[200, 150.3, 5]], ts = NOW } = {}) {
  const b = Buffer.alloc(379);
  b.writeUInt8(3, 0); b.writeUInt8(exchangeType, 1);
  b.write(token, 2, "utf8");
  b.writeBigInt64LE(1n, 27); b.writeBigInt64LE(BigInt(ts), 35);
  b.writeBigInt64LE(BigInt(Math.round(ltp * 100)), 43);
  b.writeBigInt64LE(75n, 51); b.writeBigInt64LE(14000n, 59); b.writeBigInt64LE(BigInt(volume), 67);
  b.writeDoubleLE(1000, 75); b.writeDoubleLE(2000, 83);
  b.writeBigInt64LE(BigInt(open * 100), 91); b.writeBigInt64LE(BigInt(high * 100), 99); b.writeBigInt64LE(BigInt(low * 100), 107); b.writeBigInt64LE(BigInt(close * 100), 115);
  b.writeBigInt64LE(BigInt(ts), 123); b.writeBigInt64LE(BigInt(oi), 131); b.writeDoubleLE(oiPct, 139);
  const put = (i, flag, [qty, price, orders]) => { const at = 147 + i * 20; b.writeInt16LE(flag, at); b.writeBigInt64LE(BigInt(qty), at + 2); b.writeBigInt64LE(BigInt(Math.round(price * 100)), at + 10); b.writeInt16LE(orders, at + 18); };
  bids.forEach((x, i) => put(i, 1, x)); asks.forEach((x, i) => put(5 + i, 0, x));
  return b;
}

test("a snap quote packet is read field by field", () => {
  const t = parseSnapPacket(packet());
  assert.equal(t.token, "39756"); assert.equal(t.exchangeType, 2);
  assert.equal(t.ltp, 150.25); assert.equal(t.volume, 1234); assert.equal(t.close, 145);
  assert.equal(t.oi, 54000); assert.equal(t.oiChangePct, 5.5);
  assert.deepEqual(t.bids[0], { qty: 100, price: 150.2, orders: 3 });
  assert.deepEqual(t.asks[0], { qty: 200, price: 150.3, orders: 5 });
});

test("short or broken packets are refused, not guessed at", () => {
  assert.equal(parseSnapPacket(Buffer.alloc(10)), null);
  assert.equal(parseSnapPacket(packet({ token: "" })), null);
  assert.equal(parseSnapPacket(packet({ ltp: 0 })), null);
  const lite = packet().subarray(0, 123);
  const t = parseSnapPacket(lite);
  assert.equal(t.oi, undefined); assert.equal(t.bids, undefined); assert.equal(t.volume, 1234);
});

test("a thinner packet keeps depth and open interest already held, and old ticks never win", () => {
  const book = new Map();
  storeTick(book, parseSnapPacket(packet({ ts: NOW })));
  storeTick(book, parseSnapPacket(packet({ ltp: 151, ts: NOW + 1000 }).subarray(0, 123)));
  const held = book.get(bookKey(2, "39756"));
  assert.equal(held.ltp, 151); assert.equal(held.oi, 54000);
  assert.equal(storeTick(book, parseSnapPacket(packet({ ltp: 99, ts: NOW - 5000 }))), false);
  assert.equal(book.get(bookKey(2, "39756")).ltp, 151);
});

test("REST quote rows map to the same shape", () => {
  const t = parseRestQuote({ symbolToken: "39756", ltp: 150.25, open: 140, high: 160, low: 135, close: 145, tradeVolume: 99, opnInterest: 54000, exchFeedTime: "28-Oct-2026 11:30:00", depth: { buy: [{ price: 150.2, quantity: 100, orders: 3 }], sell: [{ price: 150.3, quantity: 200, orders: 5 }] } }, 2);
  assert.equal(t.oi, 54000); assert.equal(t.bids[0].price, 150.2); assert.equal(t.asks[0].qty, 200); assert.ok(t.ts > 0);
  assert.equal(parseRestQuote({ symbolToken: "1", ltp: 0 }, 2), null);
});

function fixture() {
  const strikes = [];
  for (let k = 22000; k <= 23000; k += 50) strikes.push({ k, ce: { token: `C${k}`, symbol: `NIFTY03NOV26${k}CE` }, pe: { token: `P${k}`, symbol: `NIFTY03NOV26${k}PE` } });
  const meta = { name: "NIFTY", label: "Nifty 50", lotSize: 65, tick: 5, spot: { token: "99926000", exchange: "NSE" }, expiries: [{ date: "2026-11-03", monthly: false, strikes }] };
  const F = 22520, T = M.yearsToExpiry("2026-11-03", NOW);
  const book = new Map();
  book.set(bookKey(1, "99926000"), { exchangeType: 1, token: "99926000", ltp: 22500, close: 22450, ts: NOW });
  for (const s of strikes) {
    const c = M.price("CE", F, s.k, T, 0.13), p = M.price("PE", F, s.k, T, 0.13);
    book.set(bookKey(2, s.ce.token), { exchangeType: 2, token: s.ce.token, ltp: +c.toFixed(2), close: +(c * 1.02).toFixed(2), oi: 100000 + (s.k < 22500 ? 0 : 50000), oiChangePct: 4, volume: 5000, ts: NOW });
    book.set(bookKey(2, s.pe.token), { exchangeType: 2, token: s.pe.token, ltp: +p.toFixed(2), close: +(p * 0.98).toFixed(2), oi: 120000 + (s.k > 22500 ? 0 : 60000), oiChangePct: -2, volume: 6000, ts: NOW });
  }
  return { meta, book };
}

test("the chain is centred on the spot with implied volatility recovered from prices", () => {
  const { meta, book } = fixture();
  const chain = buildChain({ meta, expiry: "2026-11-03", book, now: NOW, width: 6 });
  assert.equal(chain.atmStrike, 22500);
  assert.equal(chain.rows.length, 13);
  assert.equal(chain.spot, 22500);
  assert.ok(Math.abs(chain.forward - 22520) < 15, `forward ${chain.forward}`);
  const atm = chain.rows[6];
  assert.ok(Math.abs(atm.ce.iv - 13) < 0.6, `iv ${atm.ce.iv}`);
  assert.ok(atm.ce.delta > 0.4 && atm.ce.delta < 0.6 && atm.pe.delta < -0.4 && atm.pe.delta > -0.6);
  assert.ok(atm.ce.theta < 0 && atm.ce.vega > 0);
  assert.equal(atm.ce.oi, 150000);
  assert.equal(atm.ce.oiChg, Math.round(150000 - 150000 / 1.04));
  assert.ok(chain.straddle > 0 && chain.expectedMovePct > 0);
  assert.ok(chain.pcr > 0);
  assert.ok(chain.maxPain >= 22200 && chain.maxPain <= 22800);
  assert.equal(chain.ageMs, 0);
});

test("missing quotes leave blanks instead of invented numbers", () => {
  const { meta, book } = fixture();
  book.delete(bookKey(2, "C22500")); book.delete(bookKey(1, "99926000"));
  const chain = buildChain({ meta, expiry: "2026-11-03", book, now: NOW, width: 3 });
  assert.equal(chain.spot, null);
  const row = chain.rows.find(r => r.strike === 22500);
  assert.equal(row.ce.ltp, null); assert.equal(row.ce.oi, 0);
  assert.equal(buildChain({ meta, expiry: "2030-01-01", book, now: NOW }), null);
});

test("the streamed window covers the visible strikes plus a margin on each side", () => {
  const { meta } = fixture();
  const tokens = windowTokens({ meta, expiry: "2026-11-03", spot: 22500, width: 4 });
  assert.equal(tokens[0].token, "99926000");
  assert.ok(tokens.some(t => t.token === "C22500") && tokens.some(t => t.token === "P22350"));
  assert.ok(tokens.length <= 1 + 2 * (2 * 4 + 7));
});

test("a position's contract is found by underlying, expiry, strike and type", () => {
  const { meta } = fixture();
  const all = { NIFTY: meta };
  const c = resolveContract(all, "nifty", "2026-11-03", 22500, "ce");
  assert.equal(c.token, "C22500"); assert.equal(c.lotSize, 65); assert.equal(c.exchangeType, 2);
  assert.equal(resolveContract(all, "NIFTY", "2026-11-03", 22500, "PE").symbol, "NIFTY03NOV2622500PE");
  assert.equal(resolveContract(all, "NIFTY", "2026-11-03", 22525, "CE"), null);
  assert.equal(resolveContract(all, "NIFTY", "2030-01-01", 22500, "CE"), null);
  assert.equal(resolveContract(all, "SENSEX", "2026-11-03", 22500, "CE"), null);
});

test("a quote view carries price, previous close and spread, and nothing for an unpriced contract", () => {
  const v = quoteView({ ltp: 150.25, close: 145, oi: 5000, volume: 10, ts: NOW, bids: [{ price: 150.2, qty: 5 }], asks: [{ price: 150.3, qty: 5 }] });
  assert.equal(v.ltp, 150.25); assert.equal(v.close, 145); assert.equal(v.bid, 150.2); assert.equal(v.ask, 150.3);
  assert.equal(quoteView({ ltp: 0 }), null); assert.equal(quoteView(undefined), null);
});

test("a candle request is built for one contract, with IST times, and bad input is refused", () => {
  const now = Date.parse("2026-10-28T06:00:00Z"); // 11:30 IST
  const r = candleRequest("53782", "FIVE_MINUTE", now);
  assert.equal(r.exchange, "NFO"); assert.equal(r.symboltoken, "53782"); assert.equal(r.interval, "FIVE_MINUTE");
  assert.equal(r.todate, "2026-10-28 11:30"); assert.equal(r.fromdate, "2026-10-18 11:30");
  assert.equal(candleRequest("53782", "ONE_DAY", now).fromdate, "2025-09-23 11:30");
  assert.equal(candleRequest("53782; DROP", "ONE_DAY", now), null);
  assert.equal(candleRequest("53782", "ONE_WEEK", now), null);
  assert.equal(candleRequest("", "ONE_DAY", now), null);
});

test("candles are parsed, sorted, and junk rows are dropped", () => {
  const rows = [
    ["2026-10-28T09:20:00+05:30", 101, 103, 100, 102, 500],
    ["2026-10-28T09:15:00+05:30", 100, 102, 99, 101, 800],
    ["2026-10-28T09:25:00+05:30", 0, 0, 0, 0, 0],
    ["nonsense"], null,
    ["2026-10-28T09:30:00+05:30", 102, 101, 103, 102, 10], // high below low
  ];
  const c = parseCandles(rows, "FIVE_MINUTE");
  assert.equal(c.length, 2);
  assert.equal(c[0].time, "2026-10-28T03:45:00.000Z"); assert.equal(c[0].open, 100); assert.equal(c[1].close, 102);
  const d = parseCandles([["2026-10-27T00:00:00+05:30", 90, 95, 88, 93, 1000]], "ONE_DAY");
  assert.equal(d[0].time, "2026-10-27T15:30:00.000Z");
  assert.deepEqual(parseCandles(undefined, "ONE_DAY"), []);
});

test("effectivePrice: a last price outside a tight book gives way to the mid, a price inside it stands", async () => {
  const { effectivePrice } = await import("./options.js");
  const book = (b, a) => ({ bids: [{ price: b, qty: 1 }], asks: [{ price: a, qty: 1 }] });
  assert.equal(effectivePrice({ ltp: 2317.55, ...book(2657.1, 2718.6) }), 2687.85);   // stale deep in-the-money print
  assert.equal(effectivePrice({ ltp: 410.65, ...book(410.0, 411.75) }), 410.65);      // inside the book
  assert.equal(effectivePrice({ ltp: 100, ...book(50, 100) }), 100);                  // wide book is not trusted
  assert.equal(effectivePrice({ ltp: 55 }), 55);                                      // no book
  assert.equal(effectivePrice({ ltp: 0, ...book(20, 21) }), 20.5);                    // no trade yet, quote exists
  assert.equal(effectivePrice(null), 0);
});

test("chain legs carry the fair price as ltp and keep the raw last price", async () => {
  const { quoteView } = await import("./options.js");
  const q = quoteView({ ltp: 2317.55, close: 2000, bids: [{ price: 2657.1, qty: 1 }], asks: [{ price: 2718.6, qty: 1 }] });
  assert.equal(q.ltp, 2687.85);
  assert.equal(q.last, 2317.55);
  const quiet = quoteView({ ltp: 100.5, close: 99, bids: [{ price: 100, qty: 1 }], asks: [{ price: 101, qty: 1 }] });
  assert.equal(quiet.ltp, 100.5);
});
