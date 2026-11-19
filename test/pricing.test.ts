import test from 'node:test';
import assert from 'node:assert/strict';
import {cmcClient,CmcError,dailyCloses,decimal,latestQuotes,multiply,priceHoldings,resolver,type Fetcher} from '../src/index.ts';

type Route=(url:URL)=>{status?:number;body:any;headers?:Record<string,string>};
const fake=(route:Route)=>{const seen:URL[]=[];const fetcher:Fetcher=async(url,init)=>{const u=new URL(url);seen.push(u);(u as any).headers=init?.headers;const r=route(u);return {ok:(r.status??200)<400,status:r.status??200,headers:{get:(n:string)=>r.headers?.[n.toLowerCase()]??null},text:async()=>JSON.stringify(r.body)}};return {fetcher,seen}};
const ok=(data:any,credits=1)=>({body:{data,status:{error_code:0,error_message:null,credit_count:credits}}});

test('the key goes in the header, never the URL; without a key the keyless public API is used',async()=>{
 const keyed=fake(()=>ok([])),client=cmcClient({apiKey:'secret-key',fetcher:keyed.fetcher});await client.get('/v1/cryptocurrency/map',{symbol:'BTC'});
 assert.equal(keyed.seen[0].origin+keyed.seen[0].pathname,'https://pro-api.coinmarketcap.com/v1/cryptocurrency/map');assert.ok(!keyed.seen[0].href.includes('secret-key'));assert.equal((keyed.seen[0] as any).headers['X-CMC_PRO_API_KEY'],'secret-key');
 const open=fake(()=>ok([]));await cmcClient({fetcher:open.fetcher}).get('/v1/cryptocurrency/map');assert.equal(open.seen[0].pathname,'/public-api/v1/cryptocurrency/map');assert.equal((open.seen[0] as any).headers['X-CMC_PRO_API_KEY'],undefined);
});

test('every call is recorded with its cost and a hash of the response; errors and rate limits are handled',async()=>{
 let n=0;const waits:number[]=[];const f=fake(()=>++n===1?{status:429,headers:{'retry-after':'2'},body:{status:{error_code:1008,error_message:'rate limit'}}}:ok({ok:true},3));
 const client=cmcClient({apiKey:'k',fetcher:f.fetcher,pause:async ms=>{waits.push(ms)}});await client.get('/v1/key/info');
 assert.deepEqual(waits,[2000],'waits as long as CMC asks');assert.equal(client.calls.length,2);assert.equal(client.credits(),3);assert.match(client.calls[1].sha256,/^[0-9a-f]{64}$/);
 const bad=cmcClient({apiKey:'k',fetcher:fake(()=>({status:401,body:{status:{error_code:1001,error_message:'This API Key is invalid.'}}})).fetcher});
 await assert.rejects(bad.get('/v1/key/info'),(e:any)=>e instanceof CmcError&&e.status===401&&e.code===1001&&/invalid/.test(e.message));
});

test('tokens resolve by contract or mint address first; symbol-only lookups pick the top-ranked listing and say so',async()=>{
 const f=fake(u=>{
  if(u.pathname.endsWith('/v2/cryptocurrency/info')){const a=u.searchParams.get('address');
   if(a==='0x6982508145454ce325ddbe47a25d4ec3d2311933')return ok({'24478':{id:24478,symbol:'PEPE',name:'Pepe',slug:'pepe',platform:{token_address:'0x6982508145454Ce325dDbE47a25d4ec3d2311933'}}});
   if(a==='JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN')return ok({'29210':{id:29210,symbol:'JUP',name:'Jupiter',slug:'jupiter-ag',platform:{token_address:'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'}}});
   return {status:400,body:{status:{error_code:400,error_message:'Invalid value for "address"'}}}}
  if(u.pathname.endsWith('/v1/cryptocurrency/map'))return ok(u.searchParams.get('symbol')==='PEPE'?[{id:99999,symbol:'PEPE',name:'Pepe Copy',slug:'pepe-copy',rank:4100,is_active:1},{id:24478,symbol:'PEPE',name:'Pepe',slug:'pepe',rank:30,is_active:1}]:[]);
  throw Error('unexpected '+u.pathname)});
 const resolve=resolver(cmcClient({apiKey:'k',fetcher:f.fetcher}));
 assert.deepEqual(await resolve({symbol:'PEPE',address:'0x6982508145454CE325DDBE47A25D4EC3D2311933'}),{id:24478,symbol:'PEPE',name:'Pepe',slug:'pepe',by:'address',ambiguous:false},'EVM addresses match case-insensitively');
 assert.equal((await resolve({symbol:'JUP',address:'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'}))?.id,29210,'Solana mints match exactly');
 assert.deepEqual(await resolve({symbol:'pepe'}),{id:24478,symbol:'PEPE',name:'Pepe',slug:'pepe',by:'symbol',ambiguous:true});
 assert.equal(await resolve({symbol:'X',address:'NotARealMint111111111111111111111'}),null,'unknown addresses are not listed, not an error');
 const before=f.seen.length;await resolve({symbol:'PEPE'});assert.equal(f.seen.length,before,'answers are cached');
});

