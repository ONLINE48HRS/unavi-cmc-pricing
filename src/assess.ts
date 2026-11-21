import {Decimal} from 'decimal.js';
import {gains,type Lot} from './lots.ts';
import {routeBridge,v2Bridge,v2Out,type Bridge,type PoolState} from './pool-model.ts';
import type {Security} from './security.ts';

// Assessment of one position from data already fetched: pure, so every rule below is tested on fixtures. Estimates are
// reports only; nothing here changes a mark, a ledger entry or net worth.
export type State='assessed'|'indicative'|'not-assessed';
export const FRESH_MS={price:15*60_000,route:60_000,pool:5*60_000,security:24*3_600_000};
export const PARTICIPATION=['0.01','0.05','0.1','0.15'];

export type Output={symbol:string;price:string};
// A constant-product pool whose reserves were read on-chain. confirmed: its factory and CMC's amounts matched the chain.
export type PoolVenue={kind:'pool';id:string;pool:PoolState;output:Output;confirmed:boolean};
// A router or aggregator quote, fetched for exact sizes. A quote is used only for the size it was asked for.
export type RouteQuote={out:string;at:string}|{error:string;at:string};
export type RouteVenue={kind:'route';id:string;source:'jupiter'|'uniswap-v3';output:Output;reference:{quantity:string;out:string}|null;quotes:Record<string,RouteQuote>};
export type Venue=PoolVenue|RouteVenue;

export type PositionInput={
 symbol:string;quantity:string;now:string;
 mark:{price:string;at:string;source:string}|null;
 security:Security&{at:string};
 venues:Venue[];lots?:Lot[];
 volume24hUsd?:string|null;
 // Tokens held by the largest wallets (see overhang.ts) and the token's total DEX liquidity in USD.
 overhang?:{tokens:string;liquidityUsd:string|null};
};

const key=(q:string|Decimal)=>new Decimal(q).toFixed();
const age=(now:string,at:string)=>Date.parse(now)-Date.parse(at);

type Candidate={venue:Venue;out:Decimal;proceeds:Decimal}|{venue:Venue;skipped:string};
function evaluate(v:Venue,quantity:string,now:string,tax:string):Candidate{
 if(v.kind==='pool'){
  if(!v.confirmed)return {venue:v,skipped:'reserves not confirmed on-chain'};
  if(age(now,v.pool.at)>FRESH_MS.pool)return {venue:v,skipped:'pool snapshot stale'};
  const out=v2Out(v.pool,quantity,tax);return {venue:v,out,proceeds:out.mul(v.output.price)};
 }
 if(new Decimal(tax).gt(0))return {venue:v,skipped:'route quotes do not apply the token transfer tax'};
 const q=v.quotes[key(quantity)];if(!q)return {venue:v,skipped:'no quote for this size'};
 if('error' in q)return {venue:v,skipped:`quote failed: ${q.error}`};
 if(age(now,q.at)>FRESH_MS.route)return {venue:v,skipped:'route quote stale'};
 const out=new Decimal(q.out);return {venue:v,out,proceeds:out.mul(v.output.price)};
}

function bridgeFor(v:Venue,quantity:string,markPrice:string,tax:string,out:Decimal):Bridge{
 if(v.kind==='pool')return v2Bridge(v.pool,quantity,{markPrice,quotePrice:v.output.price,tax});
 const ref=v.reference&&new Decimal(v.reference.quantity).gt(0)?new Decimal(v.reference.out).div(v.reference.quantity).toFixed():null;
 return routeBridge(quantity,{markPrice,quotePrice:v.output.price,proceedsOut:out.toFixed(),referenceOutPerToken:ref});
}

// Days to sell at a share of market-wide 24h volume. Volume is not depth, so this is a warning, never a proceeds figure.
export function timeToSell(valueUsd:string,volume24hUsd:string|null|undefined){
 if(!volume24hUsd||new Decimal(volume24hUsd).lte(0))return null;
 return PARTICIPATION.map(p=>({participation:p,days:new Decimal(valueUsd).div(new Decimal(volume24hUsd).mul(p)).toFixed()}));
}

