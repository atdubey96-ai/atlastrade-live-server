import test from 'node:test';
import assert from 'node:assert/strict';
import {serviceAuthorized,requireService} from './service-auth.js';
import {directoryIndex,matchesDirectory} from './cash-directory.js';
import {createGapWatch} from './gap-watch.js';
import identity from './instrument-identity.cjs';
test('subscription and operational mutations require a server-only service token',()=>{
 assert.equal(serviceAuthorized({headers:{}},'fixture-token'),false);
 assert.equal(serviceAuthorized({headers:{authorization:'Bearer wrong'}},'fixture-token'),false);
 assert.equal(serviceAuthorized({headers:{authorization:'Bearer fixture-token'}},'fixture-token'),true);
 assert.equal(serviceAuthorized({headers:{}},''),false);
 let next=false,code;
 requireService({headers:{}},{status(c){code=c;return this;},json(){}},()=>next=true);
 assert.equal(next,false);assert.equal(code,401);
});
test('a syntactically valid but wrong token or exchange cannot be remapped onto a company',()=>{
 const index=directoryIndex([{name:'INFY',symbol:'INFY-EQ',token:'1594',exch_seg:'NSE',instrumenttype:''},{name:'TCS',symbol:'TCS-EQ',token:'11536',exch_seg:'NSE'}]);
 assert.equal(matchesDirectory(index,{symbol:'INFY',token:'1594',exchange:'NSE'}),true);
 assert.equal(matchesDirectory(index,{symbol:'INFY',token:'11536',exchange:'NSE'}),false);
 assert.equal(matchesDirectory(index,{symbol:'INFY',token:'1594',exchange:'BSE'}),false);
 assert.equal(matchesDirectory(index,{symbol:'NIFTY 50',token:'99926000',exchange:'NSE'}),true);
});
test('never-received subscriptions count in coverage; a snapshot check cannot turn a stale quote fresh',()=>{
 const g=createGapWatch(),open=1000000,now=open+600000;
 g.register('NEVER',open);g.observe('GOOD',now-1000,now);
 const before=g.stats(now,true,open);assert.equal(before.watching,2);assert.equal(before.neverSeen,1);assert.equal(before.gappedNow,1);assert.equal(before.coverage,0.5);
 g.checked('NEVER',now);
 assert.equal(g.gapped(now+1000,true,open).length,0,'retry is throttled');
 assert.equal(g.stats(now+1000,true,open).coverage,0.5,'coverage is not inflated by checking');
 g.observe('NEVER',now+2000,now+2000);assert.equal(g.stats(now+2000,true,open).coverage,1);
});
test('backend quote IDs use the shared canonical aliases on cash, indices and options',()=>{
 assert.equal(identity.quoteId({symbol:'INFY',exchange:'NSE'}),'NSE:EQ:INFY:INR');
 assert.equal(identity.quoteId({symbol:'NIFTY',exchange:'NSE'}),'INDEX:SPOT:NIFTY 50:INR');
 assert.equal(identity.quoteId({symbol:'NIFTY03NOV2622700CE',exchange:'NFO'}),'NFO:OPT:NIFTY03NOV2622700CE:INR');
});

test('directory validation preserves numeric BSE listings, ETF display spaces and recorded ticker renames',()=>{
 const index=directoryIndex([{name:'RELIANCE',symbol:'RELIANCE',token:'500325',exch_seg:'BSE'},{name:'GOLDBEES',symbol:'GOLDBEES-EQ',token:'14428',exch_seg:'NSE'},{name:'ABREL',symbol:'ABREL-EQ',token:'625',exch_seg:'NSE'}]);
 assert.equal(matchesDirectory(index,{symbol:'500325',token:'500325',exchange:'BSE'}),true);
 assert.equal(matchesDirectory(index,{symbol:'GOLD BEES',token:'14428',exchange:'NSE'}),true);
 assert.equal(matchesDirectory(index,{symbol:'CENTURYTEX',token:'625',exchange:'NSE'}),true);
 assert.equal(matchesDirectory(index,{symbol:'TCS',token:'625',exchange:'NSE'}),false);
});
