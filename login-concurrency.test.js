import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
test('history arriving during startup awaits the shared broker login and can retry a failed login',async()=>{
 const src=fs.readFileSync(new URL('./index.js',import.meta.url),'utf8');
 const block=src.slice(src.indexOf('let ensureLoginPromise = null;'),src.indexOf('// Login on startup'));
 let finish,calls=0,connected=0;
 const ctx={aoToken:null,lastLoginAt:0,Date,Promise,symbolToToken:new Map(),connectWebSocket:()=>connected++,primeSnapshots:async()=>{},loginAngelOne:()=>{calls++;return new Promise(r=>finish=r);}};
 vm.createContext(ctx);vm.runInContext(block+'\nglobalThis.login=ensureLoggedIn;',ctx);
 const first=ctx.login(),second=ctx.login();assert.equal(first,second);assert.equal(calls,1);
 let done=false;second.then(()=>done=true);await Promise.resolve();assert.equal(done,false);
 finish(false);await first;
 const retry=ctx.login();assert.equal(calls,2);ctx.aoToken='test';finish(true);await retry;assert.equal(connected,1);
});
