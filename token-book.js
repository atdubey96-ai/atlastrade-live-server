// Cash instruments are identified by exchange AND token in subscriptions and packets.
export const EXCHANGE_BY_TYPE = { 1: 'NSE', 3: 'BSE' };
export function cashKey(exchange, token) {return `${exchange || 'NSE'}:${String(token)}`;}
export function validPair(pair) {return pair && /^[A-Z0-9&._ -]{1,50}$/.test(String(pair.symbol||'')) && /^\d{1,20}$/.test(String(pair.token||'')) && ['NSE','BSE'].includes(pair.exchange||'NSE');}
export function rememberPair(aliases, tokenToSymbol, symbolToToken, pair) {
 if(!validPair(pair))return false;
 const {symbol}=pair,token=String(pair.token),exchange=pair.exchange||'NSE',key=cashKey(exchange,token);
 const old=symbolToToken.get(symbol);
 if(old&&cashKey(old.exchange,old.token)!==key){const previous=cashKey(old.exchange,old.token),set=aliases.get(previous);set?.delete(symbol);if(!set?.size){aliases.delete(previous);tokenToSymbol.delete(previous);}else tokenToSymbol.set(previous,[...set][0]);}
 if(!aliases.has(key))aliases.set(key,new Set());aliases.get(key).add(symbol);
 tokenToSymbol.set(key,symbol);symbolToToken.set(symbol,{token,exchange});return true;
}
export function subscriptionGroups(symbolToToken) {
 const groups=new Map();symbolToToken.forEach(({token,exchange})=>{const type=exchange==='BSE'?3:1;if(!groups.has(type))groups.set(type,new Set());groups.get(type).add(String(token));});
 return [...groups].map(([exchangeType,tokens])=>({exchangeType,tokens:[...tokens]}));
}
export function symbolsForTick(aliases, tokenToSymbol, symbolToToken, token, exchange) {
 if(!['NSE','BSE'].includes(exchange))return new Set();
 const key=cashKey(exchange,token);
 // Legacy token-only books remain readable during migration, but always filter by recorded exchange.
 const all=aliases.get(key)||aliases.get(String(token))||new Set([tokenToSymbol.get(key)||tokenToSymbol.get(String(token))].filter(Boolean));
 return new Set([...all].filter(symbol=>{const held=symbolToToken.get(symbol);return held&&String(held.token)===String(token)&&(held.exchange||'NSE')===exchange;}));
}
