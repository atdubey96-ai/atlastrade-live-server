// AtlasTrade Live Price Server
// Maintains Angel One WebSocket 24/7, serves live prices via REST API
// Deploy on Render.com free tier

import { symbolsForTick, EXCHANGE_BY_TYPE } from "./token-book.js";
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import WebSocket from "ws";
import { angelFeedTimeMs, exchangeTimeMs, storeQuote, servableQuotes, staleSymbols } from "./price-book.js";
import { formatUpdate, dueUpdate, sendTelegram, findChats, summarizeHoldings, holdingsLines, isIndiaTradingDay, INDIA_SESSION_KINDS } from "./telegram.js";
import { parseSnapPacket, parseRestQuote, storeTick, buildChain, windowTokens, bookKey, EXCHANGE_TYPE, resolveContract, quoteView, candleRequest, parseCandles } from "./options.js";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const AO_API_KEY    = process.env.AO_API_KEY    || "";
const AO_CLIENT_ID  = process.env.AO_CLIENT_ID  || "";
const AO_PASSWORD   = process.env.AO_PASSWORD   || "";
const AO_TOTP_KEY   = process.env.AO_TOTP_KEY   || ""; // TOTP secret (base32) for auto-login

// ─── In-memory price store ────────────────────────────────────────────────────
const prices = {};       // { "RELIANCE": { ltp, open, high, low, close, volume, ts } }
let aoToken = null;
let aoFeedToken = null;
let wsConn = null;
let wsHeartbeatTimer = null;
let wsReconnectTimer = null;
let subscribedTokens = new Set();
let lastLoginAt = 0;
let lastTickAt = 0;
let lastWsOpenAt = 0;
let wsFailureCount = 0;
let loginInProgress = false;
let snapshotInFlight = null;
const pendingSnapshotPairs = new Map();

// ─── TOTP generation (RFC 6238) ──────────────────────────────────────────────
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
async function loginAngelOne() {
  if (loginInProgress) return false;
  if (!AO_API_KEY || !AO_CLIENT_ID || !AO_PASSWORD) {
    console.log("Angel One credentials not configured");
    return false;
  }
  loginInProgress = true;
  try {
    const totp = AO_TOTP_KEY ? await generateTOTP(AO_TOTP_KEY) : "";
    const res = await fetch("https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-UserType": "USER",
        "X-SourceID": "WEB",
        "X-ClientLocalIP": "127.0.0.1",
        "X-ClientPublicIP": "127.0.0.1",
        "X-MACAddress": "00:00:00:00:00:00",
        "X-PrivateKey": AO_API_KEY,
      },
      body: JSON.stringify({ clientcode: AO_CLIENT_ID, password: AO_PASSWORD, totp }),
    });
    const data = await res.json();
    if (data.status && data.data?.jwtToken) {
      aoToken = data.data.jwtToken;
      aoFeedToken = data.data.feedToken;
      lastLoginAt = Date.now();
      console.log(`Angel One login OK at ${new Date().toISOString()}`);
      return true;
    }
    console.warn("Angel One login failed:", data.message);
    return false;
  } catch (err) {
    console.error("Login error:", err.message);
    return false;
  } finally {
    loginInProgress = false;
  }
}

// ─── Angel One WebSocket ─────────────────────────────────────────────────────
function connectWebSocket() {
  if (!aoToken || !aoFeedToken) return;
  if (wsConn && (wsConn.readyState === WebSocket.OPEN || wsConn.readyState === WebSocket.CONNECTING)) return;

  const wsUrl = `wss://smartapisocket.angelone.in/smart-stream?clientCode=${AO_CLIENT_ID}&feedToken=${aoFeedToken}&apiKey=${AO_API_KEY}`;
  wsConn = new WebSocket(wsUrl);

  wsConn.on("open", () => {
    console.log("Angel One WebSocket connected");
    wsFailureCount = 0;
    lastWsOpenAt = Date.now();
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
    clearInterval(wsHeartbeatTimer);
    wsHeartbeatTimer = setInterval(() => {
      if (wsConn?.readyState === WebSocket.OPEN) wsConn.send("ping");
    }, 25000);
    // Re-subscribe all tracked tokens
    if (subscribedTokens.size > 0) {
      resubscribeAll();
    }
    resubscribeOptions();
  });

  wsConn.on("message", (data) => {
    try {
      // Angel One sends binary for live ticks
      if (Buffer.isBuffer(data)) {
        handleOptionPacket(data);
        parseBinaryTick(data);
      } else {
        const msg = JSON.parse(data.toString());
        if (msg.type === "error") console.warn("WS error:", msg);
      }
    } catch (_) {}
  });

  wsConn.on("close", (code) => {
    clearInterval(wsHeartbeatTimer);
    wsHeartbeatTimer = null;
    wsConn = null;
    wsFailureCount += 1;
    console.log(`WebSocket closed (${code}), recovery attempt ${wsFailureCount}`);
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(async () => {
      wsReconnectTimer = null;
      // Repeated closes usually mean the JWT/feed token is no longer valid.
      // Force a fresh login instead of reconnecting forever with stale tokens.
      if (wsFailureCount >= 3) {
        aoToken = null;
        aoFeedToken = null;
        await ensureLoggedIn(true);
      } else {
        connectWebSocket();
      }
    }, Math.min(30000, 3000 * wsFailureCount));
  });

  wsConn.on("error", (err) => {
    console.warn("WebSocket error:", err.message);
  });
}

