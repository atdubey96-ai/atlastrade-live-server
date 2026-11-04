import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverCandleHistory } from './candle-history.js';
const body={interval:'ONE_DAY',fromdate:'2025-01-01 00:00'};
const parse=x=>x;
test('rejects malformed HTTP 200 and recovers on the next broker response',async()=>{
 let calls=0;
 const out=await recoverCandleHistory(body,async()=>++calls===1?{ok:true,status:200,json:{}}:{ok:true,status:200,json:{status:true,data:[{close:4}]}},parse);
 assert.equal(calls,2);assert.equal(out[0].close,4);
});
test('empty history retries a bounded recent date window',async()=>{
 const requests=[];
 const out=await recoverCandleHistory(body,async b=>{requests.push(b);return {ok:true,status:200,json:{status:true,data:requests.length===3?[{close:5}]:[]}}},parse,Date.parse('2026-11-04T02:00:00Z'));
 assert.equal(requests[2].fromdate,'2026-10-28 00:00');assert.equal(out[0].close,5);assert.equal(body.fromdate,'2025-01-01 00:00');
});
test('persistent empty history fails explicitly without invented candles',async()=>{
 await assert.rejects(recoverCandleHistory(body,async()=>({ok:true,status:200,json:{status:true,data:[]}}),parse),e=>e.code==='HISTORY_EMPTY');
});