export function assessPosition(input:PositionInput){
 const {quantity,now,mark,security}=input,reasons:string[]=[],conditions:string[]=[];
 const base={symbol:input.symbol,quantity,mark:mark?new Decimal(quantity).mul(mark.price).toFixed():null};
 const none=(state:State,extra:object={})=>({...base,state,method:null,venue:null,proceeds:null,bridge:null,gains:null,overhang:null,reasons,conditions,timeToSell:mark?timeToSell(base.mark!,input.volume24hUsd):null,...extra});
 if(!mark){reasons.push('unpriced');return none('not-assessed')}
 if(age(now,mark.at)>FRESH_MS.price){reasons.push('price stale');return none('not-assessed')}
 // Exchange-listed holdings without a usable on-chain exit keep their mark and a time-to-sell warning, outside the assessed total.
 const fallback=()=>none(input.volume24hUsd&&new Decimal(input.volume24hUsd).gt(0)?'indicative':'not-assessed');
 if(!input.venues.length){reasons.push('no on-chain venue');return fallback()}
 if(security.class==='not-checked'){reasons.push('security not checked');return fallback()}
 if(age(now,security.at)>FRESH_MS.security){reasons.push('security data stale');return fallback()}
 for(const h of security.hits)conditions.push(`reported risk: ${h.code}`);
 for(const u of security.unknown)conditions.push(`${u} not checked by the source`);
 if(security.class==='cannot-sell'){
  const value=base.mark!;
  return {...none('assessed'),method:'blocked' as const,proceeds:'0',bridge:{mark:value,proceeds:'0',parts:[{name:'blocked' as const,value}]},gains:input.lots?gains({lots:input.lots,quantity,markPrice:mark.price,proceeds:'0'}):null,reasons:['honeypot reported: the token cannot be sold']};
 }
 if(security.class==='tax-unverified'){reasons.push('sell tax reported without a stated unit; supply a verified rate');return fallback()}
 const tax=security.sellTax??'0',candidates=input.venues.map(v=>evaluate(v,quantity,now,tax));
 for(const c of candidates)if('skipped' in c)reasons.push(`${c.venue.id}: ${c.skipped}`);
 // The seller uses the single venue that pays most. Venues are never combined: a split across pools is not quoted here.
 const best=candidates.filter((c):c is Extract<Candidate,{proceeds:Decimal}>=>'proceeds' in c).sort((a,b)=>b.proceeds.cmp(a.proceeds))[0];
 if(!best)return fallback();
 const v=best.venue;
 conditions.push(v.kind==='pool'?`${v.pool.protocol} pool model, reserves at block ${v.pool.block??'unknown'}`:v.source==='jupiter'?`Jupiter route quote received ${(v.quotes[key(quantity)] as {at:string}).at}; Jupiter reports no slot`:'one Uniswap v3 pool quoted on its own');
 return {...none('assessed'),method:v.kind==='pool'?'pool-model' as const:'route-quote' as const,venue:v.id,proceeds:best.proceeds.toFixed(),
  bridge:bridgeFor(v,quantity,mark.price,tax,best.out),
  gains:input.lots?gains({lots:input.lots,quantity,markPrice:mark.price,proceeds:best.proceeds.toFixed()}):null,
  overhang:input.overhang?overhangExit(v,quantity,input.overhang,mark.price,tax,now,best.proceeds):null};
}

