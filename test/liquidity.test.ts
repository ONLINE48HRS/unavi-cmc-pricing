import test from 'node:test';
import assert from 'node:assert/strict';
import {Decimal} from 'decimal.js';
import {assessPosition,classifySecurity,cmcClient,dexPools,holderOverhang,holdersList,jupiterClient,poolKind,QuoteError,sliderQuantities,summarise,v2Out,type Fetcher,type Holder,type Lot,type PositionInput,type RouteVenue,type Security} from '../src/index.ts';

// Synthetic fixtures shaped like the real responses. No recorded CoinMarketCap data is shipped in this repository.
const NOW='2026-11-21T12:00:00.000Z',SOON='2026-11-21T11:59:40.000Z';
const sum=(parts:{value:string}[])=>parts.reduce((s,p)=>s.plus(p.value),new Decimal(0));
const reply=(body:unknown,status=200):Awaited<ReturnType<Fetcher>>=>({ok:status<400,status,headers:{get:()=>null},text:async()=>JSON.stringify(body)});
const clean:Security&{at:string}={class:'no-warnings',sellTax:'0',hits:[],unknown:[],source:'fixture',at:SOON};

test('Jupiter: quote only (no taker), key in the header, calls spaced, and anything but an exact quote is refused',async()=>{
 const seen:{url:URL;headers:any}[]=[],waits:number[]=[];let t=0;
 const client=jupiterClient({apiKey:'jup-key',gapMs:1000,clock:()=>t,pause:async ms=>{waits.push(ms);t+=ms},now:()=>new Date(NOW),
  fetcher:async(url,init)=>{const u=new URL(url);seen.push({url:u,headers:init?.headers});const amount=u.searchParams.get('amount');
   return amount==='7'?reply({errorCode:'COULD_NOT_FIND_ANY_ROUTE',errorMessage:'No route'},400):reply({inAmount:amount==='9'?'8':amount,outAmount:'2149',router:'metis',feeBps:10,requestId:'r1'})}});
 const q=await client.order({inputMint:'Mint111',amount:10000n});
 assert.equal(seen[0].url.origin+seen[0].url.pathname,'https://api.jup.ag/swap/v2/order');assert.equal(seen[0].url.searchParams.get('taker'),null);
 assert.equal(seen[0].headers['x-api-key'],'jup-key');assert.ok(!seen[0].url.href.includes('jup-key'));
 assert.deepEqual([q.outAmount,q.router,q.feeBps,q.at],['2149','metis',10,NOW]);assert.match(client.calls[0].sha256,/^[0-9a-f]{64}$/);
 await client.order({inputMint:'Mint111',amount:5n});assert.deepEqual(waits,[1000],'the second call waits out the rate gap');
 await assert.rejects(client.order({inputMint:'Mint111',amount:7n}),(e:any)=>e instanceof QuoteError&&e.code==='COULD_NOT_FIND_ANY_ROUTE');
 await assert.rejects(client.order({inputMint:'Mint111',amount:9n}),/no usable quote/,'a quote for a different size is never used');
 assert.equal(client.calls.length,4,'failed calls are kept as evidence too');
});

