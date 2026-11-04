import test from "node:test";
import assert from "node:assert/strict";
import { formatUpdate, dueUpdate, findChats, sendTelegram, summarizeHoldings, holdingsLines, isIndiaTradingDay, INDIA_SESSION_KINDS } from "./telegram.js";

const quotes = {
  nifty50: { ltp: 22698.85, prev: 22749.75 }, banknifty: { ltp: 54267.4, prev: 53974.9 }, sensex: { ltp: 73246.03, prev: 73598.67 },
  giftNifty: { ltp: 22702.5, prev: 22733 }, sp500: { ltp: 7734.92, prev: 7722.98 }, gold: { ltp: 117.13, prev: 115.75 },
};
const NOW = Date.parse("2026-10-28T10:30:00Z"); // 16:00 IST Wednesday

test("the update reads clearly, with direction marks and only the data that exists", () => {
  const text = formatUpdate("sample", quotes, {}, NOW);
  assert.match(text, /Zenith sample update · Wed 28 Oct 2026/);
  assert.match(text, /🔴 Nifty 50\s+22,698\.85\s+-0\.22%/);
  assert.match(text, /🟢 Bank Nifty\s+54,267\.40\s+\+0\.54%/);
  assert.doesNotMatch(text, /Bitcoin/); // missing quotes leave no empty rows
  assert.match(text, /This is a sample/);
  assert.ok(text.split("\n").length > 10, "one line per row, not one long line");
  assert.doesNotMatch(text, /\\n/);
});

test("option lines appear when a chain is given", () => {
  const chain = { expiry: "2026-11-03", atmStrike: 22700, atmIv: 15.4, pcr: 0.95, maxPain: 22700, straddle: 357.7, expectedMovePct: 1.58 };
  const text = formatUpdate("close", quotes, { NIFTY: chain }, NOW);
  assert.match(text, /📊 Nifty 03\/11 · ATM 22700 · IV 15\.4% · PCR 0\.95 · max pain 22700 · straddle 358 \(±1\.58%\)/);
  assert.doesNotMatch(text, /GIFT Nifty/); // not in the close message
});

test("each update is due on its own days and time, once a day", () => {
  const at = iso => Date.parse(iso);
  assert.equal(dueUpdate(at("2026-10-28T04:01:00Z"))?.kind, "morning");   // 09:31 IST Wednesday
  assert.equal(dueUpdate(at("2026-10-28T10:11:00Z"))?.kind, "close");     // 15:41 IST
  assert.equal(dueUpdate(at("2026-10-28T14:41:00Z"))?.kind, "evening");   // 20:11 IST
  assert.equal(dueUpdate(at("2026-10-27T20:31:00Z"))?.kind, "night");     // 02:01 IST Wednesday
  assert.equal(dueUpdate(at("2026-10-28T04:01:00Z"), { morning: "2026-10-28" }), null); // already sent
  assert.equal(dueUpdate(at("2026-10-28T05:00:00Z")), null);              // 10:30 IST, nothing due
  assert.equal(dueUpdate(at("2026-10-31T04:01:00Z")), null);              // Saturday 09:31: no morning update
  assert.equal(dueUpdate(at("2026-10-25T20:31:00Z")), null);              // Monday 02:01 IST: no night update
  assert.equal(dueUpdate(at("2026-10-30T20:31:00Z"))?.kind, "night");     // Saturday 02:01 IST (after Friday's US session)
  assert.equal(dueUpdate(at("2026-10-31T20:31:00Z")), null);              // Sunday 02:01 IST
  assert.equal(dueUpdate(at("2026-10-26T04:01:00Z"))?.kind, "morning");   // Monday
});

test("the evening and night updates lead with the US markets and leave out the option lines", () => {
  const chain = { expiry: "2026-11-03", atmStrike: 22700, atmIv: 15.4, pcr: 0.95, maxPain: 22700, straddle: 357.7, expectedMovePct: 1.58 };
  const text = formatUpdate("evening", quotes, { NIFTY: chain }, NOW);
  assert.match(text, /Zenith evening update/);
  assert.ok(text.indexOf("US markets") < text.indexOf("India (closed)"));
  assert.doesNotMatch(text, /Options/);
});

