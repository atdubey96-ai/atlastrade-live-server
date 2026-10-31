(function(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ZenithInstruments = api;
})(typeof window !== "undefined" ? window : globalThis, function() {
  "use strict";
  const normalize = value => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  function quoteId(item={}) {
    let symbol=String(item.symbol||'').trim().toUpperCase(),ex=String(item.exchange||'').toUpperCase();
    const base=symbol.replace(/-US$/,'');
    const indices={'NIFTY':'NIFTY 50','NIFTY 50':'NIFTY 50','BANKNIFTY':'BANK NIFTY','NIFTY BANK':'BANK NIFTY','BANK NIFTY':'BANK NIFTY','GIFTNIFTY':'GIFT NIFTY','GIFT NIFTY':'GIFT NIFTY','SENSEX':'SENSEX','^GSPC':'S&P 500','S&P 500':'S&P 500','^IXIC':'NASDAQ','NASDAQ':'NASDAQ','NASDAQ COMPOSITE':'NASDAQ','^DJI':'DOW JONES','DOW JONES':'DOW JONES'};
    const coins={BTC:'BITCOIN','BTC-USD':'BITCOIN',BITCOIN:'BITCOIN',ETH:'ETHEREUM','ETH-USD':'ETHEREUM',ETHEREUM:'ETHEREUM'};
    if(ex==='NFO'||/^(NIFTY|BANKNIFTY)\d{2}[A-Z]{3}\d{2}\d{3,6}(CE|PE)$/.test(symbol))return `NFO:OPT:${symbol}:INR`;
    if(/-CX$/.test(symbol)||ex==='CRYPTO'){
      const token=String(item.token||symbol.replace(/-CX$/,'')).toUpperCase();
      return `CRYPTO:SPOT:${coins[token]||token}:USD`;
    }
    if(/-MF$/.test(symbol)||ex==='MF')return `MF:NAV:${symbol.replace(/-MF$/,'')}:INR`;
    if(symbol==='USD/INR'||symbol==='USDINR')return 'FX:SPOT:USDINR:INR';
    if(indices[base])return `INDEX:SPOT:${indices[base]}:${['S&P 500','NASDAQ','DOW JONES'].includes(indices[base])?'USD':'INR'}`;
    if(/-US$/.test(symbol)||ex==='US')return `US:STOCK:${base.replace(/^([A-Z]+)-([AB])$/,'$1.$2')}:USD`;
    if(['GOLD BEES','GOLDBEES'].includes(symbol))symbol='GOLDBEES';
    if(['SILVER BEES','SILVERBEES'].includes(symbol))symbol='SILVERBEES';
    return `${ex==='BSE'?'BSE':'NSE'}:EQ:${symbol}:INR`;
  }
  function key(item = {}) {
    const symbol = String(item.symbol || "").trim().toUpperCase();
    const exchange = String(item.exchange || (symbol.endsWith("-US") ? "US" : symbol.endsWith("-CX") ? "CRYPTO" : symbol.endsWith("-MF") ? "MF" : "NSE")).toUpperCase();
    const id = item.isin || item.id || item.token || symbol;
    return [exchange, item.segment || exchange, String(id).toUpperCase(), item.currency || (["US", "CRYPTO"].includes(exchange) ? "USD" : "INR")].join(":");
  }
  function fund(rows, name) {
    const list = Array.isArray(rows) ? rows : rows?.rows || [];
    const wanted = normalize(name);
    if (!wanted) return "";
    const exact = list.filter(row => normalize(row.schemeName || row.name) === wanted);
    if (exact.length !== 1) return "";
    const code = String(exact[0].schemeCode || exact[0].token || exact[0].symbol || "").replace(/-MF$/i, "");
    return /^\d{3,}$/.test(code) ? code : "";
  }
  function navDate(value) {
    const text = String(value || "");
    const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(text);
    const iso = match ? `${match[3]}-${match[2]}-${match[1]}` : text;
    const at=Date.parse(iso);
    return /^\d{4}-\d{2}-\d{2}$/.test(iso) && Number.isFinite(at) && new Date(at).toISOString().slice(0,10)===iso ? iso : "";
  }
  return { key, quoteId, fund, navDate };
});