test('CMC: holders list is a POST with a JSON body; pools and holders keep exact decimals and only non-zero tags',async()=>{
 const seen:any[]=[];const client=cmcClient({apiKey:'k',fetcher:async(url,init)=>{seen.push({url,init});
  if(url.includes('/holders/list'))return reply({data:{holders:[{walletAddress:'0xABC',balance:'50162736194264.694',percent:'11.92',publicName:'Binance: Hot Wallet 20',tags:'{"tag_whale":1,"tag_smart_contract":0}'},{walletAddress:'0xdef',balance:'5',tags:'not json'}]},status:{error_code:'0',credit_count:1}});
  return reply({data:[{addr:'0xA43F',exn:'Uniswap v2',fa:'0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',t0:{addr:'0x6982',sym:'PEPE',liq:'3322770618617.173281826976126711',liqUsd:'11897594.25'},t1:{addr:'0xC02a',sym:'WETH',liq:'6775.634320532888593179',liqUsd:'11933378.23'},liqUsd:'23830972.49',v24:'2059033.61'},{addr:'0xbad'}],status:{error_code:'0',credit_count:1}})}});
 const holders=await holdersList(client,'ethereum','0x6982');
 assert.equal(seen[0].init.method,'POST');assert.deepEqual(JSON.parse(seen[0].init.body),{tokenAddress:'0x6982',platform:'ethereum',tag:'tag_all'});assert.equal(client.calls[0].payload,seen[0].init.body);
 assert.deepEqual(holders.map(h=>[h.address,h.balance,h.name,h.tags]),[['0xabc','50162736194264.694','Binance: Hot Wallet 20',['tag_whale']],['0xdef','5',null,[]]]);
 const [pool]=await dexPools(client,'ethereum','0x6982');
 assert.equal(pool.tokens[0].amount,'3322770618617.173281826976126711');assert.equal(pool.factory,'0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f');
 assert.deepEqual(poolKind('ethereum',pool),{kind:'v2',protocol:'uniswap-v2'});
 assert.equal(poolKind('ethereum',{...pool,protocol:'Uniswap v4 (Ethereum)'}),null,'name and factory must agree');
 assert.equal(poolKind('ethereum',{...pool,factory:'0xf4fd2e6c5b60c5b365cd1b96dd6245e6d60414c2'}),null,'an unnamed fork is discovery only');
 assert.deepEqual(poolKind('ethereum',{...pool,protocol:'Uniswap v3 (Ethereum)',factory:'0x1f98431c8ad98523631ae4a59f267346ea31f984'}),{kind:'v3'});
 assert.equal(poolKind('solana',pool),null,'Solana exits come from route quotes, not the pool model');
});

test('security: no record is "not checked", never safe; only a reported honeypot zeroes proceeds; an unstated tax unit is not guessed',()=>{
 const item=(riskCode:string,isHit:boolean,riskyLevel='y')=>({riskCode,isHit,riskyLevel});
 assert.equal(classifySecurity(null).class,'not-checked');
 const pepeLike={tokenContractAddress:'0x6982',extra:{buyTax:'0',sellTax:'0',source:'X'},evmDisplay:{honeypotStatus:'Unknown',rugPullStatus:'Unknown'},securityItems:[item('blacklist_function',true),item('mintable',false,'g')]};
 const s=classifySecurity(pepeLike);
 assert.deepEqual([s.class,s.sellTax,s.hits,s.unknown],['warning','0',[{code:'blacklist_function',level:'y'}],['honeypot','rugPull']]);
 assert.equal(classifySecurity({...pepeLike,evmDisplay:{honeypotStatus:'Yes'}}).class,'cannot-sell');
 assert.equal(classifySecurity({...pepeLike,extra:{sellTax:'5'}}).class,'tax-unverified','5 could mean 5% or 500%; CMC does not say');
 assert.deepEqual(classifySecurity({...pepeLike,extra:undefined}).unknown.at(-1),'sellTax');
 assert.deepEqual([classifySecurity({...pepeLike,extra:{sellTax:'5'}},{verifiedSellTax:'0.05'}).sellTax],['0.05']);
 assert.equal(classifySecurity({...pepeLike,securityItems:[]}).class,'no-warnings');
});

