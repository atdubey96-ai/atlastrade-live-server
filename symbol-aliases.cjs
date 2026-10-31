"use strict";

// Companies that changed their NSE ticker. Brokers keep sending the old tradingsymbol for existing holdings, and the exchange
// no longer lists it, so quotes, charts and official prices must be looked up under the current ticker.
const ALIASES = {
  CENTURYTEX: "ABREL",   // Century Textiles and Industries -> Aditya Birla Real Estate
  PFI: "PIRAMALFIN",     // Piramal Enterprises -> Piramal Finance
};

const SUFFIX = /-(?:EQ|BE|BZ|BL|IL|SM|ST|W|NS)$/i;

// Current ticker for a symbol, keeping any series suffix out of the way: "PFI-EQ" -> "PIRAMALFIN".
function resolve(symbol) {
  const base = String(symbol || "").toUpperCase().replace(SUFFIX, "");
  return ALIASES[base] || base;
}

module.exports = { ALIASES, resolve };
