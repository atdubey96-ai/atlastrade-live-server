import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, emptyState } from "./health-monitor.js";

const report = (status, detail) => ({ feeds: { crypto: { status, detail } } });

test("one bad check is a blip; the second in a row sends one message; it is not repeated", () => {
  let r = evaluate(emptyState(), report("down", "HTTP 429"), 1000);
  assert.equal(r.messages.length, 0);
  r = evaluate(r.state, report("down", "HTTP 429"), 2000);
  assert.equal(r.messages.length, 1); assert.match(r.messages[0], /Crypto prices is not responding \(HTTP 429\)/);
  r = evaluate(r.state, report("down", "HTTP 429"), 3000);
  assert.equal(r.messages.length, 0);
});

test("recovery needs two good checks and sends one message", () => {
  let r = evaluate(emptyState(), report("down"), 1); r = evaluate(r.state, report("down"), 2);
  r = evaluate(r.state, report("ok"), 3); assert.equal(r.messages.length, 0);
  r = evaluate(r.state, report("ok"), 4); assert.equal(r.messages.length, 1); assert.match(r.messages[0], /recovered/);
  r = evaluate(r.state, report("ok"), 5); assert.equal(r.messages.length, 0);
});

test("a flapping source that is never bad twice in a row stays silent; a long outage reminds after six hours", () => {
  let r = emptyState(), sent = 0;
  for (const s of ["down", "ok", "down", "ok", "down", "ok"]) { const e = evaluate(r, report(s), sent++); r = e.state; assert.equal(e.messages.length, 0); }
  let e = evaluate(emptyState(), report("down"), 0); e = evaluate(e.state, report("down"), 1);
  assert.equal(e.messages.length, 1);
  e = evaluate(e.state, report("down"), 5 * 3600000); assert.equal(e.messages.length, 0);
  e = evaluate(e.state, report("down"), 7 * 3600000); assert.equal(e.messages.length, 1);
});

test("a change from stale to down is announced as a new problem", () => {
  let e = evaluate(emptyState(), report("degraded"), 0); e = evaluate(e.state, report("degraded"), 1);
  assert.equal(e.messages.length, 1);
  e = evaluate(e.state, report("down"), 2); assert.equal(e.messages.length, 1);
});