test('holder overhang counts the top 10 real holders, leaving out pools, burn, exchange and locker wallets with reasons',()=>{
 const h=(address:string,balance:string,name:string|null=null,tags:string[]=[]):Holder=>({address,balance,percent:null,name,tags});
 const holders=[h('0xpool','900'),h('0xlp','800',null,['tag_lp_contract']),h('0x000000000000000000000000000000000000dead','700'),h('0xex','600','Binance: Hot Wallet 20'),h('0xau','550','CoinSpot 1'),h('0xlock','500','Team Finance Lock'),
  ...Array.from({length:12},(_,i)=>h('0xw'+i,String(100-i),i===0?'Jupiter Team Cold Wallet':null))];
 const o=holderOverhang(holders,{pools:new Set(['0xpool'])});
 assert.deepEqual(o.excluded.map(e=>e.reason),['lp','lp','burn','exchange','exchange','locker']);
 assert.equal(o.counted.length,10);assert.equal(o.counted[0].name,'Jupiter Team Cold Wallet','team wallets are real sellers and stay in');
 assert.equal(o.tokens,String(Array.from({length:10},(_,i)=>100-i).reduce((a,b)=>a+b)));
});

const lots:Lot[]=[{id:'l1',acquiredAt:'2025-02-01',quantity:'4000',cost:'2000'},{id:'l2',acquiredAt:'2025-08-01',quantity:'6000',cost:'5000'}];
const route=(quotes:Record<string,{out:string;at:string}|{error:string;at:string}>,reference:{quantity:string;out:string}|null={quantity:'10',out:'9.9'}):RouteVenue=>({kind:'route',id:'jupiter:TKN',source:'jupiter',output:{symbol:'USDC',price:'1'},reference,quotes});
const base=(over:Partial<PositionInput>={}):PositionInput=>({symbol:'TKN',quantity:'10000',now:NOW,mark:{price:'1',at:SOON,source:'CMC'},security:clean,venues:[route({'10000':{out:'8500',at:SOON}})],lots,...over});

test('the headline case: marked $10,000 on a $7,000 basis, $8,500 after a realistic exit: half the gain is not there',()=>{
 const r=assessPosition(base());
 assert.deepEqual([r.state,r.method,r.mark,r.proceeds,r.gains!.basis,r.gains!.markedGain,r.gains!.adjustedGain],['assessed','route-quote','10000','8500','7000','3000','1500']);
 assert.equal(sum(r.bridge!.parts).toFixed(),'1500','the bridge explains every dollar between mark and proceeds');
 assert.deepEqual(r.bridge!.parts.map(p=>[p.name,p.value]),[['reference','100'],['route','1400']],'a route shows one route cost, never a fee and an impact it cannot separate');
 assert.ok(r.conditions.some(c=>/Jupiter reports no slot/.test(c)));
});

test('not assessed means excluded, never zero: unpriced, stale, unchecked security, failed or missing quotes',()=>{
 assert.deepEqual([assessPosition(base({mark:null})).state,assessPosition(base({mark:null})).proceeds],['not-assessed',null]);
 assert.deepEqual(assessPosition(base({mark:{price:'1',at:'2026-11-21T11:40:00Z',source:'CMC'}})).reasons,['price stale']);
 const unchecked=assessPosition(base({security:{...classifySecurity(null),at:SOON}}));assert.deepEqual([unchecked.state,unchecked.proceeds,unchecked.reasons],['not-assessed',null,['security not checked']]);
 const failed=assessPosition(base({venues:[route({'10000':{error:'No route',at:SOON}})]}));assert.deepEqual([failed.state,failed.reasons],['not-assessed',['jupiter:TKN: quote failed: No route']]);
 assert.match(assessPosition(base({venues:[route({'5000':{out:'4400',at:SOON}})]})).reasons[0],/no quote for this size/,'a quote is never reused for another size');
 assert.match(assessPosition(base({venues:[route({'10000':{out:'8500',at:'2026-11-21T11:58:00Z'}})]})).reasons[0],/stale/);
 const listed=assessPosition(base({venues:[],volume24hUsd:'2000000'}));
 assert.deepEqual([listed.state,listed.proceeds,listed.timeToSell!.map(t=>t.days)],['indicative',null,['0.5','0.1','0.05','0.033333333333333333333']],'exchange-only: a time-to-sell warning, no proceeds');
 const tax=assessPosition(base({security:{...clean,class:'tax-unverified',sellTax:null}}));assert.equal(tax.state,'not-assessed');
});

