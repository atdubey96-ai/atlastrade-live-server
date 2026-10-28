import test from "node:test";
import assert from "node:assert/strict";
import { formatUpdate, dueUpdate, findChats, sendTelegram } from "./telegram.js";

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

test("scheduled updates are due only on weekdays at their times, once a day", () => {
  const at = (iso) => Date.parse(iso);
  assert.equal(dueUpdate(at("2026-10-28T03:31:00Z"))?.kind, "morning");        // 09:01 IST Wednesday
  assert.equal(dueUpdate(at("2026-10-28T10:16:00Z"))?.kind, "close");          // 15:46 IST
  assert.equal(dueUpdate(at("2026-10-28T03:31:00Z"), { morning: "2026-10-28" }), null); // already sent
  assert.equal(dueUpdate(at("2026-10-28T05:00:00Z")), null);                   // 10:30 IST
  assert.equal(dueUpdate(at("2026-10-31T03:31:00Z")), null);                   // Saturday
  assert.equal(dueUpdate(at("2026-10-26T03:31:00Z"))?.kind, "morning");        // Monday
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
