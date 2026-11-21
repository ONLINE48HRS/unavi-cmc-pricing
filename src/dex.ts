import type {CmcClient} from './client.ts';
import {decimal} from './prices.ts';

// CMC's DEX endpoints, keyed by platform name and token address. All of them work on the free Basic plan (measured: 1 credit
// per call). Numbers arrive as JSON numbers or strings; both are kept as exact decimal strings.
export type Chain='ethereum'|'solana';
const exact=(v:unknown)=>typeof v==='number'?decimal(v):typeof v==='string'&&v!==''&&Number.isFinite(Number(v))?v:null;
const evm=(a:string)=>a.startsWith('0x')?a.toLowerCase():a;

export type DexPrice={price:string;liquidityUsd:string|null;volume24hUsd:string|null;at:string|null};
export async function dexPrice(client:CmcClient,chain:Chain,address:string):Promise<DexPrice|null>{
 const d=(await client.get('/v1/dex/token/price',{platform:chain,address}))?.data,price=exact(d?.p);if(!price||Number(price)<=0)return null;
 return {price,liquidityUsd:exact(d.l),volume24hUsd:exact(d.v24h),at:d.ts?new Date(Number(d.ts)).toISOString():null};
}

export type PoolSide={address:string;symbol:string;amount:string|null;usd:string|null};
export type Pool={address:string;protocol:string|null;factory:string|null;tokens:[PoolSide,PoolSide];liquidityUsd:string|null;volume24hUsd:string|null};
export async function dexPools(client:CmcClient,chain:Chain,address:string,size=10):Promise<Pool[]>{
 const rows=(await client.get('/v1/dex/token/pools',{platform:chain,address,size}))?.data;
 const side=(t:any):PoolSide=>({address:evm(String(t?.addr??'')),symbol:String(t?.sym??''),amount:exact(t?.liq),usd:exact(t?.liqUsd)});
 return (Array.isArray(rows)?rows:[]).filter(p=>p?.addr&&p.t0&&p.t1).map(p=>({address:evm(p.addr),protocol:p.exn??null,factory:p.fa?evm(p.fa):null,tokens:[side(p.t0),side(p.t1)],liquidityUsd:exact(p.liqUsd),volume24hUsd:exact(p.v24)}));
}

// Only these deployments are modelled. CMC's protocol name and factory must agree, and the factory is read again on-chain
// before a pool is used. Anything else (Uniswap v4, unnamed forks) is discovery only.
export const ETHEREUM_V2:Record<string,{protocol:string;name:RegExp}>={
 '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f':{protocol:'uniswap-v2',name:/^uniswap v2\b/i},
 '0xc0aee478e3658e2610c5f7a4a2e1777ce9e4f2ac':{protocol:'sushiswap-v2',name:/^sushiswap\b/i}};
export const ETHEREUM_V3_FACTORY='0x1f98431c8ad98523631ae4a59f267346ea31f984';
export function poolKind(chain:Chain,pool:Pool):{kind:'v2';protocol:string}|{kind:'v3'}|null{
 if(chain!=='ethereum'||!pool.factory||!pool.protocol)return null;
 const v2=ETHEREUM_V2[pool.factory];if(v2&&v2.name.test(pool.protocol))return {kind:'v2',protocol:v2.protocol};
 return pool.factory===ETHEREUM_V3_FACTORY&&/^uniswap v3\b/i.test(pool.protocol)?{kind:'v3'}:null;
}

export async function securityDetail(client:CmcClient,chain:Chain,address:string):Promise<any|null>{
 const rows=(await client.get('/v1/dex/security/detail',{platformName:chain,address}))?.data;
 return (Array.isArray(rows)?rows:[]).find(r=>evm(String(r?.tokenContractAddress??''))===evm(address))??null;
}

export type Holder={address:string;balance:string;percent:string|null;name:string|null;tags:string[]};
// The top 100 wallets. Tags arrive as a JSON string ({"tag_lp_contract":1,...}); a tag counts only when its value is non-zero.
export async function holdersList(client:CmcClient,chain:Chain,address:string):Promise<Holder[]>{
 const rows=(await client.post('/v1/dex/holders/list',{tokenAddress:address,platform:chain,tag:'tag_all'}))?.data?.holders;
 const tags=(raw:unknown)=>{try{return Object.entries(JSON.parse(String(raw??'{}'))).filter(([,v])=>Number(v)!==0).map(([k])=>k)}catch{return []}};
 return (Array.isArray(rows)?rows:[]).flatMap(h=>{const balance=exact(h?.balance);return h?.walletAddress&&balance?[{address:evm(h.walletAddress),balance,percent:exact(h.percent),name:h.publicName||null,tags:tags(h.tags)}]:[]});
}