test('a reported honeypot is assessed at zero, with the whole mark explained as blocked',()=>{
 const r=assessPosition(base({security:{...clean,class:'cannot-sell'}}));
 assert.deepEqual([r.state,r.proceeds,r.gains!.adjustedGain],['assessed','0','-7000']);assert.equal(sum(r.bridge!.parts).toFixed(),r.mark);
});

test('the best single venue wins; unconfirmed pools and routes on taxed tokens are skipped with reasons',()=>{
 const pool={kind:'pool' as const,id:'uniswap-v2:0xpair',pool:{protocol:'uniswap-v2',reserveToken:'200000',reserveQuote:'200000',block:1,at:SOON},output:{symbol:'USDC',price:'1'},confirmed:true};
 const r=assessPosition(base({venues:[pool,route({'10000':{out:'8500',at:SOON}})]}));
 assert.equal(r.venue,'uniswap-v2:0xpair');assert.equal(r.proceeds,v2Out(pool.pool,'10000').toFixed());
 assert.equal(sum(r.bridge!.parts).toFixed(),new Decimal(r.mark!).minus(r.proceeds!).toFixed(),'pool bridge parts add up exactly');
 assert.deepEqual(r.bridge!.parts.map(p=>p.name),['reference','tax','fee','impact']);
 assert.equal(assessPosition(base({venues:[{...pool,confirmed:false}]})).reasons[0],'uniswap-v2:0xpair: reserves not confirmed on-chain');
 const taxed=assessPosition(base({security:{...clean,sellTax:'0.05'},venues:[pool,route({'10000':{out:'8500',at:SOON}})]}));
 assert.equal(taxed.proceeds,v2Out(pool.pool,'10000','0.05').toFixed());assert.ok(taxed.reasons.some(x=>/do not apply the token transfer tax/.test(x)));
 assert.equal(new Decimal(taxed.bridge!.parts.find(p=>p.name==='tax')!.value).toFixed(),'500','5% of 10,000 tokens at the pool spot of $1');
});

test('slider: proceeds per token fall with size, the bridge always closes, and cost basis follows the FIFO lots consumed',()=>{
 const pool={kind:'pool' as const,id:'p',pool:{protocol:'uniswap-v2',reserveToken:'50000',reserveQuote:'50000',at:SOON},output:{symbol:'USDC',price:'1'},confirmed:true};
 const sizes=sliderQuantities('10000',6);assert.deepEqual(sizes,['1000','2500','5000','10000']);assert.deepEqual(sliderQuantities('1.0000009',6,['0.5']),['0.5']);
 let last=Infinity;
 for(const q of sizes){const r=assessPosition(base({quantity:q,venues:[pool]}));const perToken=new Decimal(r.proceeds!).div(q).toNumber();assert.ok(perToken<last);last=perToken;
  assert.equal(sum(r.bridge!.parts).toFixed(),new Decimal(r.mark!).minus(r.proceeds!).toFixed())}
 assert.deepEqual(assessPosition(base({quantity:'2500',venues:[pool]})).gains!.slices.map(s=>[s.id,s.quantity,s.cost]),[['l1','2500','1250']]);
 assert.deepEqual(assessPosition(base({quantity:'5000',venues:[pool]})).gains!.slices.map(s=>[s.id,s.quantity]),[['l1','4000'],['l2','1000']]);
});

