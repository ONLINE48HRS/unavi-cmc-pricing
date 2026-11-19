import type {CmcClient} from './client.ts';
import {latestQuotes} from './prices.ts';
import {resolver,type Asset,type Resolved} from './resolve.ts';

export type Holding=Asset&{amount:string};
export type Priced=Holding&{price:string|null;value:string|null;source:'primary'|'coinmarketcap'|null;cmc:Resolved|null;note:string|null};

// Exact decimal maths on strings, so values never pass through floating point.
function multiply(a:string,b:string){
 const scale=(s:string)=>{const [i,f='']=s.replace(/^-/,'').split('.');return {n:BigInt(i+f||'0')*(s.startsWith('-')?-1n:1n),d:f.length}};
 const x=scale(a),y=scale(b),n=x.n*y.n,d=x.d+y.d,neg=n<0n,abs=(neg?-n:n).toString().padStart(d+1,'0');
 const whole=abs.slice(0,abs.length-d),frac=abs.slice(abs.length-d).replace(/0+$/,'');
 return `${neg?'-':''}${whole}${frac?'.'+frac:''}`;
}

// The primary source (UNAVI uses Binance and ECB) prices what it can. CoinMarketCap is asked only about the rest, in one batched
// quote call, so a wallet full of long-tail tokens costs a handful of credits instead of one per token.
export async function priceHoldings(client:CmcClient,holdings:Holding[],primary:(asset:Asset)=>string|undefined,currency='USD'):Promise<Priced[]>{
 const resolve=resolver(client),gaps:{index:number;cmc:Resolved|null}[]=[];
 const rows:Priced[]=holdings.map(h=>{const p=primary(h);return {...h,price:p??null,value:p?multiply(h.amount,p):null,source:p?'primary':null,cmc:null,note:null}});
 for(const [index,row] of rows.entries())if(!row.price)gaps.push({index,cmc:await resolve(row)});
 const quotes=await latestQuotes(client,gaps.flatMap(g=>g.cmc?[g.cmc.id]:[]),currency);
 for(const {index,cmc} of gaps){const row=rows[index];row.cmc=cmc;
  if(!cmc){row.note='Not listed on CoinMarketCap';continue}
  const q=quotes.get(cmc.id);if(!q){row.note='Listed, but no current quote';continue}
  Object.assign(row,{price:q.price,value:multiply(row.amount,q.price),source:'coinmarketcap',note:cmc.by==='address'?null:`Matched by symbol only (${cmc.name}${cmc.ambiguous?', the top-ranked of several':''}). Add the contract address to be sure.`});
 }
 return rows;
}

export {multiply};