function parseBinaryTick(buf) {
  // Angel One SmartAPI binary tick format
  try {
    const subscriptionMode = buf.readUInt8(0);
    if (subscriptionMode !== 1 && subscriptionMode !== 2 && subscriptionMode !== 3) return;
    const exchType = buf.readUInt8(1);
    // Futures and options tokens can equal cash-market tokens; they belong to the option book only.
    if (exchType === 2 || exchType === 4) return;
    const token = buf.slice(2, 27).toString("utf8").replace(/\0/g, "").trim();
    if (buf.length < 51) return;
    const seqNum = buf.readBigInt64LE(27);
    const exchTs = buf.readBigInt64LE(35);
    const ltp = Number(buf.readBigInt64LE(43)) / 100;
    const hasQuoteFields = buf.length >= 123;
    const ltq = hasQuoteFields ? Number(buf.readBigInt64LE(51)) : 0;
    const avgPrice = hasQuoteFields ? Number(buf.readBigInt64LE(59)) / 100 : 0;
    const volume = hasQuoteFields ? Number(buf.readBigInt64LE(67)) : 0;
    const totalBuy = hasQuoteFields ? buf.readDoubleLE(75) : 0;
    const totalSell = hasQuoteFields ? buf.readDoubleLE(83) : 0;
    const open = hasQuoteFields ? Number(buf.readBigInt64LE(91)) / 100 : 0;
    const high = hasQuoteFields ? Number(buf.readBigInt64LE(99)) / 100 : 0;
    const low = hasQuoteFields ? Number(buf.readBigInt64LE(107)) / 100 : 0;
    const close = hasQuoteFields ? Number(buf.readBigInt64LE(115)) / 100 : 0;

    const symbols = symbolsForTick(tokenAliases, tokenToSymbol, symbolToToken, token, EXCHANGE_BY_TYPE[exchType]);
    const exchangeTime = Number(exchTs);
    const sane = [ltp, open, high, low, close].every(value => Number.isFinite(value) && value >= 0)
      && ltp > 0 && ltp < 1_000_000
      && (!close || (ltp / close > 0.1 && ltp / close < 10));
    if (symbols.size && sane) {
      // ts stays 0 when the packet has no valid exchange time; it is never stamped
      // with the server clock, so old pre-open data cannot pass as a live quote.
      const normalizedExchangeTime = exchangeTimeMs(exchangeTime);
      symbols.forEach(sym => {
        storeQuote(prices, sym, { ltp, open, high, low, close, volume, avgPrice, ts: normalizedExchangeTime });
      });
      if (normalizedExchangeTime) lastTickAt = Math.max(lastTickAt, normalizedExchangeTime);
    }
  } catch (_) {}
}

const tokenToSymbol = new Map(); // token → symbol
const tokenAliases = new Map();  // token → all saved symbols/aliases using that token
const symbolToToken = new Map(); // symbol → { token, exchange }

function subscribe(symbolTokenPairs) {
  // symbolTokenPairs: [{ symbol, token, exchange }]
  symbolTokenPairs.forEach(({ symbol, token, exchange }) => {
    const tokenKey = String(token);
    tokenToSymbol.set(tokenKey, symbol);
    if (!tokenAliases.has(tokenKey)) tokenAliases.set(tokenKey, new Set());
    tokenAliases.get(tokenKey).add(symbol);
    symbolToToken.set(symbol, { token: tokenKey, exchange: exchange || "NSE" });
    subscribedTokens.add(tokenKey);
  });
  if (wsConn?.readyState === WebSocket.OPEN) {
    resubscribeAll();
  }
}

function quoteHeaders() {
  return {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Authorization": `Bearer ${aoToken}`,
    "X-UserType": "USER",
    "X-SourceID": "WEB",
    "X-ClientLocalIP": "127.0.0.1",
    "X-ClientPublicIP": "127.0.0.1",
    "X-MACAddress": "00:00:00:00:00:00",
    "X-PrivateKey": AO_API_KEY,
  };
}

function angelTimestamp(value) {
  return exchangeTimeMs(angelFeedTimeMs(value));
}

