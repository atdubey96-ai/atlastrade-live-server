(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ZenithOptionPositions = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  // The user's own option positions: validation, profit and loss, totals, and backup files. Pure functions, no I/O.
  // A position is what was bought or sold: contract, side, lots and the average premium per unit.

  const UNDERLYINGS = ["NIFTY", "BANKNIFTY"];
  const MAX_LOTS = 5000;

  const positionKey = p => `${p.underlying}|${p.expiry}|${p.strike}|${p.type}`;

  // Returns a clean position, or null when anything essential is missing or impossible.
  function sanitize(raw, now = Date.now()) {
    if (!raw || typeof raw !== "object") return null;
    const underlying = String(raw.underlying || "").toUpperCase();
    const type = String(raw.type || "").toUpperCase();
    const side = String(raw.side || "").toUpperCase();
    const expiry = String(raw.expiry || "");
    const strike = Number(raw.strike), lots = Number(raw.lots), avg = Number(raw.avg), lotSize = Number(raw.lotSize) || 0;
    if (!UNDERLYINGS.includes(underlying) || !["CE", "PE"].includes(type) || !["BUY", "SELL"].includes(side)) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry) || !Number.isFinite(Date.parse(expiry))) return null;
    if (!(strike > 0) || !Number.isInteger(lots) || lots < 1 || lots > MAX_LOTS || !(avg > 0) || avg > 1e6) return null;
    return {
      id: String(raw.id || `${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`),
      underlying, expiry, strike, type, side, lots, avg: Math.round(avg * 100) / 100,
      lotSize: lotSize > 0 ? lotSize : 0,
      addedAt: Number(raw.addedAt) || now,
      // When this position last changed; the newest copy wins when devices sync.
      updatedAt: Number(raw.updatedAt) || Number(raw.addedAt) || now,
    };
  }

  const isExpired = (p, todayIso) => p.expiry < todayIso;

  // evaluate() is defined below; the grouped helpers follow it.

  // quote: { ltp, close, lotSize } or null. Profit and loss is against the live price; day change against yesterday's close.
  function evaluate(p, quote, todayIso) {
    const sign = p.side === "BUY" ? 1 : -1;
    const lotSize = (quote && quote.lotSize) || p.lotSize || 0;
    const qty = lotSize ? p.lots * lotSize : 0;
    const ltp = quote && Number.isFinite(quote.ltp) && quote.ltp > 0 ? quote.ltp : null;
    const close = quote && Number.isFinite(quote.close) && quote.close > 0 ? quote.close : null;
    const pnl = ltp && qty ? sign * (ltp - p.avg) * qty : null;
    return {
      sign, qty, lotSize, ltp, expired: isExpired(p, todayIso),
      pnl,
      pnlPct: pnl !== null ? (sign * (ltp - p.avg)) / p.avg * 100 : null,
      dayChange: ltp && close && qty ? sign * (ltp - close) * qty : null,
      premium: qty ? sign * p.avg * qty : null, // money paid (positive) or received (negative) when the position was opened
      value: ltp && qty ? sign * ltp * qty : null,
    };
  }


  /* ---------- one line per contract ---------- */

  // Every purchase or sale is kept as its own trade, but the same contract is shown as one position. Trades on the same side
  // add up (lots, and the average price weighted by size). Trades on opposite sides offset each other: the position is the
  // net, and its average is the net cash paid per unit, so profit and loss on the net equals the sum over all trades, closed
  // part included. When everything has been offset the contract is closed and only its realised result remains.
  function groupPositions(list) {
    const by = new Map();
    for (const p of Array.isArray(list) ? list : []) {
      const k = positionKey(p);
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(p);
    }
    const out = [];
    for (const [key, legs] of by) {
      legs.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
      const first = legs[0];
      const lotSize = legs.reduce((v, p) => p.lotSize || v, 0);
      const units = p => p.lots * (p.lotSize || lotSize || 1);
      let net = 0, cash = 0, gross = 0;
      for (const p of legs) { const sgn = p.side === "BUY" ? 1 : -1; net += sgn * units(p); cash += sgn * p.avg * units(p); gross += units(p); }
      const closed = Math.abs(net) < 1e-9;
      const side = closed ? first.side : net > 0 ? "BUY" : "SELL";
      const sameSide = legs.filter(p => p.side === side);
      const sameUnits = sameSide.reduce((t, p) => t + units(p), 0);
      const sameAvg = sameUnits ? sameSide.reduce((t, p) => t + p.avg * units(p), 0) / sameUnits : first.avg;
      const offset = legs.length > sameSide.length;
      const avg = closed ? first.avg : offset ? Math.max(0.01, cash / net) : sameAvg;
      const size = lotSize || 1;
      out.push({
        key, underlying: first.underlying, expiry: first.expiry, strike: first.strike, type: first.type,
        side, lotSize, lots: closed ? 0 : Math.abs(net) / size, avg,
        closed, realised: closed ? -cash : 0, trades: legs, id: legs[legs.length - 1].id,
        updatedAt: legs.reduce((t, p) => Math.max(t, p.updatedAt || 0), 0),
      });
    }
    return out;
  }

  // Like evaluate(), for a grouped contract. A closed one has no live price; its profit is what it realised.
  function evaluateGroup(g, quote, todayIso) {
    if (!g.closed) return evaluate(g, quote, todayIso);
    return { sign: 0, qty: 0, lotSize: g.lotSize, ltp: null, expired: isExpired(g, todayIso), pnl: g.realised, pnlPct: null, dayChange: null, premium: null, value: null };
  }

  function totals(evaluations) {
    const sum = key => evaluations.reduce((t, e) => t + (Number.isFinite(e[key]) ? e[key] : 0), 0);
    const priced = evaluations.filter(e => e.pnl !== null).length;
    return { pnl: sum("pnl"), dayChange: sum("dayChange"), premium: sum("premium"), count: evaluations.length, priced };
  }

  // Backup files hold only validated positions; importing skips any it already has (same id) and anything invalid.
  function toBackup(list, now = Date.now()) {
    return JSON.stringify({ kind: "zenith-option-positions", version: 1, exportedAt: new Date(now).toISOString(), positions: list }, null, 2);
  }

  function mergeBackup(existing, text, now = Date.now()) {
    let data;
    try { data = JSON.parse(text); } catch (_) { return { list: existing, added: 0, skipped: 0, error: "That file is not valid JSON" }; }
    const incoming = Array.isArray(data) ? data : data && data.kind === "zenith-option-positions" ? data.positions : null;
    if (!Array.isArray(incoming)) return { list: existing, added: 0, skipped: 0, error: "That file does not hold option positions" };
    const have = new Set(existing.map(p => p.id));
    const list = existing.slice();
    let added = 0, skipped = 0;
    for (const raw of incoming) {
      const clean = sanitize(raw, now);
      if (!clean || have.has(clean.id)) { skipped++; continue; }
      have.add(clean.id); list.push(clean); added++;
    }
    return { list, added, skipped, error: "" };
  }

  /* ---------- syncing between devices ---------- */

  const TOMBSTONE_KEEP_MS = 120 * 24 * 60 * 60 * 1000;

  // Merges the positions saved on two devices. Each position keeps the copy that changed last; a position removed on one
  // device (recorded in the tombstones as id -> removal time) stays removed unless it was changed after that. Anything invalid
  // is dropped. Returns { list, tombstones }.
  function mergePositions(localList, remoteList, localTombs, remoteTombs, now = Date.now()) {
    const tombs = {};
    for (const source of [remoteTombs, localTombs]) {
      for (const [id, at] of Object.entries(source || {})) {
        const ts = Number(at) || 0;
        if (ts > (tombs[id] || 0)) tombs[id] = ts;
      }
    }
    const byId = new Map();
    for (const raw of [...(Array.isArray(remoteList) ? remoteList : []), ...(Array.isArray(localList) ? localList : [])]) {
      const clean = sanitize(raw, now);
      if (!clean) continue;
      const held = byId.get(clean.id);
      // Local copies are read last, so on a tie the local one is kept.
      if (!held || clean.updatedAt >= held.updatedAt) byId.set(clean.id, clean);
    }
    const list = [...byId.values()].filter(p => !(tombs[p.id] && tombs[p.id] >= p.updatedAt));
    for (const id of Object.keys(tombs)) if (now - tombs[id] > TOMBSTONE_KEEP_MS) delete tombs[id];
    return { list, tombstones: tombs };
  }

  // Sets a fresh updatedAt on a position that was just added or edited.
  const touch = (p, now = Date.now()) => ({ ...p, updatedAt: now });

  /* ---------- Zerodha positions export (CSV) ---------- */

  // Kite's positions download: Product, Instrument, Qty., Avg., LTP, P&L, Chg. Instrument names look like
  //   NIFTY26DEC18000PE     monthly: year, month name, strike, type
  //   NIFTY26N0321200PE     weekly: year, month code (1-9, O, N, D), day, strike, type
  const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
  const WEEK_CODES = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, O: 10, N: 11, D: 12 };
  const MONTHLY = /^(NIFTY|BANKNIFTY)(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d+)(CE|PE)$/;
  const WEEKLY = /^(NIFTY|BANKNIFTY)(\d{2})([1-9OND])(\d{2})(\d+)(CE|PE)$/;
  const two = n => String(n).padStart(2, "0");

  function parseCsvRows(text) {
    const rows = [];
    let row = [], cell = "", quoted = false;
    const s = String(text || "").replace(/^\uFEFF/, "");
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (quoted) {
        if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") { row.push(cell); cell = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && s[i + 1] === "\n") i++;
        row.push(cell); cell = "";
        if (row.some(c => c.trim() !== "")) rows.push(row);
        row = [];
      } else cell += ch;
    }
    row.push(cell);
    if (row.some(c => c.trim() !== "")) rows.push(row);
    return rows;
  }

  const looksLikeZerodhaCsv = text => /(^|\n)\s*"?product"?\s*,\s*"?instrument"?/i.test(String(text || "").slice(0, 400));

  // meta: { NIFTY: { lotSize, expiries: [{ date, monthly }] }, ... } from the contract list. Returns positions that can be
  // saved and a list of rows that were left out, each with the reason. Nothing is guessed: unclear rows are skipped.
  function fromZerodhaCsv(text, meta, now = Date.now()) {
    const rows = parseCsvRows(text);
    const out = { positions: [], skipped: [], error: "" };
    if (!rows.length) { out.error = "The file is empty"; return out; }
    const head = rows[0].map(c => c.trim().toLowerCase().replace(/\.$/, ""));
    const col = names => head.findIndex(h => names.includes(h));
    const iName = col(["instrument", "tradingsymbol", "symbol"]), iQty = col(["qty", "quantity"]), iAvg = col(["avg", "average price", "avg price"]);
    if (iName < 0 || iQty < 0 || iAvg < 0) { out.error = "This does not look like a Zerodha positions file (Instrument, Qty. and Avg. columns are needed)"; return out; }
    for (const r of rows.slice(1)) {
      const instrument = String(r[iName] || "").trim().toUpperCase();
      if (!instrument) continue;
      const skip = reason => out.skipped.push({ instrument, reason });
      const qty = Number(String(r[iQty]).replace(/,/g, "")), avg = Number(String(r[iAvg]).replace(/,/g, ""));
      let m = MONTHLY.exec(instrument), underlying, year, month, day = 0, strike, type;
      if (m) { [, underlying, year, , strike, type] = m; month = MONTHS[m[3]]; strike = Number(strike); }
      else if ((m = WEEKLY.exec(instrument))) { underlying = m[1]; year = m[2]; month = WEEK_CODES[m[3]]; day = Number(m[4]); strike = Number(m[5]); type = m[6]; }
      else { skip("Not a Nifty or Bank Nifty option"); continue; }
      if (!Number.isFinite(qty) || qty === 0) { skip("Closed position (quantity 0)"); continue; }
      if (!(avg > 0)) { skip("No average price"); continue; }
      const info = meta && meta[underlying];
      if (!info || !info.lotSize) { skip("Contract list not loaded"); continue; }
      let expiry = "";
      if (day) {
        expiry = `20${year}-${two(month)}-${two(day)}`;
        if (!Number.isFinite(Date.parse(expiry))) { skip("Expiry date is not valid"); continue; }
      } else {
        const hit = (info.expiries || []).find(e => e.monthly && e.date.startsWith(`20${year}-${two(month)}`));
        if (!hit) { skip("Monthly expiry is not in the contract list (already expired?)"); continue; }
        expiry = hit.date;
      }
      const lots = Math.abs(qty) / info.lotSize;
      if (!Number.isInteger(lots)) { skip(`Quantity ${Math.abs(qty)} is not a whole number of lots (lot size ${info.lotSize})`); continue; }
      const clean = sanitize({ id: "z:" + instrument, underlying, expiry, strike, type, side: qty < 0 ? "SELL" : "BUY", lots, avg, lotSize: info.lotSize }, now);
      if (!clean) { skip("Could not be read"); continue; }
      out.positions.push(clean);
    }
    return out;
  }

  // Positions from a Kite file replace earlier imports of the same instrument (the file is a snapshot); everything else stays.
  function mergeById(existing, incoming) {
    const list = existing.slice();
    let added = 0, updated = 0;
    for (const p of incoming) {
      const at = list.findIndex(x => x.id === p.id);
      if (at >= 0) { list[at] = { ...p, addedAt: list[at].addedAt, updatedAt: Date.now() }; updated++; }
      else { list.push({ ...p, updatedAt: Date.now() }); added++; }
    }
    return { list, added, updated };
  }

  const fingerprint = (list, tombs) =>
    (Array.isArray(list) ? list : []).map(p => `${p.id}@${p.updatedAt || 0}`).sort().join("|") + "#" +
    Object.entries(tombs || {}).map(([k, v]) => `${k}@${v}`).sort().join("|");

  // True when two state snapshots disagree about positions, whatever their lastSaved says.
  const differs = (a, b) => fingerprint(a?.optionPositions, a?.optionPositionTombstones) !== fingerprint(b?.optionPositions, b?.optionPositionTombstones);

  return { UNDERLYINGS, positionKey, groupPositions, evaluateGroup, sanitize, evaluate, totals, isExpired, toBackup, mergeBackup, looksLikeZerodhaCsv, fromZerodhaCsv, mergeById, mergePositions, touch, fingerprint, differs };
});