test('overhang: the exit is repriced after the largest holders sell first; exact for a pool, from sized quotes for a route',()=>{
 const pool={kind:'pool' as const,id:'p',pool:{protocol:'uniswap-v2',reserveToken:'50000',reserveQuote:'50000',at:SOON},output:{symbol:'USDC',price:'1'},confirmed:true};
 const r=assessPosition(base({venues:[pool],overhang:{tokens:'40000',liquidityUsd:'100000'}}));
 const expected=v2Out(pool.pool,'50000').minus(v2Out(pool.pool,'40000'));
 assert.equal(r.overhang!.proceedsAfter,expected.toFixed());assert.ok(expected.lt(r.proceeds!));assert.equal(r.overhang!.depthMultiple,'0.4');
 const q=assessPosition(base({venues:[route({'10000':{out:'8500',at:SOON},'40000':{out:'30000',at:SOON},'50000':{out:'35000',at:SOON}})],overhang:{tokens:'40000',liquidityUsd:null}}));
 assert.equal(q.overhang!.proceedsAfter,'5000');
 assert.equal(assessPosition(base({overhang:{tokens:'40000',liquidityUsd:null}})).overhang!.note,'no fresh quotes at the overhang sizes');
 const odd=assessPosition(base({venues:[route({'10000':{out:'8500',at:SOON},'40000':{out:'30000',at:SOON},'50000':{out:'29000',at:SOON}})],overhang:{tokens:'40000',liquidityUsd:null}}));
 assert.deepEqual([odd.overhang!.proceedsAfter,odd.overhang!.note],[null,'route quotes at the overhang sizes are inconsistent'],'two independent router quotes cannot show a negative sale');
});

test('portfolio: totals reconcile to the crypto mark, shared venues are not summed, and net worth is never changed',()=>{
 const a=assessPosition(base()),b=assessPosition({...base(),symbol:'TKN2'}),c=assessPosition(base({symbol:'BTC',venues:[],volume24hUsd:'1000000000'})),d=assessPosition(base({symbol:'X',mark:null}));
 const s=summarise([a,c,d],{netWorth:'150000'});
 assert.equal(new Decimal(s.assessedMark).plus(s.indicativeMark).plus(s.notAssessedMark).toFixed(),s.cryptoMark);
 assert.deepEqual([s.assessedMark,s.proceeds,s.difference,s.markedGain,s.adjustedGain,s.netWorth,s.differenceShareOfNetWorth,s.unpriced],['10000','8500','1500','3000','1500','150000','0.01',1]);
 const both=summarise([a,b]);assert.deepEqual([both.assessedMark,both.notAssessedMark,both.overlaps],['0','20000',[{venue:'jupiter:TKN',symbols:['TKN','TKN2']}]]);
});

test('cache: repeats inside the freshness window cost nothing; failures and unlisted endpoints are never kept',async()=>{
 const {cachedClient,securityDetail}=await import('../src/index.ts');
 let calls=0,fail=false,t=0;const base=cmcClient({apiKey:'k',fetcher:async()=>{calls++;return fail?reply({status:{error_code:500,error_message:'down'}},500):reply({data:[{tokenContractAddress:'0xAB',extra:{sellTax:'0'}}],status:{error_code:'0',credit_count:1,timestamp:'2026-11-21T08:00:00.000Z'}})}});
 const client=cachedClient(base,{clock:()=>t});
 const first=await securityDetail(client,'ethereum','0xab');await securityDetail(client,'ethereum','0xab');
 assert.equal(calls,1);assert.equal(first.fetchedAt,'2026-11-21T08:00:00.000Z','the record keeps CMC\'s own time, not the time it was served');
 t=24*3_600_000;await securityDetail(client,'ethereum','0xab');assert.equal(calls,2,'refetched once its 24 hours are up');
 await client.get('/v1/key/info');await client.get('/v1/key/info');assert.equal(calls,4,'endpoints without a rule are not cached');
 fail=true;await assert.rejects(client.get('/v1/dex/token/price',{platform:'ethereum',address:'0x1'}));fail=false;
 await client.get('/v1/dex/token/price',{platform:'ethereum',address:'0x1'});assert.equal(calls,6,'a failure is retried, not served from the cache');
});
