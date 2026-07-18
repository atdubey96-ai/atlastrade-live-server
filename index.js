// AtlasTrade Live Price Server
// Maintains Angel One WebSocket 24/7, serves live prices via REST API
// Deploy on Render.com free tier

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import WebSocket from "ws";

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
  });

  wsConn.on("message", (data) => {
    try {
      // Angel One sends binary for live ticks
      if (Buffer.isBuffer(data)) {
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

    const sym = tokenToSymbol.get(token);
    const exchangeTime = Number(exchTs);
    const sane = [ltp, open, high, low, close].every(value => Number.isFinite(value) && value >= 0)
      && ltp > 0 && ltp < 1_000_000
      && (!close || (ltp / close > 0.1 && ltp / close < 10));
    if (sym && sane) {
      const normalizedExchangeTime = exchangeTime > 1e12 ? exchangeTime : (exchangeTime > 1e9 ? exchangeTime * 1000 : Date.now());
      prices[sym] = { ltp, open, high, low, close, volume, avgPrice, ts: normalizedExchangeTime };
      lastTickAt = Math.max(lastTickAt, normalizedExchangeTime || Date.now());
    }
  } catch (_) {}
}

const tokenToSymbol = new Map(); // token → symbol
const symbolToToken = new Map(); // symbol → { token, exchange }

function subscribe(symbolTokenPairs) {
  // symbolTokenPairs: [{ symbol, token, exchange }]
  symbolTokenPairs.forEach(({ symbol, token, exchange }) => {
    tokenToSymbol.set(String(token), symbol);
    symbolToToken.set(symbol, { token: String(token), exchange: exchange || "NSE" });
    subscribedTokens.add(String(token));
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
  const numeric = Number(value || 0);
  if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e12 ? numeric : numeric * 1000;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
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
            const symbol = tokenToSymbol.get(token);
            const ltp = Number(row.ltp || 0);
            const close = Number(row.close || row.prevClose || 0);
            if (!symbol || !Number.isFinite(ltp) || ltp <= 0 || ltp >= 1_000_000) continue;
            if (close > 0 && (ltp / close <= 0.1 || ltp / close >= 10)) continue;
            const normalizedTs = angelTimestamp(row.exchFeedTime || row.exchangeTime);
            prices[symbol] = {
              ltp,
              open: Number(row.open || ltp),
              high: Number(row.high || ltp),
              low: Number(row.low || ltp),
              close: close || ltp,
              volume: Number(row.tradeVolume || row.volume || 0),
              avgPrice: Number(row.avgPrice || row.averagePrice || 0),
              ts: normalizedTs,
            };
            count += 1;
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
    trackedSymbols: tokenToSymbol.size,
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
  if (!syms.length) return res.json(prices);
  const result = {};
  syms.forEach(s => { if (prices[s]) result[s] = prices[s]; });
  res.json(result);
});

// Subscribe symbols to live feed
app.post("/subscribe", async (req, res) => {
  const { symbols } = req.body; // [{ symbol, token, exchange }]
  if (!Array.isArray(symbols) || !symbols.length) return res.status(400).json({ error: "symbols array required" });
  await ensureLoggedIn();
  subscribe(symbols);
  primeSnapshots(symbols).catch(() => {});
  res.json({ ok: true, subscribed: symbols.length, total: tokenToSymbol.size, connected: wsConn?.readyState === WebSocket.OPEN });
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

app.listen(PORT, () => console.log(`AtlasTrade server running on port ${PORT}`));
