// Telegram daily market updates: message text, sending, and finding the one chat that owns the bot.
// Pure formatting plus thin calls to Telegram's Bot API; index.js owns the schedule and the secrets.

const API = "https://api.telegram.org";

const arrow = pct => (pct > 0.005 ? "🟢" : pct < -0.005 ? "🔴" : "⚪");
const num = (n, d = 2) => (Number.isFinite(n) ? n.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d }) : "–");
const signedPct = p => (Number.isFinite(p) ? (p > 0 ? "+" : "") + p.toFixed(2) + "%" : "–");
const pctOf = q => (q && q.ltp > 0 && q.prev > 0 ? (q.ltp / q.prev - 1) * 100 : NaN);
const line = (q, label, d = 2) => (q && q.ltp > 0 ? `${arrow(pctOf(q))} ${label}  ${num(q.ltp, d)}  ${signedPct(pctOf(q))}` : null);

const istParts = (now = Date.now()) => {
  const d = new Date(now + 5.5 * 3600 * 1000);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return { weekday: days[d.getUTCDay()], dow: d.getUTCDay(), date: `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`, minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), iso: d.toISOString().slice(0, 10) };
};

function optionLines(chain, name) {
  if (!chain || !chain.atmStrike) return [];
  const parts = [`${name} ${chain.expiry.slice(8)}/${chain.expiry.slice(5, 7)}`, `ATM ${chain.atmStrike}`];
  if (Number.isFinite(chain.atmIv)) parts.push(`IV ${chain.atmIv.toFixed(1)}%`);
  if (Number.isFinite(chain.pcr)) parts.push(`PCR ${chain.pcr.toFixed(2)}`);
  if (chain.maxPain) parts.push(`max pain ${chain.maxPain}`);
  if (Number.isFinite(chain.straddle)) parts.push(`straddle ${num(chain.straddle, 0)} (±${chain.expectedMovePct}%)`);
  return [`📊 ${parts.join(" · ")}`];
}

// quotes: the site's /api/indices "quotes" object. chains: { NIFTY, BANKNIFTY } from the option chain, each optional.
export function formatUpdate(kind, quotes = {}, chains = {}, now = Date.now()) {
  const t = istParts(now);
  const q = quotes;
  const titles = { morning: "☀️ Zenith morning update", close: "🔔 Zenith market close", evening: "🌙 Zenith evening update", night: "🌌 Zenith night update", sample: "✅ Zenith sample update" };
  const title = titles[kind] || titles.sample;
  const section = (heading, lines) => { const kept = lines.filter(Boolean); return kept.length ? ["", heading, ...kept] : []; };
  const optionRows = [...optionLines(chains.NIFTY, "Nifty"), ...optionLines(chains.BANKNIFTY, "Bank Nifty")];
  const us = kind === "evening" || kind === "night"; // evening and night follow the US session, so global comes first
  const india = section(kind === "morning" ? "India (previous close / pre-open)" : us ? "India (closed) and GIFT Nifty" : "India", [
    line(q.nifty50, "Nifty 50    ", 2), line(q.banknifty, "Bank Nifty  ", 2), line(q.sensex, "Sensex      ", 2),
    kind !== "close" ? line(q.giftNifty, "GIFT Nifty  ", 2) : null,
  ]);
  const global = section(us ? "US markets" : "Global", [line(q.sp500, "S&P 500     ", 2), line(q.nasdaq100, "Nasdaq 100  ", 2), line(q.dowjones, "Dow Jones   ", 2)]);
  const rows = [
    `${title} · ${t.weekday} ${t.date}`,
    ...(us ? [...global, ...india] : [...india, ...global]),
    ...section("Others", [line(q.gold, "Gold BeES   ", 2), line(q.silver, "Silver BeES ", 2), line(q.usdinr, "USD/INR     ", 2), line(q.bitcoin, "Bitcoin $   ", 0), line(q.ethereum, "Ethereum $  ", 0)]),
    ...(us ? [] : section("Options", [...optionLines(chains.NIFTY, "Nifty"), ...optionLines(chains.BANKNIFTY, "Bank Nifty")])),
    "",
    kind === "sample" ? "This is a sample. Updates: 9:30 AM, 3:40 PM, 8:10 PM and 2:00 AM IST." : "Open Zenith for your portfolio and positions.",
  ];
  const cleaned = rows;
  return cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// The daily schedule (India time). days: 0 = Sunday. The 2:00 AM update belongs to the previous evening's US session, so it runs
// Tuesday to Saturday mornings.
export const SCHEDULE = [
  { kind: "morning", at: 9 * 60 + 30, days: [1, 2, 3, 4, 5] },
  { kind: "close", at: 15 * 60 + 40, days: [1, 2, 3, 4, 5] },
  { kind: "evening", at: 20 * 60 + 10, days: [1, 2, 3, 4, 5] },
  { kind: "night", at: 2 * 60, days: [2, 3, 4, 5, 6] },
];

// Which scheduled message, if any, is due at this moment: on its days, within five minutes after its time, once a day.
export function dueUpdate(now = Date.now(), sent = {}) {
  const t = istParts(now);
  for (const { kind, at, days } of SCHEDULE) {
    if (days.includes(t.dow) && t.minutes >= at && t.minutes < at + 5 && sent[kind] !== t.iso) return { kind, iso: t.iso };
  }
  return null;
}

export async function sendTelegram(fetchFn, token, chatId, text) {
  const res = await fetchFn(`${API}/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) throw new Error(json.description || `Telegram HTTP ${res.status}`);
  return json.result;
}

// The distinct private chats that have messaged the bot (Telegram keeps updates for 24 hours).
export async function findChats(fetchFn, token) {
  const res = await fetchFn(`${API}/bot${token}/getUpdates?limit=100`, { signal: AbortSignal.timeout(15000) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) throw new Error(json.description || `Telegram HTTP ${res.status}`);
  const chats = new Map();
  for (const u of json.result || []) {
    const c = u.message?.chat || u.edited_message?.chat;
    if (c && c.type === "private" && !chats.has(c.id)) chats.set(c.id, { id: c.id, name: [c.first_name, c.last_name].filter(Boolean).join(" ") || c.username || "" });
  }
  return [...chats.values()];
}
