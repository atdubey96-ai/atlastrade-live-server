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