test('latest quotes are batched and tiny prices are written out in full',async()=>{
 const f=fake(u=>{const ids=u.searchParams.get('id')!.split(',');return ok(ids.map(id=>({id:Number(id),symbol:'T'+id,quote:[{symbol:'USD',price:id==='1'?0.000000123:1.5,last_updated:'2026-11-18T10:00:00.000Z'}]})))});
 const q=await latestQuotes(cmcClient({apiKey:'k',fetcher:f.fetcher}),Array.from({length:150},(_,i)=>i+1));
 assert.equal(f.seen.length,2,'150 assets in two calls');assert.equal(q.get(1)!.price,'0.000000123');assert.equal(q.get(2)!.price,'1.5');
 assert.equal(decimal(1e-10),'0.0000000001');assert.equal(decimal(2.5e21),'2500000000000000000000');assert.throws(()=>decimal(NaN));
});

test('daily closes ask for the 23:59 UTC quote and clamp to the plan history instead of guessing',async()=>{
 const f=fake(u=>{assert.equal(u.searchParams.get('interval'),'24h');assert.match(u.searchParams.get('time_start')!,/T23:59:00\.000Z$/);
  return ok({'29210':{id:29210,quotes:[{timestamp:'2026-11-16T23:59:00.000Z',quote:{USD:{price:0.81,timestamp:'2026-11-16T23:55:00.000Z'}}},{timestamp:'2026-11-17T23:59:00.000Z',quote:{USD:{price:0.79,timestamp:'2026-11-17T23:56:00.000Z'}}}]}})});
 const r=await dailyCloses(cmcClient({apiKey:'k',fetcher:f.fetcher}),29210,'2025-01-10','2026-11-17',{historyDays:365,today:'2026-11-18'});
 assert.equal(r.clampedFrom,'2025-01-10');assert.equal(f.seen[0].searchParams.get('time_start'),'2025-11-18T23:59:00.000Z','Basic plan: one year back');
 assert.deepEqual(r.closes.map(c=>[c.day,c.price]),[['2026-11-16','0.81'],['2026-11-17','0.79']]);
});

test('a wallet is priced by the primary source first; CoinMarketCap fills only the gaps, in one quote call',async()=>{
 const f=fake(u=>{
  if(u.pathname.endsWith('/v2/cryptocurrency/info'))return u.searchParams.get('address')==='JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'?ok({'29210':{id:29210,symbol:'JUP',name:'Jupiter',slug:'jupiter-ag',platform:{token_address:'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'}}}):{status:400,body:{status:{error_code:400,error_message:'Invalid value for "address"'}}};
  if(u.pathname.endsWith('/v1/cryptocurrency/map'))return ok([{id:28752,symbol:'WIF',name:'dogwifhat',slug:'dogwifhat',rank:60,is_active:1}]);
  if(u.pathname.endsWith('/v3/cryptocurrency/quotes/latest'))return ok(u.searchParams.get('id')!.split(',').map(id=>({id:Number(id),symbol:'?',quote:[{symbol:'USD',price:id==='29210'?0.8:1.25,last_updated:'2026-11-18T10:00:00.000Z'}]})));
  throw Error('unexpected '+u.pathname)});
 const client=cmcClient({apiKey:'k',fetcher:f.fetcher});
 const rows=await priceHoldings(client,[{symbol:'SOL',amount:'2.5'},{symbol:'JUP',address:'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',amount:'1000'},{symbol:'WIF',amount:'40.5'},{symbol:'RUG',address:'NotARealMint111111111111111111111',amount:'1'}],a=>a.symbol==='SOL'?'180.12':undefined);
 assert.deepEqual(rows.map(r=>[r.symbol,r.source,r.price,r.value]),[['SOL','primary','180.12','450.3'],['JUP','coinmarketcap','0.8','800'],['WIF','coinmarketcap','1.25','50.625'],['RUG',null,null,null]]);
 assert.match(rows[2].note!,/symbol only/);assert.equal(rows[3].note,'Not listed on CoinMarketCap');
 assert.equal(f.seen.filter(u=>u.pathname.endsWith('/quotes/latest')).length,1,'one batched quote call');assert.ok(!f.seen.some(u=>u.searchParams.get('symbol')==='SOL'),'nothing is asked about tokens the primary source priced');
 assert.equal(multiply('0.1','0.2'),'0.02');assert.equal(multiply('-3','1.5'),'-4.5');
});
