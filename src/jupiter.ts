import {createHash} from 'node:crypto';
import type {Fetcher} from './client.ts';

export const USDC_MINT='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export type QuoteRecord={source:'jupiter';url:string;status:number;at:string;sha256:string;body:string};
export type JupiterQuote={inputMint:string;outputMint:string;inAmount:string;outAmount:string;router:string|null;feeBps:number|null;requestId:string|null;at:string;sha256:string};
export class QuoteError extends Error{constructor(message:string,readonly status:number,readonly code:string|null){super(message);this.name='QuoteError'}}

// GET /swap/v2/order without a taker returns a quote and no transaction. outAmount is what the seller receives, Jupiter's own
// fee already taken. Keyless access allows 30 requests a minute and a free key 1 a second, so calls are spaced to stay inside
// whichever applies. The response reports no slot, so a quote is dated by when it was received.
export function jupiterClient({apiKey,fetcher=fetch as unknown as Fetcher,gapMs=apiKey?1100:2100,now=()=>new Date(),clock=()=>Date.now(),pause=(ms:number)=>new Promise(r=>setTimeout(r,ms))}:{apiKey?:string;fetcher?:Fetcher;gapMs?:number;now?:()=>Date;clock?:()=>number;pause?:(ms:number)=>Promise<unknown>}={}){
 const calls:QuoteRecord[]=[];let next=0;
 async function order({inputMint,outputMint=USDC_MINT,amount}:{inputMint:string;outputMint?:string;amount:bigint}):Promise<JupiterQuote>{
  if(amount<=0n)throw RangeError('Quote amount must be positive');
  const start=Math.max(clock(),next);next=start+gapMs;if(start>clock())await pause(start-clock());
  const url=`https://api.jup.ag/swap/v2/order?${new URLSearchParams({inputMint,outputMint,amount:amount.toString()})}`;
  const response=await fetcher(url,{headers:{Accept:'application/json',...(apiKey?{'x-api-key':apiKey}:{})}}),body=await response.text(),at=now().toISOString();
  const sha256=createHash('sha256').update(body).digest('hex');calls.push({source:'jupiter',url,status:response.status,at,sha256,body});
  let j:any=null;try{j=JSON.parse(body)}catch{}
  if(!response.ok||j?.errorCode||j?.error)throw new QuoteError(j?.errorMessage||j?.error||`Jupiter HTTP ${response.status}`,response.status,j?.errorCode==null?null:String(j.errorCode));
  if(typeof j?.outAmount!=='string'||!/^\d+$/.test(j.outAmount)||j.inAmount!==amount.toString())throw new QuoteError('Jupiter returned no usable quote',response.status,null);
  return {inputMint,outputMint,inAmount:j.inAmount,outAmount:j.outAmount,router:j.router??null,feeBps:typeof j.feeBps==='number'?j.feeBps:null,requestId:j.requestId??null,at,sha256};
 }
 return {order,calls};
}
