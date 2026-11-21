import type {CmcClient} from './client.ts';

// Answers repeated requests from memory for as long as the engine's freshness rules allow, so a page that many people open
// costs credits only when its data would otherwise go stale. Endpoints not listed are never cached. A failed request is
// not kept. Data served from the cache still carries CoinMarketCap's own timestamps, so its age is never misstated.
export const CACHE_TTL_MS:Record<string,number>={
 '/v2/cryptocurrency/info':Infinity,'/v1/cryptocurrency/map':Infinity,
 '/v3/cryptocurrency/quotes/latest':5*60_000,'/v1/dex/token/price':5*60_000,'/v1/dex/token/pools':5*60_000,
 '/v1/dex/security/detail':24*3_600_000,'/v1/dex/holders/list':24*3_600_000};

export function cachedClient(client:CmcClient,{ttl=CACHE_TTL_MS,clock=()=>Date.now(),store=new Map<string,{at:number;value:Promise<any>}>()}:{ttl?:Record<string,number>;clock?:()=>number;store?:Map<string,{at:number;value:Promise<any>}>}={}):CmcClient{
 function through(key:string,endpoint:string,call:()=>Promise<any>){
  const life=ttl[endpoint]??0;if(!life)return call();
  const hit=store.get(key);if(hit&&clock()-hit.at<life)return hit.value;
  const value=call();store.set(key,{at:clock(),value});value.catch(()=>{if(store.get(key)?.value===value)store.delete(key)});return value;
 }
 return {
  get:(endpoint,params={})=>through(`GET ${endpoint} ${JSON.stringify(params)}`,endpoint,()=>client.get(endpoint,params)),
  post:(endpoint,payload)=>through(`POST ${endpoint} ${JSON.stringify(payload)}`,endpoint,()=>client.post(endpoint,payload)),
  calls:client.calls,credits:client.credits};
}
