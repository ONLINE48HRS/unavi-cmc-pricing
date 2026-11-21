// Any-token check: what a holding is marked at, what selling it could realistically return, and what that does to the gain.
// Usage: CMC_API_KEY=... npx tsx demo/check-token.ts <ethereum|solana> <address> <quantity> [total cost basis in USD]
// Optional: ETH_RPC_URL (keyed Ethereum RPC; public fallbacks otherwise), JUPITER_API_KEY, SOLANA_RPC_URL.
// Saves the result and every request (no response bodies, no keys) to evidence/.
import {mkdir,writeFile} from 'node:fs/promises';
import {Decimal} from 'decimal.js';
import {checkToken} from '../src/check.ts';
import {cmcClient} from '../src/client.ts';
import {rpcClient} from '../src/evm.ts';
import {jupiterClient} from '../src/jupiter.ts';
import {solanaDecimals} from '../src/solana.ts';

const [chain,address,quantity,basis]=process.argv.slice(2);
if((chain!=='ethereum'&&chain!=='solana')||!address||!quantity){console.error('Usage: check-token.ts <ethereum|solana> <address> <quantity> [cost basis USD]');process.exit(2)}
const cmc=cmcClient({apiKey:process.env.CMC_API_KEY});
const result=await checkToken({chain,address,quantity,lots:basis?[{id:'basis',acquiredAt:'0000',quantity,cost:basis}]:undefined},
 {cmc,rpc:rpcClient(),jupiter:jupiterClient({apiKey:process.env.JUPITER_API_KEY}),solanaDecimals:solanaDecimals()});

const usd=(v:string|null|undefined)=>v==null?'—':(new Decimal(v).isNeg()?'−$':'$')+new Decimal(v).abs().toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,',');
const f=result.full,signed=(v:string)=>(new Decimal(v).gte(0)?'+':'')+usd(v);
console.log(`${result.token.symbol} on ${chain}, ${result.quantity} tokens · ${result.mark?.source??'unpriced'}`);
console.log(`State: ${f.state}${f.method?` (${f.method}${f.venue?' via '+f.venue:''})`:''}`);
if(f.gains?.markedGain!=null&&f.gains.adjustedGain!=null)console.log(`On screen: ${signed(f.gains.markedGain)} · After a realistic exit: ${signed(f.gains.adjustedGain)}`);
console.log(`Marked ${usd(f.mark)} · Estimated proceeds ${usd(f.proceeds)}${f.proceeds?` (in ${f.venue?.startsWith('jupiter')?'USDC':'the pool\'s quote token'}, not bank cash)`:''}`);
for(const p of f.bridge?.parts??[])console.log(`  ${p.name.padEnd(10)} ${usd(p.value)}`);
for(const s of result.slider)console.log(`  sell ${s.quantity.padEnd(24)} ${s.state.padEnd(13)} proceeds ${usd(s.proceeds)}`);
if(f.overhang)console.log(`If the top holders sold first (${f.overhang.tokens} tokens, ${usd(f.overhang.valueAtMark)} at mark${f.overhang.depthMultiple?`, ${new Decimal(f.overhang.depthMultiple).toFixed(1)}× DEX liquidity`:''}): proceeds ${usd(f.overhang.proceedsAfter)}${f.overhang.note?' · '+f.overhang.note:''}`);
console.log(`Security: ${result.security.class}${result.security.hits.length?' · '+result.security.hits.map(h=>h.code).join(', '):''}${result.security.unknown.length?' · not checked: '+result.security.unknown.join(', '):''}`);
for(const r of [...f.reasons,...result.notes])console.log(`  note: ${r}`);
for(const c of f.conditions)console.log(`  condition: ${c}`);
for(const t of f.timeToSell??[])console.log(`  indicative, not an execution quote: ${new Decimal(t.days).toSignificantDigits(3)} days at ${new Decimal(t.participation).mul(100)}% of exchange volume`);
console.log(`CoinMarketCap: ${result.evidence.cmc.length} calls, ${result.evidence.credits} credits · Jupiter: ${result.evidence.jupiter.length} quotes${result.block?` · Ethereum block ${result.block}`:''}`);
await mkdir('evidence',{recursive:true});const out=`evidence/check-${result.token.symbol}-${result.assessedAt.replace(/[:.]/g,'-')}.json`;
await writeFile(out,JSON.stringify(result,null,1));console.log(`Saved to ${out}`);
