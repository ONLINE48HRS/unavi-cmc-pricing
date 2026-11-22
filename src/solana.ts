// A mint's decimals from Solana's getTokenSupply, so quote sizes are exact raw amounts. Public RPC unless SOLANA_RPC_URL is set.
export const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
export function solanaDecimals(url = process.env.SOLANA_RPC_URL || SOLANA_RPC, fetcher: typeof fetch = fetch) {
  return async (mint: string) => {
    const r = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenSupply', params: [mint] }),
      signal: AbortSignal.timeout(10000),
    });
    const d = ((await r.json()) as any)?.result?.value?.decimals;
    if (!Number.isInteger(d)) throw Error(`No decimals for mint ${mint}`);
    return d as number;
  };
}

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
// The transfer fee a mint charges, as a fraction, read from the chain. A classic SPL mint cannot charge one. A Token-2022
// mint charges one only through its transfer-fee extension; the higher of its current and scheduled rates is used, so the
// figure is never understated. null when the mint cannot be read or belongs to another program.
export function solanaTransferFee(url = process.env.SOLANA_RPC_URL || SOLANA_RPC, fetcher: typeof fetch = fetch) {
  return async (mint: string): Promise<string | null> => {
    const r = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getAccountInfo',
        params: [mint, { encoding: 'jsonParsed' }],
      }),
      signal: AbortSignal.timeout(10000),
    });
    const account = ((await r.json()) as any)?.result?.value;
    if (!account) return null;
    if (account.owner === TOKEN_PROGRAM) return '0';
    if (account.owner !== TOKEN_2022_PROGRAM) return null;
    const fee = (account.data?.parsed?.info?.extensions ?? []).find((e: any) => e?.extension === 'transferFeeConfig');
    if (!fee) return '0';
    const bps = [
      fee.state?.olderTransferFee?.transferFeeBasisPoints,
      fee.state?.newerTransferFee?.transferFeeBasisPoints,
    ].filter(Number.isInteger) as number[];
    return bps.length ? String(Math.max(...bps) / 10000) : null;
  };
}
