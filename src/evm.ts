// Read-only Ethereum calls for the liquidity engine: v2 pool reserves, the Uniswap v2 router's own quote (used to validate
// the pool model at the same block) and the Uniswap v3 QuoterV2 (route quotes for concentrated liquidity). No keys, no
// signing; a keyed RPC is used first when configured, then public fallbacks.
export type Rpc=(method:string,params:unknown[])=>Promise<any>;
export const PUBLIC_RPCS=['https://ethereum-rpc.publicnode.com','https://1rpc.io/eth'];
export const UNISWAP_V2_ROUTER='0x7a250d5630b4cf539739df2c5dacb4c659f2488d';
export const UNISWAP_V3_QUOTER_V2='0x61ffe014ba17989e743c5f6cb21bf9697530b21e';

export function rpcClient(urls:string[]=[process.env.ETH_RPC_URL,...PUBLIC_RPCS].filter(Boolean) as string[],fetcher:typeof fetch=fetch):Rpc{
 return async(method,params)=>{let last:unknown;
  for(const url of urls){try{const r=await fetcher(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(10000)});
   const body:any=await r.json();if(body?.error)throw Error(`RPC ${method}: ${body.error.message}`);if(!r.ok)throw Error(`RPC HTTP ${r.status}`);return body.result}catch(error){last=error}}
  throw last instanceof Error?last:Error('No RPC answered');
 };
}

const word=(hex:string)=>hex.replace(/^0x/,'').toLowerCase().padStart(64,'0');
const uint=(n:bigint)=>word(n.toString(16));
const words=(data:string)=>(data.replace(/^0x/,'').match(/.{64}/g)??[]).map(w=>BigInt('0x'+w));
const blockTag=(block:number|'latest')=>block==='latest'?'latest':'0x'+block.toString(16);

export async function blockNumber(rpc:Rpc){return Number(BigInt(await rpc('eth_blockNumber',[])))}
async function call(rpc:Rpc,to:string,data:string,block:number|'latest'){return rpc('eth_call',[{to,data},blockTag(block)]) as Promise<string>}

// UniswapV2Pair.getReserves() and token0(), read at one block so the reserves and their order belong together.
export async function v2Reserves(rpc:Rpc,pair:string,block:number){
 const [reserves,token0]=await Promise.all([call(rpc,pair,'0x0902f1ac',block),call(rpc,pair,'0x0dfe1681',block)]);
 const [r0,r1]=words(reserves);return {reserve0:r0,reserve1:r1,token0:'0x'+word(token0).slice(24),block};
}

// UniswapV2Pair.factory(): which deployment the pair belongs to, so a pool is modelled only with its own fee.
export async function v2Factory(rpc:Rpc,pair:string,block:number){return '0x'+word(await call(rpc,pair,'0xc45a0155',block)).slice(24)}

// UniswapV2Router02.getAmountsOut(amountIn, path): the protocol's own integer maths, for validating the model. Forks such as
// SushiSwap deploy the same router code at their own address.
export async function v2RouterOut(rpc:Rpc,amountIn:bigint,path:string[],block:number,router=UNISWAP_V2_ROUTER){
 const data='0xd06ca61f'+uint(amountIn)+uint(64n)+uint(BigInt(path.length))+path.map(word).join('');
 return words(await call(rpc,router,data,block)).at(-1)!;
}

// UniswapV3Pool.fee(), in hundredths of a basis point (3000 = 0.30%).
export async function v3Fee(rpc:Rpc,pool:string,block:number){return Number(words(await call(rpc,pool,'0xddca3f43',block))[0])}

// QuoterV2.quoteExactInputSingle((tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96)) through eth_call. It simulates the
// swap against the pool's real ticks, so concentrated liquidity is quoted by the protocol, not approximated.
export async function v3Quote(rpc:Rpc,{tokenIn,tokenOut,amountIn,fee}:{tokenIn:string;tokenOut:string;amountIn:bigint;fee:number},block:number){
 const data='0xc6a5026a'+word(tokenIn)+word(tokenOut)+uint(amountIn)+uint(BigInt(fee))+uint(0n);
 const [amountOut,,ticksCrossed]=words(await call(rpc,UNISWAP_V3_QUOTER_V2,data,block));return {amountOut,ticksCrossed:Number(ticksCrossed),block};
}

export async function decimals(rpc:Rpc,token:string,block:number|'latest'='latest'){return Number(words(await call(rpc,token,'0x313ce567',block))[0])}
