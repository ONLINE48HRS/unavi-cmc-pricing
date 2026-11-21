// A mint's decimals from Solana's getTokenSupply, so quote sizes are exact raw amounts. Public RPC unless SOLANA_RPC_URL is set.
export const SOLANA_RPC='https://api.mainnet-beta.solana.com';
export function solanaDecimals(url=process.env.SOLANA_RPC_URL||SOLANA_RPC,fetcher:typeof fetch=fetch){
 return async(mint:string)=>{
  const r=await fetcher(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getTokenSupply',params:[mint]}),signal:AbortSignal.timeout(10000)});
  const d=((await r.json()) as any)?.result?.value?.decimals;if(!Number.isInteger(d))throw Error(`No decimals for mint ${mint}`);return d as number;
 };
}
