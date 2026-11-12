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

test('expired REST session is repaired once before retrying, without leaking broker response text', async () => {
 let repairs=0,calls=0;
 const out=await recoverCandleHistory(body,async()=>++calls===1?{ok:true,status:200,json:{status:false,errorcode:'AG8001',message:'private details'}}:{ok:true,status:200,json:{status:true,data:[{close:6}]}},parse,Date.now(),async()=>repairs++);
 assert.equal(repairs,1);assert.equal(out[0].close,6);
});
test('persistent authentication failure only repairs once',async()=>{
 let repairs=0;
 await assert.rejects(recoverCandleHistory(body,async()=>({ok:false,status:401,json:{errorcode:'AG8001'}}),parse,Date.now(),async()=>repairs++),/AG8001/);
 assert.equal(repairs,1);
});
const { createCandleHistoryStore } = await import('./candle-history.js');
test('simultaneous same-contract requests share one broker call and recover after failure',async()=>{
 const store=createCandleHistoryStore();let resolve,calls=0;
 const fetcher=()=>{calls++;return new Promise(r=>resolve=r);};
 const one=store.load('45314:ONE_DAY',1000,fetcher),two=store.load('45314:ONE_DAY',1000,fetcher);
 await Promise.resolve();assert.equal(calls,1);resolve({candles:[{close:7}]});
 assert.deepEqual(await one,await two);
});
test('expired history is not silently returned during an outage; later requests can recover',async()=>{
 let at=0;const store=createCandleHistoryStore({now:()=>at});
 await store.load('a',100,async()=>({candles:[{close:7}]}));at=101;
 const failed=async()=>{throw new Error('broker unavailable');};
 await assert.rejects(store.load('a',100,failed),/unavailable/);
 const recovered=await store.load('a',100,async()=>({candles:[{close:8}]}));
 assert.equal(recovered.candles[0].close,8);assert.equal(recovered.stale,false);
});
