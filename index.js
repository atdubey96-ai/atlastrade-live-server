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
let subscribedTokens = new Set();
let lastLoginAt = 0;
let loginInProgress = false;

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
    console.log(`WebSocket closed (${code}), reconnecting in 5s`);
    setTimeout(connectWebSocket, 5000);
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
    const seqNum = buf.readBigUInt64BE(27);
    const exchTs = buf.readBigUInt64BE(35);
    const ltp = buf.readInt32BE(43) / 100;
    const ltq = buf.readInt32BE(47);
    const avgPrice = buf.readInt32BE(51) / 100;
    const volume = buf.readInt32BE(55);
    const totalBuy = buf.readInt32BE(59);
    const totalSell = buf.readInt32BE(63);
    const open = buf.readInt32BE(67) / 100;
    const high = buf.readInt32BE(71) / 100;
    const low = buf.readInt32BE(75) / 100;
    const close = buf.readInt32BE(79) / 100;

    const sym = tokenToSymbol.get(token);
    if (sym && ltp > 0) {
      prices[sym] = { ltp, open, high, low, close, volume, avgPrice, ts: Date.now() };
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
async function ensureLoggedIn() {
  const tokenAge = Date.now() - lastLoginAt;
  // Re-login every 23 hours (tokens expire at 24h)
  if (!aoToken || tokenAge > 23 * 60 * 60 * 1000) {
    const ok = await loginAngelOne();
    if (ok) connectWebSocket();
  }
}

// Login on startup, re-login every 23 hours
ensureLoggedIn();
setInterval(ensureLoggedIn, 30 * 60 * 1000); // check every 30 min

// ─── REST API ────────────────────────────────────────────────────────────────

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    connected: wsConn?.readyState === WebSocket.OPEN,
    loggedIn: !!aoToken,
    trackedSymbols: tokenToSymbol.size,
    lastLoginAt: lastLoginAt ? new Date(lastLoginAt).toISOString() : null,
  });
});

// Get live prices for symbols
app.get("/prices", (req, res) => {
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
  res.json({ ok: true, subscribed: symbols.length, total: tokenToSymbol.size });
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
