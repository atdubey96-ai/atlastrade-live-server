import test from "node:test";
import assert from "node:assert/strict";
import { createGapWatch, openedAtIst } from "./gap-watch.js";

const NOW = Date.UTC(2026, 10, 2, 5, 30);      // Mon 2 Nov 2026, 11:00 IST
const OPEN = openedAtIst(NOW);

test("openedAtIst is 09:15 IST of the same day", () => {
  assert.equal(new Date(OPEN).toISOString(), "2026-11-02T03:45:00.000Z");
});

test("a busy stock that goes quiet is a gap quickly; a thin stock is judged by its own rhythm", () => {
  const g = createGapWatch();
  // BUSY ticks every 2 s for a while, THIN every 4 minutes
  for (let i = 0; i < 20; i++) g.observe("BUSY", NOW - 120000 + i * 2000, NOW);
  for (let i = 0; i < 8; i++) g.observe("THIN", NOW - 8 * 240000 + i * 240000, NOW);
  // BUSY: last tick ~ 80 s ago (< 90 s floor) -> not yet; 100 s -> gap (floor). THIN: silent 4 min < 8 x 4 min -> fine
  assert.deepEqual(g.gapped(NOW - 80000 + 38000 + 100000, true, OPEN), ["BUSY"]);
  assert.deepEqual(g.gapped(NOW, true, OPEN), []);
});

test("nothing is a gap when the market is closed, and yesterday's last tick is not a gap in the first minutes of today", () => {
  const g = createGapWatch();
  for (let i = 0; i < 10; i++) g.observe("X", OPEN - 86400000 + i * 1000, NOW);
  assert.deepEqual(g.gapped(NOW, false, OPEN), []);
  assert.deepEqual(g.gapped(OPEN + 60000, true, OPEN), []);                 // one minute after the open: too early to call
  assert.deepEqual(g.gapped(OPEN + 20 * 60000, true, OPEN), ["X"]);         // twenty minutes without a single tick today
});

test("a tick after a gap closes it, and coverage reflects the share of silent instruments", () => {
  const g = createGapWatch();
  for (const sym of ["A", "B", "C", "D"]) for (let i = 0; i < 10; i++) g.observe(sym, NOW - 600000 + i * 1000, NOW);
  assert.equal(g.stats(NOW, true, OPEN).gappedNow, 4);
  g.observe("A", NOW - 1000, NOW); g.observe("B", NOW - 1000, NOW);
  const s = g.stats(NOW, true, OPEN);
  assert.equal(s.gappedNow, 2); assert.equal(s.coverage, 0.5); assert.equal(s.gapsClosedLastHour, 2);
});

test("old or repeated ticks are ignored and overnight gaps do not distort the rhythm", () => {
  const g = createGapWatch();
  g.observe("Z", NOW - 3600000, NOW); g.observe("Z", NOW - 3600000, NOW); g.observe("Z", NOW - 4000000, NOW);
  g.observe("Z", NOW - 3000000, NOW);            // 10 minutes later: inside the learn limit
  g.observe("Z", NOW + 20 * 3600000, NOW);       // next day: ignored for rhythm
  assert.equal(g.size(), 1);
});

test("an instrument the snapshot found genuinely quiet is not asked about again until a full threshold has passed", () => {
  const g = createGapWatch();
  for (let i = 0; i < 10; i++) g.observe("QUIET", NOW - 700000 + i * 1000, NOW);
  assert.deepEqual(g.gapped(NOW, true, OPEN), ["QUIET"]);
  g.checked("QUIET", NOW);
  assert.deepEqual(g.gapped(NOW + 60000, true, OPEN), []);
  assert.deepEqual(g.gapped(NOW + 400000, true, OPEN), ["QUIET"]);
});
