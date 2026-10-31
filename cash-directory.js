import tickerAliases from "./symbol-aliases.cjs";
// Broker directory validation is independent of a caller's saved/manual token.
const MASTER='https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json';
const aliases=s=>tickerAliases.resolve(String(s||'').trim().toUpperCase().replace(/-(EQ|BE|BZ|SM|ST|NSE|BSE)$/,'')).replace(/\s+/g,'');
const indices=[['NSE','99926000',['NIFTY','NIFTY 50']],['NSE','99926009',['BANKNIFTY','BANK NIFTY','NIFTY BANK']],['BSE','99919000',['SENSEX']]];
export function directoryIndex(rows){
 const index=new Map();
 for(const row of rows){
  const ex=String(row.exch_seg||row.exchange||'').toUpperCase(),type=String(row.instrumenttype||'').toUpperCase();
  if(!['NSE','BSE'].includes(ex)||!['','EQ','EQUITY','AMXIDX','INDEX','ETF','SGB','BOND','DEB'].includes(type))continue;
  const token=String(row.token||row.symboltoken||'');if(!/^\d+$/.test(token))continue;
  const key=ex+':'+token,set=index.get(key)||new Set();
  for(const name of [row.name,row.symbol,row.tradingsymbol])if(name)set.add(aliases(name));
  if(ex==='BSE')set.add(token);
  index.set(key,set);
 }
 for(const [ex,token,names] of indices)index.set(ex+':'+token,new Set(names.map(aliases)));
 return index;
}
export function matchesDirectory(index,pair){return !!index.get((pair.exchange||'NSE')+':'+String(pair.token))?.has(aliases(pair.symbol));}
export function partitionDirectory(index,pairs){
 return {accepted:pairs.filter(p=>matchesDirectory(index,p)),rejected:pairs.filter(p=>!matchesDirectory(index,p))};
}
export function repairPair(index,pair){
 if(matchesDirectory(index,pair))return pair;
 const name=aliases(pair.symbol),prefix=(pair.exchange||'NSE')+':';
 const candidates=[...index].filter(([key,names])=>key.startsWith(prefix)&&names.has(name));
 if(candidates.length!==1)return null;
 return {...pair,token:candidates[0][0].slice(prefix.length),exchange:pair.exchange||'NSE'};
}
export function createDirectory(fetcher){
 let cached=null,pending=null;
 return async function load(){
  if(cached&&Date.now()-cached.at<6*3600000)return cached.index;
  if(pending)return pending;
  pending=(async()=>{
   const r=await fetcher(MASTER,{signal:AbortSignal.timeout(12000)});
   if(!r.ok)throw Error('Instrument directory unavailable');
   const rows=await r.json();if(!Array.isArray(rows)||rows.length<1000)throw Error('Incomplete instrument directory');
   const index=directoryIndex(rows);cached={at:Date.now(),index};return index;
  })().finally(()=>{pending=null;});
  return pending;
 };
}
