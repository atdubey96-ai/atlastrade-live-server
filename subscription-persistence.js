// Durable subscription metadata is scoped through the website; no portfolio or database credentials are needed here.
export function persistence({fetch,site,token,onRestore,onStatus=()=>{}}){
 let pending=new Map(),timer=null,saving=null;
 const endpoint=`${site}/api/indices?route=subscription-state`;
 async function restore(){
  if(!token){onStatus('unconfigured');return false;}
  try{const response=await fetch(endpoint,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error('Persistence unavailable');const data=await response.json();if(!Array.isArray(data.symbols))throw Error('Invalid persistence response');onRestore(data.symbols);onStatus('restored');return true;}catch{onStatus('restore-failed');return false;}
 }
 async function flush(){
  if(saving||!pending.size||!token)return;
  const batch=[...pending.values()];pending.clear();
  saving=(async()=>{try{const response=await fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({symbols:batch}),signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('Persistence unavailable');onStatus('saved');}catch{batch.forEach(p=>{if(!pending.has(p.symbol))pending.set(p.symbol,p)});onStatus('save-failed');}finally{saving=null;if(pending.size){clearTimeout(timer);timer=setTimeout(flush,30000);timer.unref?.();}}})();await saving;
 }
 return {restore,flush,queue(pairs){pairs.forEach(p=>pending.set(p.symbol,p));clearTimeout(timer);timer=setTimeout(flush,1000);timer.unref?.();},pending:()=>pending.size};
}