async function primeSnapshots(pairs = []) {
  if (!aoToken || !pairs.length) return 0;
  pairs.forEach(pair => pendingSnapshotPairs.set(`${String(pair.exchange || "NSE").toUpperCase()}:${pair.token}`, pair));
  if (snapshotInFlight) return snapshotInFlight;
  snapshotInFlight = (async () => {
    let totalCount = 0;
    while (pendingSnapshotPairs.size) {
      const currentPairs = [...pendingSnapshotPairs.values()];
      pendingSnapshotPairs.clear();
      const byExchange = new Map();
      for (const pair of currentPairs) {
        const exchange = String(pair.exchange || "NSE").toUpperCase();
        if (!byExchange.has(exchange)) byExchange.set(exchange, []);
        byExchange.get(exchange).push(String(pair.token));
      }
      let count = 0;
      for (const [exchange, tokens] of byExchange) {
        const unique = [...new Set(tokens)];
        for (let offset = 0; offset < unique.length; offset += 50) {
          const chunk = unique.slice(offset, offset + 50);
          const response = await fetch("https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/", {
            method: "POST",
            headers: quoteHeaders(),
            body: JSON.stringify({ mode: "FULL", exchangeTokens: { [exchange]: chunk } }),
          }).catch(error => {
            console.warn(`Angel snapshot ${exchange} request failed:`, error.message);
            return null;
          });
          if (!response?.ok) {
            console.warn(`Angel snapshot ${exchange} HTTP ${response?.status || "network"}`);
            continue;
          }
          const payload = await response.json();
          const rows = Array.isArray(payload?.data?.fetched) ? payload.data.fetched : [];
          for (const row of rows) {
            const token = String(row.symbolToken || row.symboltoken || "");
            const symbols = symbolsForTick(tokenAliases, tokenToSymbol, symbolToToken, token, exchange === "BSE" || exchange === "NSE" ? exchange : undefined);
            const ltp = Number(row.ltp || 0);
            const close = Number(row.close || row.prevClose || 0);
            if (!symbols.size || !Number.isFinite(ltp) || ltp <= 0 || ltp >= 1_000_000) continue;
            if (close > 0 && (ltp / close <= 0.1 || ltp / close >= 10)) continue;
            const normalizedTs = angelTimestamp(row.exchFeedTime || row.exchangeTime);
            const normalized = {
              ltp,
              open: Number(row.open || ltp),
              high: Number(row.high || ltp),
              low: Number(row.low || ltp),
              close: close || ltp,
              volume: Number(row.tradeVolume || row.volume || 0),
              avgPrice: Number(row.avgPrice || row.averagePrice || 0),
              ts: normalizedTs,
            };
            symbols.forEach(symbol => { if (storeQuote(prices, symbol, normalized)) count += 1; });
          }
        }
      }
      totalCount += count;
      console.log(`Snapshot primed ${count}/${currentPairs.length} symbols`);
    }
    return totalCount;
  })().catch(error => {
    console.warn("Angel snapshot prime failed:", error.message);
    return 0;
  }).finally(() => { snapshotInFlight = null; });
  return snapshotInFlight;
}

function resubscribeAll() {
  if (!wsConn || wsConn.readyState !== WebSocket.OPEN) return;
  const nseTokens = [];
  const bseTokens = [];
  tokenToSymbol.forEach((sym, token) => {
    const info = symbolToToken.get(sym);
    if (info?.exchange === "BSE") bseTokens.push(token);
    else nseTokens.push(token);
  });

  const payload = { correlationID: "atlas", action: 1, params: { mode: 3, tokenList: [] } };
  if (nseTokens.length) payload.params.tokenList.push({ exchangeType: 1, tokens: nseTokens });
  if (bseTokens.length) payload.params.tokenList.push({ exchangeType: 3, tokens: bseTokens });
  if (payload.params.tokenList.length) {
    wsConn.send(JSON.stringify(payload));
    console.log(`Subscribed ${nseTokens.length} NSE + ${bseTokens.length} BSE tokens`);
  }
}

// ─── Option chain feed ───────────────────────────────────────────────────────
// Option contracts are streamed only while someone is looking at a chain: the strikes around the spot, capped so the
// shared 1000-token socket limit is never threatened. Quotes live in their own book, keyed by segment and token.
const SITE_URL = process.env.ZENITH_SITE_URL || "https://atlastrade-portfolio.vercel.app";
const MAX_OPTION_TOKENS = 360;
const OPTION_IDLE_MS = 10 * 60 * 1000;
const optionBook = new Map();
const optionSubs = new Map(); // bookKey -> { exchange, exchangeType, token, lastUsed }
const optionStats = { packets: 0, lastPacketAt: 0, lastSample: null, restPrimed: 0, lastError: "" };
let optionMeta = { at: 0, data: null, loading: null };

