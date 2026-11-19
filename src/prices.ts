import type {CmcClient} from './client.ts';

export type Quote={id:number;symbol:string;price:string;currency:string;at:string};
export type DailyClose={id:number;day:string;price:string;currency:string;at:string};

// CMC returns JSON numbers; tiny token prices arrive as 1.23e-7. Write them out in full so they can be stored as exact decimals.
export function decimal(n:number){
 if(!Number.isFinite(n))throw Error('CoinMarketCap returned a price that is not a number');
 const s=String(n);if(!/e/i.test(s))return s;
 const [mantissa,exp]=s.toLowerCase().split('e'),e=Number(exp),digits=(mantissa.split('.')[1]??'').length;
 return e<0?n.toFixed(Math.min(100,digits-e)):BigInt(Math.round(n)).toString();
}

// 1 credit per 250 assets returned, so ask for up to 100 per call to keep URLs short.
export async function latestQuotes(client:CmcClient,ids:number[],currency='USD'):Promise<Map<number,Quote>>{
 const out=new Map<number,Quote>(),unique=[...new Set(ids)];
 for(let i=0;i<unique.length;i+=100){
  const body=await client.get('/v3/cryptocurrency/quotes/latest',{id:unique.slice(i,i+100).join(','),convert:currency,skip_invalid:'true'});
  for(const coin of (body?.data??[]) as any[]){const q=(coin.quote??[]).find((x:any)=>String(x.symbol).toUpperCase()===currency)??coin.quote?.[0];
   if(q&&typeof q.price==='number')out.set(Number(coin.id),{id:Number(coin.id),symbol:coin.symbol,price:decimal(q.price),currency,at:q.last_updated??coin.last_updated})}
 }
 return out;
}

// One close per UTC day. CMC's "daily" interval returns the first quote of each day, so per its docs we ask for the quote nearest
// 23:59 UTC every 24 hours instead. Plans limit how far back daily history goes (Basic: 1 year); older days are clamped, not guessed.
export async function dailyCloses(client:CmcClient,id:number,from:string,to:string,{currency='USD',historyDays,today=new Date().toISOString().slice(0,10)}:{currency?:string;historyDays?:number;today?:string}={}):Promise<{closes:DailyClose[];clampedFrom:string|null}>{
 let start=from,clampedFrom:string|null=null;
 if(historyDays!==undefined){const earliest=new Date(Date.parse(today+'T00:00:00Z')-historyDays*86400000).toISOString().slice(0,10);if(start<earliest){clampedFrom=start;start=earliest}}
 if(start>to)return {closes:[],clampedFrom};
 const days=Math.round((Date.parse(to)-Date.parse(start))/86400000)+1;
 const body=await client.get('/v3/cryptocurrency/quotes/historical',{id,time_start:`${start}T23:59:00.000Z`,count:Math.min(days,10000),interval:'24h',convert:currency});
 const coin=body?.data?.[String(id)]??body?.data;
 const closes=((coin?.quotes??[]) as any[]).map(q=>{const v=q.quote?.[currency];return v&&typeof v.price==='number'?{id,day:String(q.timestamp).slice(0,10),price:decimal(v.price),currency,at:v.timestamp??q.timestamp}:null}).filter((x):x is DailyClose=>x!==null&&x.day<=to);
 return {closes,clampedFrom};
}
