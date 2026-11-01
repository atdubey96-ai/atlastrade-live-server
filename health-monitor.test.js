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
  e = evaluate(e.state, report("down"), 2); assert.equal(e.messages.length, 0);
  e = evaluate(e.state, report("down"), 3); assert.equal(e.messages.length, 1);
});

const device=(status,at,rate=0)=>({feeds:{quoteQuality:{status,observationAt:at,reportingDevices:1,blockingFailureRate:rate}}});
test("missing device evidence and repeated snapshots cannot announce recovery",()=>{
 let e=evaluate({},device('degraded',1,.5),1);e=evaluate(e.state,device('degraded',2,.5),2);
 assert.equal(e.messages.length,1);
 e=evaluate(e.state,{feeds:{quoteQuality:{status:'ok',reportingDevices:0}}},3);assert.equal(e.messages.length,0);
 e=evaluate(e.state,device('ok',4),4);assert.equal(e.messages.length,0);
 e=evaluate(e.state,device('ok',4),5);assert.equal(e.messages.length,0);
 e=evaluate(e.state,device('ok',6),6);assert.match(e.messages[0],/recovered/);
});
test("flapping after recovery respects reminder cooldown; unknown checks break consecutive evidence",()=>{
 let e=evaluate({},report('down'),0);e=evaluate(e.state,report('down'),1);
 for(const s of ['ok','ok','down','down','ok','ok','down','down']){e=evaluate(e.state,report(s),100);assert.equal(e.messages.filter(x=>x.startsWith('⚠')).length,0);}
 e=evaluate({},report('down'),0);e=evaluate(e.state,report('unknown'),1);e=evaluate(e.state,report('down'),2);assert.equal(e.messages.length,0);
});
test("calendar alerts describe session uncertainty rather than stale prices",()=>{
 let e=evaluate({},{feeds:{calendar:{status:'down'}}},1);e=evaluate(e.state,{feeds:{calendar:{status:'down'}}},2);
 assert.match(e.messages[0],/not a price-feed outage/);assert.doesNotMatch(e.messages[0],/your other data is unaffected/);
});

test("partial recovery from down to degraded does not send a second warning",()=>{
 let e=evaluate({},report('down'),0);e=evaluate(e.state,report('down'),1);
 e=evaluate(e.state,report('degraded'),2);e=evaluate(e.state,report('degraded'),3);assert.equal(e.messages.length,0);
});
