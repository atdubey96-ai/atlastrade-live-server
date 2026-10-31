(function (root, factory) { const api=factory(root); if(typeof module === "object" && module.exports)module.exports=api; if(root)root.AtlasMarketEngine=api; })(typeof window !== "undefined" ? window : null, function (root) {
  "use strict";

  const HOLIDAYS = {
    NSE: new Set([
      "2026-01-15", "2026-01-26", "2026-02-15", "2026-03-03", "2026-03-21", "2026-03-26", "2026-03-31", "2026-04-03", "2026-04-14", "2026-05-01", "2026-05-28", "2026-06-26", "2026-08-15", "2026-09-14", "2026-10-02", "2026-10-20", "2026-11-08", "2026-11-10", "2026-11-24", "2026-12-25"
    ]),
    US: new Set([
      "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
      "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
      "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
      "2028-01-17", "2028-02-21", "2028-04-14", "2028-05-29", "2028-06-19", "2028-07-04", "2028-09-04", "2028-11-23", "2028-12-25"
    ])
  };

  // Sources: NSE /api/holiday-master?type=trading (CM), NYSE /trade/hours-calendars.
  // Special-session circulars: NSE/CMTR/76941 and NSE/FAOP/76940, 19 Oct 2026.
  const years = { NSE: new Set([2026]), US: new Set([2026,2027,2028]) };
  const earlyUS = new Set(["2026-11-27","2026-12-24","2027-11-26","2028-07-03","2028-11-24"]);
  function applyCalendar(data) {
    const year=Number(data?.year),dates=data?.holidays;
    if(data?.market!=="NSE" || !Number.isInteger(year) || year<2026 || !Array.isArray(dates) || dates.length<10 || dates.some(date=>!new RegExp("^"+year+"-\\d{2}-\\d{2}$").test(date)||!Number.isFinite(Date.parse(date))))return false;
    for(const date of [...HOLIDAYS.NSE])if(date.startsWith(year+"-"))HOLIDAYS.NSE.delete(date);
    dates.forEach(date=>HOLIDAYS.NSE.add(date));years.NSE.add(year);return true;
  }

  function partsInZone(date, timeZone) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(date).reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
    return {
      dateKey: `${parts.year}-${parts.month}-${parts.day}`,
      weekday: parts.weekday,
      minutes: Number(parts.hour) * 60 + Number(parts.minute)
    };
  }

  function session(market, now = new Date()) {
    now = new Date(now);
    if(market==="CRYPTO")return {open:true,known:true,reason:"continuous"};
    if(market==="FX") {const p=partsInZone(now,"America/New_York");return {known:true,open:p.weekday!=="Sat" && !(p.weekday==="Fri" && p.minutes>=17*60) && !(p.weekday==="Sun" && p.minutes<17*60),reason:"fx-week"};}
    const us=market==="US",key=us?"US":"NSE",p=partsInZone(now,us?"America/New_York":"Asia/Kolkata"),year=Number(p.dateKey.slice(0,4));
    if(!years[key].has(year))return {open:false,known:false,reason:"calendar-unavailable"};
    if(!us && p.dateKey==="2026-11-08" && market!=="MF")return {open:p.minutes>=860 && p.minutes<(market==="NFO"?940:market==="NSE_CAS"?935:930),known:true,reason:"muhurat"};
    if(p.weekday==="Sat"||p.weekday==="Sun"||HOLIDAYS[key].has(p.dateKey))return {open:false,known:true,reason:"closed-day"};
    const start=us?570:market==="MF"?1080:555,end=us?(earlyUS.has(p.dateKey)?780:960):market==="MF"?1410:market==="NFO"?940:market==="NSE_CAS"?935:930;
    return {open:p.minutes>=start&&p.minutes<end,known:true,reason:us&&earlyUS.has(p.dateKey)?"early-close":"regular",date:p.dateKey,start,end};
  }
  function isMarketOpen(market, now = new Date()) {return session(market,now).open;}

  function marketForSymbol(symbol = "", item = null) {
    const sym = String(symbol || item?.symbol || "").toUpperCase();
    const ex = String(item?.exchange || "").toUpperCase();
    if (ex === "NFO" || /^(NIFTY|BANKNIFTY)\d{2}[A-Z]{3}\d{2}\d+(CE|PE)$/.test(sym)) return "NFO";
    if (item?.cas === true) return "NSE_CAS";
    if (sym.endsWith("-CX") || ex === "CRYPTO" || ["BITCOIN", "ETHEREUM"].includes(sym)) return "CRYPTO";
    if (ex === "FX" || ["USD/INR", "USDINR", "INR=X"].includes(sym)) return "FX";
    if (sym.endsWith("-MF") || ex === "MF") return "MF";
    if (sym.endsWith("-US") || ex === "US" || ["S&P 500", "NASDAQ", "DOW JONES"].includes(sym)) return "US";
    return "NSE";
  }

  function canUseLiveCandle(symbol, item = null, now = new Date()) {
    return isMarketOpen(marketForSymbol(symbol, item), now);
  }

  const api = {
    session, applyCalendar,
    holidays: HOLIDAYS,
    partsInZone,
    isMarketOpen,
    isMarketSessionOpen: isMarketOpen,
    marketForSymbol,
    canUseLiveCandle
  };
  if(root && typeof root.fetch === "function") {
    const refresh=async()=>{try{const r=await root.fetch("/api/indices?route=calendar",{cache:"no-store"});if(r.ok)applyCalendar(await r.json());}catch{}};
    refresh(); root.setInterval(refresh,6*3600000);
  }
  return api;
});