function handleOptionPacket(buf) {
  try {
    const tick = parseSnapPacket(buf);
    if (!tick || !optionSubs.has(bookKey(tick.exchangeType, tick.token))) return;
    if (storeTick(optionBook, tick)) {
      optionStats.packets += 1;
      optionStats.lastPacketAt = Date.now();
      if (optionStats.packets % 200 === 1) optionStats.lastSample = { token: tick.token, exchangeType: tick.exchangeType, mode: tick.mode, ltp: tick.ltp, oi: tick.oi ?? null, oiChangePct: tick.oiChangePct ?? null, bids: tick.bids?.length ?? null, ts: tick.ts };
    }
  } catch (_) {}
}

function sendOptionSubscription(action, entries) {
  if (!wsConn || wsConn.readyState !== WebSocket.OPEN || !entries.length) return;
  const byType = new Map();
  entries.forEach(e => { if (!byType.has(e.exchangeType)) byType.set(e.exchangeType, []); byType.get(e.exchangeType).push(e.token); });
  const tokenList = [...byType].map(([exchangeType, tokens]) => ({ exchangeType, tokens }));
  wsConn.send(JSON.stringify({ correlationID: "options", action, params: { mode: 3, tokenList } }));
}

function resubscribeOptions() {
  sendOptionSubscription(1, [...optionSubs.values()]);
}

function trackOptionTokens(list) {
  const now = Date.now();
  const fresh = [];
  for (const item of list) {
    const key = bookKey(item.exchangeType, item.token);
    const held = optionSubs.get(key);
    if (held) { held.lastUsed = now; continue; }
    const entry = { exchange: item.exchange, exchangeType: item.exchangeType, token: String(item.token), lastUsed: now };
    optionSubs.set(key, entry);
    fresh.push(entry);
  }
  // Release anything idle, then the least recently used if the cap is still exceeded.
  const drop = [];
  for (const [key, entry] of optionSubs) if (now - entry.lastUsed > OPTION_IDLE_MS) drop.push([key, entry]);
  if (optionSubs.size - drop.length > MAX_OPTION_TOKENS) {
    const rest = [...optionSubs].filter(([key]) => !drop.some(([k]) => k === key)).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    drop.push(...rest.slice(0, optionSubs.size - drop.length - MAX_OPTION_TOKENS));
  }
  drop.forEach(([key]) => { optionSubs.delete(key); optionBook.delete(key); });
  sendOptionSubscription(0, drop.map(([, entry]) => entry));
  sendOptionSubscription(1, fresh);
  return fresh;
}

// One REST snapshot for tokens that have no quote yet, so the chain fills at once instead of waiting for ticks.
async function primeOptionTokens(list) {
  if (!aoToken) return 0;
  const missing = list.filter(item => !optionBook.has(bookKey(item.exchangeType, item.token)));
  const byExchange = new Map();
  missing.forEach(item => { if (!byExchange.has(item.exchange)) byExchange.set(item.exchange, []); byExchange.get(item.exchange).push(String(item.token)); });
  let stored = 0;
  for (const [exchange, tokens] of byExchange) {
    for (let offset = 0; offset < tokens.length; offset += 50) {
      await angelRestGate(offset > 0 ? 1100 : 450);
      const response = await fetch("https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/", {
        method: "POST", headers: quoteHeaders(),
        body: JSON.stringify({ mode: "FULL", exchangeTokens: { [exchange]: tokens.slice(offset, offset + 50) } }),
      }).catch(error => { optionStats.lastError = error.message; return null; });
      if (!response?.ok) { optionStats.lastError = `snapshot ${exchange} HTTP ${response?.status || "network"}`; continue; }
      const payload = await response.json().catch(() => ({}));
      for (const row of Array.isArray(payload?.data?.fetched) ? payload.data.fetched : []) {
        const tick = parseRestQuote(row, EXCHANGE_TYPE[exchange]);
        if (tick && storeTick(optionBook, tick)) stored += 1;
      }
    }
  }
  optionStats.restPrimed += stored;
  return stored;
}

