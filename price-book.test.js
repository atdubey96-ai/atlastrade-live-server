import test from "node:test";
import assert from "node:assert/strict";
import { angelFeedTimeMs, exchangeTimeMs, storeQuote, servableQuotes, inTradingWindow, staleSymbols } from "./price-book.js";

const NOW = Date.parse("2026-10-26T10:40:00Z");
const H = 60 * 60 * 1000;

test("exchangeTimeMs accepts seconds and milliseconds, rejects garbage", () => {
  assert.equal(exchangeTimeMs(1793011092, NOW), 1793011092000);
  assert.equal(exchangeTimeMs(1793011092000, NOW), 1793011092000);
  assert.equal(exchangeTimeMs(0, NOW), 0);
  assert.equal(exchangeTimeMs(NaN, NOW), 0);
  assert.equal(exchangeTimeMs(12345, NOW), 0);
  assert.equal(exchangeTimeMs(NOW + 3 * H, NOW), 0);
  assert.equal(exchangeTimeMs(NOW - 60 * 24 * H, NOW), 0);
});

test("storeQuote keeps the newer quote when an older one arrives", () => {
  const book = {};
  assert.equal(storeQuote(book, "SBIN", { ltp: 960, ts: NOW }), true);
  assert.equal(storeQuote(book, "SBIN", { ltp: 950, ts: NOW - H }), false);
  assert.equal(storeQuote(book, "SBIN", { ltp: 0, ts: 0 }), false);
  assert.equal(book.SBIN.ltp, 960);
  assert.equal(storeQuote(book, "SBIN", { ltp: 961, ts: NOW + 1000 }), true);
});

test("an unverified quote is replaced by the first verified one", () => {
  const book = { HFCL: { ltp: 226, ts: 0 } };
  assert.equal(storeQuote(book, "HFCL", { ltp: 244, ts: NOW }), true);
  assert.equal(book.HFCL.ltp, 244);
});

test("servableQuotes drops unverified and left-behind quotes", () => {
  const book = {
    SBIN: { ltp: 960, ts: NOW },
    HFCL: { ltp: 226, ts: NOW - 13 * H },
    KRN: { ltp: 1226, ts: 0 },
  };
  assert.deepEqual(Object.keys(servableQuotes(book)), ["SBIN"]);
  assert.deepEqual(Object.keys(servableQuotes(book, ["SBIN", "HFCL", "NOPE"])), ["SBIN"]);
});

test("on a holiday, last session quotes stay servable", () => {
  const friday = Date.parse("2026-10-23T10:00:00Z");
  const book = { SBIN: { ltp: 958, ts: friday }, HFCL: { ltp: 240, ts: friday - H } };
  assert.deepEqual(Object.keys(servableQuotes(book)).sort(), ["HFCL", "SBIN"]);
});

test("angelFeedTimeMs reads zone-less snapshot strings as IST", () => {
  const expected = Date.parse("2026-10-26T10:38:12Z");
  assert.equal(angelFeedTimeMs("26-Oct-2026 16:08:12"), expected);
  assert.equal(angelFeedTimeMs("2026-10-26 16:08:12"), expected);
  assert.equal(angelFeedTimeMs("2026-10-26T10:38:12Z"), expected);
  assert.equal(angelFeedTimeMs(1793011092), 1793011092000);
  assert.equal(angelFeedTimeMs(""), 0);
  assert.equal(angelFeedTimeMs("garbage"), 0);
});

test("a snapshot stamped in the future is unverified and cannot block live ticks", () => {
  const farFuture = Date.parse("2026-10-26T16:08:12Z");
  assert.equal(exchangeTimeMs(farFuture, NOW), 0);
});

const at = iso => Date.parse(iso);

test("trading window is weekday 09:00 to 16:30 IST", () => {
  assert.equal(inTradingWindow(at("2026-10-29T10:00:00+05:30")), true);   // Thursday
  assert.equal(inTradingWindow(at("2026-10-29T05:40:09+05:30")), false);  // pre-open replay
  assert.equal(inTradingWindow(at("2026-10-29T17:10:00+05:30")), false);
  assert.equal(inTradingWindow(at("2026-10-31T11:00:00+05:30")), false);  // Saturday
  assert.equal(inTradingWindow(0), false);
});

test("a pre-open replay is never served and never replaces a real close", () => {
  const close = at("2026-10-28T15:29:00+05:30"), replay = at("2026-10-29T05:40:09+05:30");
  const book = { HFCL: { ltp: 243, ts: close } };
  assert.equal(storeQuote(book, "HFCL", { ltp: 226, ts: replay }), false);
  assert.equal(book.HFCL.ltp, 243);
  assert.deepEqual(Object.keys(servableQuotes({ HFCL: { ltp: 226, ts: replay }, SBIN: { ltp: 960, ts: close } }, null)), ["SBIN"]);
});

test("stale symbols are those unverified, out of hours, or silent while the market is open", () => {
  const now = at("2026-10-29T11:00:00+05:30");
  const book = {
    LIVE: { ltp: 1, ts: now - 20000 }, QUIET: { ltp: 1, ts: now - 20 * 60000 },
    REPLAY: { ltp: 1, ts: at("2026-10-29T05:40:09+05:30") }, NOTS: { ltp: 1, ts: 0 },
  };
  assert.deepEqual(staleSymbols(book, { marketOpen: true, now }).sort(), ["NOTS", "QUIET", "REPLAY"]);
  assert.deepEqual(staleSymbols(book, { marketOpen: false, now }).sort(), ["NOTS", "REPLAY"]);
  assert.equal(staleSymbols(book, { marketOpen: true, now, limit: 1 }).length, 1);
});

test('a stopped entire feed cannot look live merely because all its prices are equally old',()=>{const book={SBIN:{ltp:100,ts:NOW}};assert.deepEqual(servableQuotes(book,null,{now:NOW+120000,marketOpen:true}),{});assert.ok(servableQuotes(book,null,{now:NOW+120000,marketOpen:false}).SBIN);});
test('the verified special Sunday session is accepted while other Sunday packets are not',()=>{assert.equal(inTradingWindow(Date.parse('2026-11-08T14:25:00+05:30')),true);assert.equal(inTradingWindow(Date.parse('2026-11-08T10:00:00+05:30')),false);assert.equal(inTradingWindow(Date.parse('2026-11-10T11:00:00+05:30')),false);});
