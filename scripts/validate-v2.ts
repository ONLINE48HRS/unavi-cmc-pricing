// Independent check of the pool model: price the same sale with our formula (from on-chain reserves) and with the
// Uniswap v2 router's own getAmountsOut, both at ONE block, so live market moves cannot cause a mismatch.
// Usage: npx tsx scripts/validate-v2.ts   (optional ETH_RPC_URL; public RPCs otherwise). Writes evidence/validate-v2-<block>.json
import {mkdir,writeFile} from 'node:fs/promises';
import {Decimal} from 'decimal.js';
import {blockNumber,rpcClient,v2Reserves,v2RouterOut} from '../src/evm.ts';
import {v2Out} from '../src/pool-model.ts';

const PAIRS=[{name:'PEPE/WETH',pair:'0xa43fe16908251ee70ef74718545e4fe6c5ccec9f',token:'0x6982508145454ce325ddbe47a25d4ec3d2311933',quote:'0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',sizes:[10n**27n,10n**28n,10n**29n,10n**30n]}];
const rpc=rpcClient(),block=await blockNumber(rpc),rows=[];
for(const p of PAIRS){const r=await v2Reserves(rpc,p.pair,block),[x,y]=r.token0===p.token?[r.reserve0,r.reserve1]:[r.reserve1,r.reserve0];
 for(const amountIn of p.sizes){const model=v2Out({protocol:'uniswap-v2',reserveToken:x.toString(),reserveQuote:y.toString(),block,at:new Date().toISOString()},amountIn.toString()),router=await v2RouterOut(rpc,amountIn,[p.token,p.quote],block);
  const diff=model.minus(router.toString()).div(router.toString()).abs();rows.push({pair:p.name,block,amountIn:amountIn.toString(),model:model.toFixed(0),router:router.toString(),relativeDifference:diff.toExponential(3)});
  console.log(`${p.name} @${block} in ${amountIn}: model ${model.toFixed(0)} router ${router} diff ${diff.toExponential(2)}`);
  if(diff.gt('1e-12')){console.error('MISMATCH: the model does not match the router at the same block');process.exitCode=1}}}
await mkdir('evidence',{recursive:true});await writeFile(`evidence/validate-v2-${block}.json`,JSON.stringify(rows,null,1));