async function loadOptionMeta() {
  const fresh = optionMeta.data && Date.now() - optionMeta.at < 6 * 60 * 60 * 1000;
  if (fresh) return optionMeta.data;
  if (optionMeta.loading) return optionMeta.loading;
  optionMeta.loading = (async () => {
    // The live contract list downloads Angel's 36 MB instrument file and is sometimes slow or refused; the copy shipped with
    // the site is the fallback, so a bad moment there never takes the option chain down.
    let lastError = null;
    for (const [path, ms] of [["/api/instruments?source=options", 30000], ["/data/option-contracts.json", 15000]]) {
      try {
        const res = await fetch(`${SITE_URL}${path}`, { signal: AbortSignal.timeout(ms) });
        if (!res.ok) throw new Error(`contract directory HTTP ${res.status}`);
        const data = await res.json();
        if (!data?.underlyings) throw new Error("contract directory looks empty");
        optionMeta = { at: Date.now() - (data.stale || data.snapshot ? 5 * 60 * 60 * 1000 : 0), data, loading: null };
        return data;
      } catch (error) { lastError = error; }
    }
    throw lastError || new Error("contract directory unavailable");
  })().catch(error => { optionMeta.loading = null; if (optionMeta.data) return optionMeta.data; throw error; });
  return optionMeta.loading;
}

// ─── Auto-login and keep-alive ────────────────────────────────────────────────
async function ensureLoggedIn(force = false) {
  const tokenAge = Date.now() - lastLoginAt;
  // Re-login every 23 hours (tokens expire at 24h)
  if (force || !aoToken || tokenAge > 23 * 60 * 60 * 1000) {
    const ok = await loginAngelOne();
    if (ok) {
      connectWebSocket();
      const tracked = [...symbolToToken.entries()].map(([symbol, value]) => ({ symbol, ...value }));
      if (tracked.length) primeSnapshots(tracked).catch(() => {});
    }
  }
}

// Login on startup, re-login every 23 hours
ensureLoggedIn();
setInterval(ensureLoggedIn, 30 * 60 * 1000); // check every 30 min

function isNseMarketOpen(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now).reduce((out, part) => (out[part.type] = part.value, out), {});
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
}

// A connected socket that has stopped producing ticks is not healthy. Recover
// proactively during market hours instead of waiting for a close event.
setInterval(async () => {
  if (!isNseMarketOpen()) return;
  const tickAge = lastTickAt ? Date.now() - lastTickAt : Infinity;
  if (wsConn?.readyState === WebSocket.OPEN && tickAge <= 120000) return;
  console.warn(`Feed watchdog recovery (tick age ${Math.round(tickAge / 1000)}s)`);
  try { wsConn?.terminate(); } catch (_) {}
  wsConn = null;
  aoToken = null;
  aoFeedToken = null;
  await ensureLoggedIn(true);
}, 30000);

// Quotes that stopped updating (a frozen socket token, or a pre-open replay) are re-read from the REST snapshot once a minute,
// so a wrong price cannot sit in the book for hours. Rate-limited by the shared REST gate inside primeSnapshots.
setInterval(() => {
  if (!aoToken) return;
  const open = isNseMarketOpen();
  const symbols = staleSymbols(prices, { marketOpen: open, limit: open ? 100 : 40 });
  const pairs = symbols.map(symbol => { const info = symbolToToken.get(symbol); return info ? { symbol, token: info.token, exchange: info.exchange } : null; }).filter(Boolean);
  if (pairs.length) primeSnapshots(pairs).catch(() => {});
}, 60000);

// Self-ping every 14 minutes to prevent Render free tier spin-down
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
setInterval(() => {
  fetch(`${SELF_URL}/health`).catch(() => {});
}, 14 * 60 * 1000);

// ─── REST API ────────────────────────────────────────────────────────────────

// Health check
app.get("/health", (req, res) => {
  const marketOpen = isNseMarketOpen();
  const lastTickAgeMs = lastTickAt ? Math.max(0, Date.now() - lastTickAt) : null;
  res.json({
    status: "ok",
    connected: wsConn?.readyState === WebSocket.OPEN,
    feedHealthy: wsConn?.readyState === WebSocket.OPEN && (!marketOpen || (lastTickAgeMs !== null && lastTickAgeMs <= 120000)),
    loggedIn: !!aoToken,
    trackedSymbols: symbolToToken.size,
    trackedTokens: tokenToSymbol.size,
    priceCount: Object.keys(prices).length,
    marketOpen,
    lastTickAt: lastTickAt ? new Date(lastTickAt).toISOString() : null,
    lastTickAgeMs,
    lastWsOpenAt: lastWsOpenAt ? new Date(lastWsOpenAt).toISOString() : null,
    lastLoginAt: lastLoginAt ? new Date(lastLoginAt).toISOString() : null,
  });
});

// Get live prices for symbols
app.get("/prices", (req, res) => {
  res.set("Cache-Control", "no-store, max-age=0");
  const syms = (req.query.symbols || "").split(",").map(s => s.trim()).filter(Boolean);
  // ?debug=1 returns everything held, including quotes withheld as unverified or stale.
  if (req.query.debug === "1") {
    if (!syms.length) return res.json(prices);
    const all = {};
    syms.forEach(s => { if (prices[s]) all[s] = prices[s]; });
    return res.json(all);
  }
  // Withheld quotes make the website fall back to its verified backup source.
  res.json(servableQuotes(prices, syms.length ? syms : null));
});