test("sending and chat discovery use the Bot API and report its errors", async () => {
  const calls = [];
  const ok = async (url, o) => { calls.push([url, o && o.body]); return { ok: true, status: 200, json: async () => (url.includes("getUpdates") ? { ok: true, result: [{ message: { chat: { id: 7, type: "private", first_name: "A", last_name: "D" } } }, { message: { chat: { id: 7, type: "private" } } }, { message: { chat: { id: -5, type: "group" } } }] } : { ok: true, result: { message_id: 1 } }) }; };
  assert.deepEqual(await findChats(ok, "T"), [{ id: 7, name: "A D" }]);
  await sendTelegram(ok, "T", 7, "hi");
  assert.match(calls[1][0], /bot T\/sendMessage|botT\/sendMessage/); assert.match(calls[1][1], /"chat_id":7/);
  const bad = async () => ({ ok: false, status: 401, json: async () => ({ ok: false, description: "Unauthorized" }) });
  await assert.rejects(() => sendTelegram(bad, "T", 7, "hi"), /Unauthorized/);
});

const holdings = [
  { symbol: "SBIN", qty: 100, avg: 800 }, { symbol: "TITAN-EQ", qty: 10, avg: 3000 }, { symbol: "ABC", qty: 50, avg: 100 },
  { symbol: "SOMEFUND-MF", qty: 10, avg: 10 }, { symbol: "NVDA-US", qty: 1, avg: 100 }, { symbol: "NOQUOTE", qty: 5, avg: 5 },
];
const quoteOf = sym => ({ SBIN: { ltp: 960, prev: 950 }, TITAN: { ltp: 4000, prev: 4100 }, "TITAN-EQ": { ltp: 4000, prev: 4100 }, ABC: { ltp: 120, prev: 120 } })[sym] || null;

test("holdings are valued from live quotes; funds, US stocks and unpriced symbols are left out", () => {
  const s = summarizeHoldings(holdings, quoteOf);
  assert.equal(s.count, 3);
  assert.equal(s.skipped, 3);                           // fund, US stock and the symbol with no quote
  assert.equal(s.value, 100 * 960 + 10 * 4000 + 50 * 120);
  assert.equal(s.invested, 100 * 800 + 10 * 3000 + 50 * 100);
  assert.equal(s.day, 100 * 10 + 10 * -100);            // SBIN +1,000, TITAN -1,000, ABC 0
  assert.equal(s.best[0].symbol, "SBIN");
  assert.equal(s.worst[0].symbol, "TITAN");
});

test("the holdings block reads clearly and lands in the message", () => {
  const lines = holdingsLines(summarizeHoldings(holdings, quoteOf));
  assert.match(lines[0], /💼 Holdings · 3 Indian stocks/);
  assert.match(lines.join("\n"), /Value ₹1\.\d+ L|Value ₹\d/);
  assert.match(lines.join("\n"), /Total P&L \+₹/);
  assert.deepEqual(holdingsLines(summarizeHoldings([], quoteOf)), []);
  const text = formatUpdate("close", quotes, {}, NOW, lines);
  assert.match(text, /💼 Holdings/);
  assert.ok(text.indexOf("💼 Holdings") > text.indexOf("Nifty 50"));
});

test("a market holiday is declared only when nothing says the market traded today", () => {
  const now = Date.parse("2026-11-10T04:05:00Z");                        // 09:35 IST
  const startOfDay = Date.parse("2026-11-09T18:30:00Z");                 // midnight IST
  assert.equal(isIndiaTradingDay({ now, lastTickAt: startOfDay + 3600000, latestCandleMs: 0 }), true);   // exchange ticks today
  assert.equal(isIndiaTradingDay({ now, lastTickAt: 0, latestCandleMs: startOfDay + 3 * 3600000 }), true);  // Nifty candle today
  assert.equal(isIndiaTradingDay({ now, lastTickAt: startOfDay - 3600000, latestCandleMs: startOfDay - 1000 }), false); // yesterday only
  assert.ok(INDIA_SESSION_KINDS.has("morning") && INDIA_SESSION_KINDS.has("close"));
  assert.ok(!INDIA_SESSION_KINDS.has("evening") && !INDIA_SESSION_KINDS.has("night"));
});


