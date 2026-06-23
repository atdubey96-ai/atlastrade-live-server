// AtlasTrade Price Sync — runs on your Mac as a background process
// Maintains Angel One WebSocket → writes live prices to Supabase every 5s
// Start: node supabase-sync.js
// Stop: Ctrl+C

import fetch from "node-fetch";
import WebSocket from "ws";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL  = process.env.SUPABASE_URL  || "";
const SUPABASE_KEY  = process.env.SUPABASE_KEY  || ""; // service_role key
const AO_API_KEY    = process.env.AO_API_KEY    || "";
const AO_CLIENT_ID  = process.env.AO_CLIENT_ID  || "";
const AO_PASSWORD   = process.env.AO_PASSWORD   || "";
const AO_TOTP_KEY   = process.env.AO_TOTP_KEY   || "";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_KEY env vars");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── In-memory price store ────────────────────────────────────────────────────
const prices = {}; // { symbol: { ltp, open, high, low, close, volume, ts } }
let aoToken = null, aoFeedToken = null, wsConn = null;
let lastLoginAt = 0;
const tokenToSymbol = new Map();
const symbolToToken = new Map();

// ─── TOTP ────────────────────────────────────────────────────────────────────
function base32Decode(str) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0;
  const output = [];
  for (const c of str.replace(/=+$/, "").toUpperCase()) {
    value = (value << 5) | chars.indexOf(c);
    bits += 5;
    if (bits >= 8) { output.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(output);
}

async function generateTOTP(secret) {
  const key = base32Decode(secret);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const { createHmac } = await import("crypto");
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[19] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24 | hmac[offset+1] << 16 | hmac[offset+2] << 8 | hmac[offset+3]) % 1000000;
  return String(code).padStart(6, "0");
}

// ─── Angel One Login ─────────────────────────────────────────────────────────
async function login() {
  if (Date.now() - lastLoginAt < 23 * 3600 * 1000) return true;
  try {
    const totp = AO_TOTP_KEY ? await generateTOTP(AO_TOTP_KEY) : "";
    const res = await fetch("https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword", {
      method: "POST",
      headers: {
        "Content-Type": "application/json", "Accept": "application/json",
        "X-UserType": "USER", "X-SourceID": "WEB",
        "X-ClientLocalIP": "127.0.0.1", "X-ClientPublicIP": "127.0.0.1",
        "X-MACAddress": "00:00:00:00:00:00", "X-PrivateKey": AO_API_KEY,
      },
      body: JSON.stringify({ clientcode: AO_CLIENT_ID, password: AO_PASSWORD, totp }),
    });
    const data = await res.json();
    if (data.data?.jwtToken) {
      aoToken = data.data.jwtToken;
      aoFeedToken = data.data.feedToken;
      lastLoginAt = Date.now();
      console.log("✅ Angel One login OK");
      return true;
    }
    console.warn("❌ Login failed:", data.message);
    return false;
  } catch (err) {
    console.error("Login error:", err.message);
    return false;
  }
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
function parseBinaryTick(buf) {
  try {
    const token = buf.slice(2, 27).toString("utf8").replace(/\0/g, "").trim();
    const ltp   = buf.readInt32BE(43) / 100;
    const open  = buf.readInt32BE(67) / 100;
    const high  = buf.readInt32BE(71) / 100;
    const low   = buf.readInt32BE(75) / 100;
    const close = buf.readInt32BE(79) / 100;
    const vol   = buf.readInt32BE(55);
    const sym   = tokenToSymbol.get(token);
    if (sym && ltp > 0) prices[sym] = { ltp, open, high, low, close, volume: vol, ts: Date.now() };
  } catch (_) {}
}

function connectWS() {
  if (!aoToken) return;
  if (wsConn?.readyState === WebSocket.OPEN) return;
  const url = `wss://smartapisocket.angelone.in/smart-stream?clientCode=${AO_CLIENT_ID}&feedToken=${aoFeedToken}&apiKey=${AO_API_KEY}`;
  wsConn = new WebSocket(url);
  wsConn.on("open", () => { console.log("🔌 WebSocket connected"); resubscribe(); });
  wsConn.on("message", d => { if (Buffer.isBuffer(d)) parseBinaryTick(d); });
  wsConn.on("close", c => { console.log(`WebSocket closed (${c}), retry in 5s`); setTimeout(connectWS, 5000); });
  wsConn.on("error", e => console.warn("WS error:", e.message));
}

function resubscribe() {
  if (wsConn?.readyState !== WebSocket.OPEN || !tokenToSymbol.size) return;
  const nse = [], bse = [];
  tokenToSymbol.forEach((sym, tok) => {
    if (symbolToToken.get(sym)?.exchange === "BSE") bse.push(tok);
    else nse.push(tok);
  });
  const payload = { correlationID: "atlas", action: 1, params: { mode: 3, tokenList: [] } };
  if (nse.length) payload.params.tokenList.push({ exchangeType: 1, tokens: nse });
  if (bse.length) payload.params.tokenList.push({ exchangeType: 3, tokens: bse });
  if (payload.params.tokenList.length) wsConn.send(JSON.stringify(payload));
}

// ─── Supabase sync ────────────────────────────────────────────────────────────
async function syncToSupabase() {
  const entries = Object.entries(prices);
  if (!entries.length) return;

  // Upsert all prices in one batch
  const rows = entries.map(([symbol, q]) => ({
    symbol,
    ltp: q.ltp,
    open: q.open,
    high: q.high,
    low: q.low,
    close: q.close,
    volume: q.volume,
    updated_at: new Date(q.ts).toISOString(),
  }));

  const { error } = await supabase
    .from("live_prices")
    .upsert(rows, { onConflict: "symbol" });

  if (error) console.warn("Supabase sync error:", error.message);
  else console.log(`📊 Synced ${rows.length} prices to Supabase`);
}

// ─── Load subscriptions from Supabase ────────────────────────────────────────
async function loadSubscriptions() {
  const { data, error } = await supabase.from("watchlist_tokens").select("symbol,token,exchange");
  if (error || !data?.length) { console.log("No subscriptions found in watchlist_tokens"); return; }
  data.forEach(({ symbol, token, exchange }) => {
    tokenToSymbol.set(String(token), symbol);
    symbolToToken.set(symbol, { token: String(token), exchange: exchange || "NSE" });
  });
  console.log(`📋 Loaded ${data.length} subscriptions`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🚀 AtlasTrade Price Sync starting...");

  await login();
  await loadSubscriptions();
  connectWS();

  // Sync prices to Supabase every 5 seconds
  setInterval(syncToSupabase, 5000);
  // Re-login every 23 hours
  setInterval(async () => {
    lastLoginAt = 0;
    await login();
    connectWS();
  }, 23 * 3600 * 1000);
  // Reload subscriptions every 5 minutes (picks up new watchlist items)
  setInterval(async () => {
    await loadSubscriptions();
    resubscribe();
  }, 5 * 60 * 1000);

  console.log("✅ Running. Prices will sync to Supabase every 5s. Press Ctrl+C to stop.");
}

main().catch(console.error);
