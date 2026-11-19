// Prices a list of holdings: Binance spot prices first (free, no key), CoinMarketCap for everything Binance does not list.
// Usage: CMC_API_KEY=... npm run demo -- [holdings.json]   (without a key it uses CMC's keyless public API)
// Writes every CoinMarketCap request and response to evidence/ so each price can be traced to a real API call.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {cmcClient,priceHoldings,type Holding} from '../src/index.ts';

const file=process.argv[2]??new URL('./example-holdings.json',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1');
const holdings:Holding[]=JSON.parse(await readFile(file,'utf8'));

const tickers=await fetch('https://api.binance.com/api/v3/ticker/price').then(r=>r.ok?r.json():[]).catch(()=>[]) as {symbol:string;price:string}[];
const binance=new Map(tickers.map(t=>[t.symbol,t.price.replace(/0+$/,'').replace(/\.$/,'')]));
// Binance quotes against USDT; treated as USD here, as UNAVI's primary source does for crypto marks.
const primary=({symbol}:{symbol:string})=>['USDT','USDC'].includes(symbol)?'1':binance.get(symbol.toUpperCase()+'USDT');

const client=cmcClient({apiKey:process.env.CMC_API_KEY});
const rows=await priceHoldings(client,holdings,primary);

const pad=(s:string,n:number)=>s.length>=n?s.slice(0,n):s+' '.repeat(n-s.length);
console.log(pad('Token',8),pad('Amount',16),pad('Price (USD)',18),pad('Value (USD)',18),'Source');
for(const r of rows)console.log(pad(r.symbol,8),pad(r.amount,16),pad(r.price??'—',18),pad(r.value??'—',18),r.source==='coinmarketcap'?`CoinMarketCap #${r.cmc!.id} (${r.cmc!.by})`:r.source==='primary'?'Binance':'unpriced',r.note?`\n${' '.repeat(9)}${r.note}`:'');
const filled=rows.filter(r=>r.source==='coinmarketcap').length,missing=rows.filter(r=>!r.price).length;
console.log(`\n${rows.length-filled-missing} priced by Binance, ${filled} filled by CoinMarketCap, ${missing} unpriced. CoinMarketCap: ${client.calls.length} calls, ${client.credits()} credits.`);

await mkdir('evidence',{recursive:true});
const out=`evidence/run-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
await writeFile(out,JSON.stringify({ranAt:new Date().toISOString(),keyless:!process.env.CMC_API_KEY,holdings,rows,calls:client.calls.map(c=>({...c,body:JSON.parse(c.body)}))},null,1));
console.log(`Requests and responses saved to ${out} (the API key is never written).`);