import {formatHoldingsReport,summarizeOptions,formatOptionsReport,detailedReports,reportChunks} from './telegram.js';
test('detailed holdings report ranks ten gainers and ten losers by daily percent, not all-time returns',()=>{
 const holdings=[],quotes={};for(let i=1;i<=15;i++){for(const sign of [1,-1]){const symbol=(sign>0?'UP':'DOWN')+i;holdings.push({symbol,qty:i,avg:5});quotes[symbol]={ltp:100+sign*i,prev:100,asOf:'2026-10-28'};}}
 const report=formatHoldingsReport(summarizeHoldings(holdings,s=>quotes[s]),NOW);
 assert.match(report,/Top 10 daily gainers.*10/);assert.match(report,/1\. UP15/);assert.match(report,/1\. DOWN15/);assert.doesNotMatch(report,/11\. /);assert.match(report,/Price sessions: 2026-10-28/);assert.match(report,/Session P&L/);
});
test('duplicate holdings are grouped and missing previous closes do not become flat day returns',()=>{
 const sum=summarizeHoldings([{symbol:'A',qty:2,avg:50},{symbol:'A',qty:3,avg:60},{symbol:'B',qty:1,avg:10}],s=>s==='A'?{ltp:100,prev:90}:{ltp:20});
 assert.equal(sum.dayMissing,1);assert.equal(sum.rows.at(-1).day,null);assert.equal(sum.dayPct,NaN);
 const report=formatHoldingsReport(sum,NOW);assert.match(report,/Valued 2 companies/);assert.match(report,/Partial session/);assert.equal((report.match(/1\. A /g)||[]).length,1);
});
const position=(id,extra={})=>({id,underlying:'NIFTY',expiry:'2026-11-03',strike:23000,type:'PE',side:'SELL',lots:1,avg:20,lotSize:65,addedAt:NOW,updatedAt:NOW,...extra});
test('options report uses signed short/long P&L, lot size and explicit quote coverage',()=>{
 const key='NIFTY|2026-11-03|23000|PE',quotes={[key]:{ltp:10,close:12,lotSize:65,ts:NOW}};
 const summary=summarizeOptions([position('short')],quotes,NOW,true);assert.equal(summary.pnl,650);assert.equal(summary.day,130);
 const long=summarizeOptions([position('long',{side:'BUY'})],quotes,NOW,true);assert.equal(long.pnl,-650);assert.equal(long.day,-130);
 const missing=summarizeOptions([position('short')],{},NOW,true);assert.equal(missing.unpriced,1);assert.match(formatOptionsReport(missing,NOW),/Partial total P&L Unavailable/);assert.doesNotMatch(formatOptionsReport(missing,NOW),/Partial total P&L \+₹0/);
 const stale=summarizeOptions([position('short')],{[key]:{...quotes[key],ts:NOW-60000}},NOW,true);assert.equal(stale.unpriced,1);
});
test('closed option contracts retain realised P&L while expired open contracts are not settled at zero',()=>{
 const summary=summarizeOptions([position('s'),position('b',{side:'BUY',avg:10})],{},NOW,true);assert.equal(summary.closed,1);assert.equal(summary.realised,650);assert.equal(summary.pnl,650);
 const expired=summarizeOptions([position('old',{expiry:'2026-10-01'})],{},NOW,true);assert.equal(expired.expired,1);assert.equal(expired.unpriced,1);
});
test('separate/combined reports preserve data and stay within Telegram message limits',()=>{
 const text='Header\n'+Array.from({length:90},(_,i)=>`${i} ₹ ${'x'.repeat(80)}`).join('\n');
 for(const chunks of [detailedReports(text,text,text),detailedReports(text,text,text,'combined'),reportChunks('x'.repeat(7800))]){assert.ok(chunks.length>1);assert.ok(chunks.every(x=>x.length>0&&x.length<=3900));}
 assert.equal(detailedReports('market','holdings','options').length,3);assert.equal(detailedReports('market','holdings','options','combined').length,1);
});
test('unavailable portfolio feed is explicit instead of showing an empty portfolio',()=>{
 assert.match(formatHoldingsReport(null,NOW,{available:false}),/temporarily unavailable/);assert.match(formatOptionsReport(null,NOW,{available:false}),/temporarily unavailable/);
});

import {sendReportBatch} from './telegram.js';
test('a report delivery retry resumes after acknowledged messages without resending them',async()=>{
 const pending={messages:['market','holdings','options'],next:0},sent=[];let fail=true;
 const fetcher=async(_url,options)=>{const text=JSON.parse(options.body).text;sent.push(text);if(text==='holdings'&&fail){fail=false;throw Error('temporary outage');}return {ok:true,json:async()=>({ok:true,result:{}})};};
 await assert.rejects(()=>sendReportBatch(fetcher,'TEST','fixture',pending,async()=>{}));assert.equal(pending.next,1);
 await sendReportBatch(fetcher,'TEST','fixture',pending,async()=>{});assert.deepEqual(sent,['market','holdings','holdings','options']);assert.equal(pending.next,3);
});
