// Token → symbol lookups for the cash-market feed.
//
// NSE and BSE number their instruments separately, so the same token can name two different securities. The maps in index.js are
// keyed by token alone; this narrows a lookup to the symbols that were subscribed on the exchange the packet came from, so a BSE
// packet is never credited to an NSE symbol (or the other way round).

export const EXCHANGE_BY_TYPE = { 1: "NSE", 3: "BSE" };

// aliases: Map(token -> Set(symbol)), tokenToSymbol: Map(token -> symbol), symbolToToken: Map(symbol -> { token, exchange })
export function symbolsForTick(aliases, tokenToSymbol, symbolToToken, token, exchange) {
  const all = aliases.get(token) || new Set([tokenToSymbol.get(token)].filter(Boolean));
  const out = new Set();
  all.forEach(symbol => {
    const subscribedOn = symbolToToken.get(symbol)?.exchange || "NSE";
    if (!exchange || subscribedOn === exchange) out.add(symbol);
  });
  return out;
}
