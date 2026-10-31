import test from "node:test";
import assert from "node:assert/strict";
import { symbolsForTick, EXCHANGE_BY_TYPE } from "./token-book.js";

function book(entries) {
  const aliases = new Map(), tokenToSymbol = new Map(), symbolToToken = new Map();
  entries.forEach(({ symbol, token, exchange }) => {
    tokenToSymbol.set(token, symbol);
    if (!aliases.has(token)) aliases.set(token, new Set());
    aliases.get(token).add(symbol);
    symbolToToken.set(symbol, { token, exchange });
  });
  return { aliases, tokenToSymbol, symbolToToken };
}

test("a packet from one exchange is credited only to symbols subscribed on that exchange", () => {
  const b = book([{ symbol: "NSESYM", token: "500", exchange: "NSE" }, { symbol: "BSESYM", token: "500", exchange: "BSE" }]);
  assert.deepEqual([...symbolsForTick(b.aliases, b.tokenToSymbol, b.symbolToToken, "500", "NSE")], ["NSESYM"]);
  assert.deepEqual([...symbolsForTick(b.aliases, b.tokenToSymbol, b.symbolToToken, "500", "BSE")], ["BSESYM"]);
});

test("a token with a single subscriber behaves as before", () => {
  const b = book([{ symbol: "ONLY", token: "42", exchange: "NSE" }]);
  assert.deepEqual([...symbolsForTick(b.aliases, b.tokenToSymbol, b.symbolToToken, "42", "NSE")], ["ONLY"]);
  assert.equal(symbolsForTick(b.aliases, b.tokenToSymbol, b.symbolToToken, "42", "BSE").size, 0);
  assert.equal(symbolsForTick(b.aliases, b.tokenToSymbol, b.symbolToToken, "999", "NSE").size, 0);
});

test("a symbol with no recorded exchange is treated as NSE, as the subscription code does", () => {
  const b = book([{ symbol: "LEGACY", token: "7", exchange: undefined }]);
  assert.equal(symbolsForTick(b.aliases, b.tokenToSymbol, b.symbolToToken, "7", "NSE").size, 1);
});

test("exchange types map to the exchanges the server subscribes", () => {
  assert.equal(EXCHANGE_BY_TYPE[1], "NSE");
  assert.equal(EXCHANGE_BY_TYPE[3], "BSE");
});

test('subscription payload preserves both exchanges when token numbers collide',async()=>{
 const {rememberPair,subscriptionGroups}=await import('./token-book.js');const b=book([]);
 rememberPair(b.aliases,b.tokenToSymbol,b.symbolToToken,{symbol:'NSE500',token:'500',exchange:'NSE'});
 rememberPair(b.aliases,b.tokenToSymbol,b.symbolToToken,{symbol:'BSE500',token:'500',exchange:'BSE'});
 assert.equal(b.tokenToSymbol.size,2);assert.deepEqual(subscriptionGroups(b.symbolToToken),[{exchangeType:1,tokens:['500']},{exchangeType:3,tokens:['500']}]);
 assert.deepEqual([...symbolsForTick(b.aliases,b.tokenToSymbol,b.symbolToToken,'500','NSE')],['NSE500']);
 assert.equal(symbolsForTick(b.aliases,b.tokenToSymbol,b.symbolToToken,'500',undefined).size,0);
});
test('changing a symbol token removes its old packet route',async()=>{const {rememberPair}=await import('./token-book.js'),b=book([]);rememberPair(b.aliases,b.tokenToSymbol,b.symbolToToken,{symbol:'MOVED',token:'1',exchange:'NSE'});rememberPair(b.aliases,b.tokenToSymbol,b.symbolToToken,{symbol:'MOVED',token:'2',exchange:'BSE'});assert.equal(symbolsForTick(b.aliases,b.tokenToSymbol,b.symbolToToken,'1','NSE').size,0);assert.deepEqual([...symbolsForTick(b.aliases,b.tokenToSymbol,b.symbolToToken,'2','BSE')],['MOVED']);});