// Subscribe symbols to live feed
app.post("/subscribe", async (req, res) => {
  const { symbols } = req.body; // [{ symbol, token, exchange }]
  if (!Array.isArray(symbols) || !symbols.length) return res.status(400).json({ error: "symbols array required" });
  await ensureLoggedIn();
  subscribe(symbols);
  primeSnapshots(symbols).catch(() => {});
  res.json({ ok: true, subscribed: symbols.length, total: symbolToToken.size, tokens: tokenToSymbol.size, connected: wsConn?.readyState === WebSocket.OPEN });
});

// Fetch live NSE quote (fallback when WebSocket not available)
app.get("/nse-quote", async (req, res) => {
  const { symbols } = req.query;
  if (!symbols) return res.status(400).json({ error: "symbols required" });
  try {
    const r = await fetch(`https://atlastrade-portfolio.vercel.app/api/nse-quote?symbols=${encodeURIComponent(symbols)}`);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Option chain: contract directory (expiries per underlying), one chain, and a feed diagnostic.
app.get("/options/meta", async (req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  try {
    const meta = await loadOptionMeta();
    res.json({
      asOf: meta.asOf,
      underlyings: Object.values(meta.underlyings).map(u => ({
        name: u.name, label: u.label, lotSize: u.lotSize,
        expiries: u.expiries.map(e => ({ date: e.date, monthly: e.monthly })),
      })),
    });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.get("/options/chain", async (req, res) => {
  res.set("Cache-Control", "no-store, max-age=0");
  try {
    const meta = await loadOptionMeta();
    const underlying = String(req.query.underlying || "NIFTY").toUpperCase();
    const u = meta.underlyings?.[underlying];
    if (!u) return res.status(404).json({ error: `unknown underlying ${underlying}` });
    const expiry = String(req.query.expiry || u.expiries[0]?.date || "");
    const width = Math.min(60, Math.max(5, Number(req.query.width) || 20));
    await ensureLoggedIn();
    // The window depends on the spot, so the spot comes first when there is no quote for it yet.
    const spotItem = { exchange: u.spot.exchange, exchangeType: EXCHANGE_TYPE[u.spot.exchange] || 1, token: u.spot.token };
    if (!optionBook.has(bookKey(spotItem.exchangeType, spotItem.token))) { trackOptionTokens([spotItem]); await primeOptionTokens([spotItem]); }
    const spot = optionBook.get(bookKey(spotItem.exchangeType, spotItem.token))?.ltp || null;
    const wanted = windowTokens({ meta: u, expiry, spot, width });
    trackOptionTokens(wanted);
    const missing = wanted.filter(item => !optionBook.has(bookKey(item.exchangeType, item.token)));
    if (missing.length > wanted.length * 0.3) await primeOptionTokens(missing);
    const chain = buildChain({ meta: u, expiry, book: optionBook, width });
    if (!chain) return res.status(404).json({ error: `no ${underlying} expiry ${expiry}` });
    chain.feed = { connected: wsConn?.readyState === WebSocket.OPEN, marketOpen: isNseMarketOpen(), streamedTokens: optionSubs.size };
    res.json(chain);
  } catch (error) { res.status(502).json({ error: error.message }); }
});

// Live prices for the user's own option positions, in any expiry. items = "NIFTY|2026-11-03|22700|CE,BANKNIFTY|..."
app.get("/options/quotes", async (req, res) => {
  res.set("Cache-Control", "no-store, max-age=0");
  try {
    const meta = await loadOptionMeta();
    const items = String(req.query.items || "").split(",").map(x => x.trim()).filter(Boolean).slice(0, 60);
    if (!items.length) return res.json({ quotes: {} });
    await ensureLoggedIn();
    const wanted = [];
    const found = new Map();
    for (const key of items) {
      const [underlying, expiry, strike, type] = key.split("|");
      const contract = resolveContract(meta.underlyings, underlying, expiry, strike, type);
      if (contract) { found.set(key, contract); wanted.push(contract); }
    }
    trackOptionTokens(wanted);
    const missing = wanted.filter(item => !optionBook.has(bookKey(item.exchangeType, item.token)));
    if (missing.length) await primeOptionTokens(missing);
    const quotes = {};
    for (const [key, contract] of found) {
      const view = quoteView(optionBook.get(bookKey(contract.exchangeType, contract.token)));
      quotes[key] = view ? { ...view, symbol: contract.symbol, lotSize: contract.lotSize } : { symbol: contract.symbol, lotSize: contract.lotSize, ltp: null };
    }
    res.json({ quotes, feed: { connected: wsConn?.readyState === WebSocket.OPEN, marketOpen: isNseMarketOpen() } });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

// Angel refuses requests that come too fast ("exceeding access rate"). Calls that serve the option screens share one queue
// with a minimum gap, so a chart opening while a chain loads does not trip the limit.
let angelRestAt = 0;
async function angelRestGate(gap = 450) {
  const wait = Math.max(0, angelRestAt + gap - Date.now());
  angelRestAt = Date.now() + wait;
  if (wait) await new Promise(resolve => setTimeout(resolve, wait));
}

// Candle history for one option contract (any expiry), through the same Angel session as the quotes.
const optionCandleCache = new Map();
app.get("/options/candles", async (req, res) => {
  res.set("Cache-Control", "no-store, max-age=0");
  const token = String(req.query.token || "");
  const interval = String(req.query.interval || "ONE_DAY").toUpperCase();
  const body = candleRequest(token, interval);
  if (!body) return res.status(400).json({ error: "token and a supported interval are required" });
  const key = `${token}:${interval}`;
  const ttl = interval === "ONE_DAY" ? 5 * 60 * 1000 : 45 * 1000;
  const held = optionCandleCache.get(key);
  if (held && Date.now() - held.at < ttl) return res.json(held.payload);
  try {
    await ensureLoggedIn();
    if (!aoToken) return res.status(503).json({ error: "The broker session is not ready" });
    // Angel limits how fast history can be requested and answers a burst with 403 or an access-rate message; a short pause
    // and a second try clears it.
    let response, json, raw = "";
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
      await angelRestGate();
      response = await fetch("https://apiconnect.angelone.in/rest/secure/angelbroking/historical/v1/getCandleData", {
        method: "POST", headers: quoteHeaders(), body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
      });
      raw = await response.text().catch(() => "");
      json = (() => { try { return JSON.parse(raw); } catch (_) { return {}; } })();
      if (response.ok && json.status !== false) break;
      if (!(response.status === 403 || response.status === 429 || /rate|exceed/i.test(String(json.message || raw)))) break;
    }
    if (!response.ok || json.status === false) throw new Error(`${json.message || raw.replace(/\s+/g, " ").slice(0, 160) || "candle history"} (HTTP ${response.status})`);
    const candles = parseCandles(json.data, interval);
    const payload = { token, interval, count: candles.length, candles };
    if (candles.length) optionCandleCache.set(key, { at: Date.now(), payload });
    if (optionCandleCache.size > 200) optionCandleCache.delete(optionCandleCache.keys().next().value);
    res.json(payload);
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.get("/options/debug", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    connected: wsConn?.readyState === WebSocket.OPEN, loggedIn: !!aoToken, marketOpen: isNseMarketOpen(),
    subscribed: optionSubs.size, bookSize: optionBook.size, ...optionStats,
    lastPacketAgeMs: optionStats.lastPacketAt ? Date.now() - optionStats.lastPacketAt : null,
    metaAgeMs: optionMeta.at ? Date.now() - optionMeta.at : null,
  });
});

// ─── Telegram daily updates ──────────────────────────────────────────────────
// A bot token (TELEGRAM_BOT_TOKEN) and the owner's chat id (TELEGRAM_CHAT_ID, or paired once through /telegram/pair) are
// needed. Messages go only to that one chat; nothing is read from or acted on from incoming messages.
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
let telegramChatId = process.env.TELEGRAM_CHAT_ID || "";
const telegramSent = {};
let telegramLastSampleAt = 0;

async function marketSnapshot() {
  const out = { quotes: {}, chains: {} };
  try {
    const res = await fetch(`${SITE_URL}/api/indices?_=${Date.now()}`, { signal: AbortSignal.timeout(20000) });
    if (res.ok) out.quotes = (await res.json()).quotes || {};
  } catch (_) {}
  for (const name of ["NIFTY", "BANKNIFTY"]) {
    try {
      const res = await fetch(`http://localhost:${PORT}/options/chain?underlying=${name}&width=12`, { signal: AbortSignal.timeout(30000) });
      if (res.ok) out.chains[name] = await res.json();
    } catch (_) {}
  }
  return out;
}

// Your saved holdings, read from the site's own storage endpoint and kept for five minutes.
let holdingsCache = { at: 0, list: [] };
async function savedHoldings() {
  if (Date.now() - holdingsCache.at < 5 * 60 * 1000) return holdingsCache.list;
  try {
    const res = await fetch(`${SITE_URL}/api/sync?url=server-managed&key=live-server&table=scada_reports&filename=atlastrade_portfolio_state.json`, { signal: AbortSignal.timeout(25000) });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const rows = await res.json();
    const state = JSON.parse(Buffer.from(String(rows?.[0]?.data_base64 || ""), "base64").toString("utf8"));
    holdingsCache = { at: Date.now(), list: Array.isArray(state.holdings) ? state.holdings : [] };
  } catch (error) { console.warn("Holdings unavailable for Telegram:", error.message); }
  return holdingsCache.list;
}

// Holdings priced from the live feed, with the exchange's own previous close for today's change.
async function holdingsSummaryLines() {
  const holdings = await savedHoldings();
  if (!holdings.length) return [];
  const symbols = [...new Set(holdings.map(h => String(h.symbol || "")).filter(s => s && !/-(MF|US|CX)$/i.test(s)))];
  const official = {};
  for (let i = 0; i < symbols.length; i += 150) {
    try {
      const res = await fetch(`${SITE_URL}/api/indices?route=official-close&symbols=${encodeURIComponent(symbols.slice(i, i + 150).join(","))}`, { signal: AbortSignal.timeout(20000) });
      if (res.ok) Object.assign(official, await res.json());
    } catch (_) {}
  }
  const live = servableQuotes(prices, symbols);
  const quoteOf = symbol => {
    const q = live[symbol], o = official[symbol];
    if (q && q.ltp > 0) return { ltp: q.ltp, prev: o && o.prevClose > 0 ? o.prevClose : q.close };
    return o && o.close > 0 ? { ltp: o.close, prev: o.prevClose } : null; // no live tick: the last official close
  };
  return holdingsLines(summarizeHoldings(holdings, quoteOf));
}

async function sendMarketUpdate(kind) {
  if (!TELEGRAM_TOKEN || !telegramChatId) throw new Error("Telegram is not set up yet");
  const { quotes, chains } = await marketSnapshot();
  if (!Object.keys(quotes).length) throw new Error("Market data is unavailable right now");
  const holdings = await holdingsSummaryLines().catch(() => []);
  await sendTelegram(fetch, TELEGRAM_TOKEN, telegramChatId, formatUpdate(kind, quotes, chains, Date.now(), holdings));
}

// True when the market traded today (or when that cannot be told: a missed message is worse than an extra one).
async function indiaTradedToday() {
  let latestCandleMs = 0;
  try {
    const res = await fetch(`${SITE_URL}/api/historical?symbol=${encodeURIComponent("NIFTY 50")}&interval=FIVE_MINUTE&_=${Date.now()}`, { signal: AbortSignal.timeout(20000) });
    if (res.ok) { const c = (await res.json()).candles || []; latestCandleMs = c.length ? Date.parse(c[c.length - 1].time) : 0; }
    else return true;
  } catch (_) { return true; }
  return isIndiaTradingDay({ now: Date.now(), lastTickAt, latestCandleMs });
}

// Pairs the bot with the one chat that has messaged it. Refuses when several chats did, so a stranger cannot take over.
app.get("/telegram/pair", async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!TELEGRAM_TOKEN) return res.status(400).json({ error: "TELEGRAM_BOT_TOKEN is not set" });
  try {
    if (telegramChatId) return res.json({ paired: true, chatId: Number(telegramChatId) || telegramChatId, note: "already paired" });
    const chats = await findChats(fetch, TELEGRAM_TOKEN);
    if (chats.length === 0) return res.status(404).json({ paired: false, error: "No messages found. Open your bot in Telegram, press Start, send 'hi', then try again." });
    if (chats.length > 1) return res.status(409).json({ paired: false, error: `${chats.length} different chats have messaged the bot; set TELEGRAM_CHAT_ID instead.` });
    telegramChatId = String(chats[0].id);
    res.json({ paired: true, chatId: chats[0].id, name: chats[0].name });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

// Sends a sample update to the paired chat now (at most one a minute).
app.get("/telegram/sample", async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (Date.now() - telegramLastSampleAt < 60000) return res.status(429).json({ error: "A sample was just sent; wait a minute." });
  telegramLastSampleAt = Date.now();
  try { await sendMarketUpdate("sample"); res.json({ sent: true }); }
  catch (error) { res.status(502).json({ sent: false, error: error.message }); }
});

setInterval(async () => {
  const due = dueUpdate(Date.now(), telegramSent);
  if (!due || !TELEGRAM_TOKEN || !telegramChatId) return;
  telegramSent[due.kind] = due.iso;
  // The India-session messages are not sent on an NSE holiday.
  if (INDIA_SESSION_KINDS.has(due.kind) && !(await indiaTradedToday())) { console.log(`Telegram ${due.kind} update skipped: NSE is closed today`); return; }
  try { await sendMarketUpdate(due.kind); console.log(`Telegram ${due.kind} update sent`); }
  catch (error) { console.warn(`Telegram ${due.kind} update failed:`, error.message); telegramSent[due.kind] = ""; }
}, 30000);

app.listen(PORT, () => console.log(`AtlasTrade server running on port ${PORT}`));