// If the largest holders sold first: the user's sale is priced on what is left. For a pool this is exact
// (out(H+q) − out(H)); for a route it uses quotes fetched at H and H+q. A router prices each size afresh, not as a sale in
// sequence, so a difference below zero or above the unstressed proceeds is inconsistent and is not shown.
function overhangExit(v:Venue,quantity:string,o:{tokens:string;liquidityUsd:string|null},markPrice:string,tax:string,now:string,unstressed:Decimal){
 const h=new Decimal(o.tokens),valueAtMark=h.mul(markPrice).toFixed(),depthMultiple=o.liquidityUsd&&new Decimal(o.liquidityUsd).gt(0)?h.mul(markPrice).div(o.liquidityUsd).toFixed():null;
 if(h.isZero())return {tokens:o.tokens,valueAtMark,depthMultiple,proceedsAfter:null,note:'no counted holders'};
 let after:Decimal|null=null,note:string|null=null;
 if(v.kind==='pool')after=v2Out(v.pool,h.plus(quantity).toFixed(),tax).minus(v2Out(v.pool,o.tokens,tax)).mul(v.output.price);
 else{const a=v.quotes[key(h)],b=v.quotes[key(h.plus(quantity))];
  if(a&&b&&'out' in a&&'out' in b&&age(now,a.at)<=FRESH_MS.route&&age(now,b.at)<=FRESH_MS.route){after=new Decimal(b.out).minus(a.out).mul(v.output.price);if(after.isNeg()||after.gt(unstressed)){after=null;note='route quotes at the overhang sizes are inconsistent'}}else note='no fresh quotes at the overhang sizes'}
 return {tokens:o.tokens,valueAtMark,depthMultiple,proceedsAfter:after?.toFixed()??null,note};
}

// Slider sizes as exact token amounts, floored to the token's decimals so a quote can be fetched for exactly that size.
export function sliderQuantities(quantity:string,decimals:number,fractions=['0.1','0.25','0.5','1']){
 return fractions.map(f=>new Decimal(quantity).mul(f).toDecimalPlaces(decimals,Decimal.ROUND_DOWN).toFixed()).filter(q=>new Decimal(q).gt(0));
}

export type Assessment=ReturnType<typeof assessPosition>;

// Portfolio totals. Assessed + indicative + not-assessed marks = the crypto mark. Positions whose best exit is the same venue
// would be selling into each other, so they are moved out of the assessed total rather than summed as separate sales.
// Accounting net worth is passed through unchanged: the difference is shown beside it, never subtracted from it.
export function summarise(rows:Assessment[],{netWorth}:{netWorth?:string}={}){
 const byVenue=new Map<string,number>();for(const r of rows)if(r.state==='assessed'&&r.venue)byVenue.set(r.venue,(byVenue.get(r.venue)??0)+1);
 const shared=new Set([...byVenue].filter(([,n])=>n>1).map(([v])=>v));
 const sum=(xs:(string|null)[])=>xs.reduce((s,x)=>s.plus(x??0),new Decimal(0));
 const assessed=rows.filter(r=>r.state==='assessed'&&!(r.venue&&shared.has(r.venue))),overlapping=rows.filter(r=>r.venue&&shared.has(r.venue));
 const assessedMark=sum(assessed.map(r=>r.mark)),proceeds=sum(assessed.map(r=>r.proceeds)),difference=assessedMark.minus(proceeds);
 const withGains=assessed.filter(r=>r.gains?.markedGain!=null&&r.gains?.adjustedGain!=null);
 return {
  cryptoMark:sum(rows.map(r=>r.mark)).toFixed(),assessedMark:assessedMark.toFixed(),proceeds:proceeds.toFixed(),difference:difference.toFixed(),
  indicativeMark:sum(rows.filter(r=>r.state==='indicative').map(r=>r.mark)).toFixed(),
  notAssessedMark:sum([...rows.filter(r=>r.state==='not-assessed'),...overlapping].map(r=>r.mark)).toFixed(),
  unpriced:rows.filter(r=>r.mark===null).length,overlaps:[...shared].map(v=>({venue:v,symbols:overlapping.filter(r=>r.venue===v).map(r=>r.symbol)})),
  markedGain:withGains.length?sum(withGains.map(r=>r.gains!.markedGain)).toFixed():null,adjustedGain:withGains.length?sum(withGains.map(r=>r.gains!.adjustedGain)).toFixed():null,
  netWorth:netWorth??null,differenceShareOfNetWorth:netWorth&&new Decimal(netWorth).gt(0)?difference.div(netWorth).toFixed():null};
}
