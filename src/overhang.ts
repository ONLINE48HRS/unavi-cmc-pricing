import { Decimal } from 'decimal.js';
import type { Holder } from './dex.ts';

// Holder overhang: tokens held by the largest wallets that could reach the same pools before the user does. Wallets that are
// not one seller are left out, each with its reason: liquidity pools, burn addresses, exchange wallets (customer funds) and
// token lockers. Exchange and locker wallets are recognised by CMC's public name only; an unnamed wallet is counted.
const BURN = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
  '1nc1nerator11111111111111111111111111111111',
]);
const EXCHANGE =
  /^(binance|okx|okcoin|bybit|coinbase|kraken|bitget|gate(\.io)?|kucoin|htx|huobi|crypto\.com|bithumb|upbit|korbit|coinone|gopax|poloniex|btcturk|paribu|revolut|mexc|bitfinex|gemini|robinhood|bitstamp|bitvavo|bitpanda|bingx|lbank|bitmart|whitebit|phemex|deribit|coinspot|swyftx|independent reserve|btc markets|bitkub|bitflyer|coincheck|bitbank|zaif|luno|valr|bitso|mercado bitcoin|ndax|wazirx|coindcx|zebpay|tokocrypto|indodax|bitrue|ascendex|probit|xt\.com|coinw|hashkey|bullish|backpack|pionex|bitunix|blofin|weex|toobit|hotcoin|exmo|cex\.io)\b/i;
const LOCKER = /(\block|unicrypt|team\.?finance|pinksale|vesting|sablier|streamflow|hedgey)/i;
export type Exclusion = 'lp' | 'burn' | 'exchange' | 'locker';

export function exclusion(h: Holder, pools: Set<string>): Exclusion | null {
  if (pools.has(h.address) || h.tags.includes('tag_lp_contract')) return 'lp';
  if (BURN.has(h.address)) return 'burn';
  if (h.name && EXCHANGE.test(h.name.trim())) return 'exchange';
  return h.name && LOCKER.test(h.name) ? 'locker' : null;
}

export function holderOverhang(holders: Holder[], { pools, top = 10 }: { pools: Set<string>; top?: number }) {
  const ordered = [...holders].sort((a, b) => new Decimal(b.balance).cmp(a.balance)),
    counted: Holder[] = [],
    excluded: { holder: Holder; reason: Exclusion }[] = [];
  for (const h of ordered) {
    if (counted.length === top) break;
    const reason = exclusion(h, pools);
    if (reason) excluded.push({ holder: h, reason });
    else counted.push(h);
  }
  return { tokens: counted.reduce((s, h) => s.plus(h.balance), new Decimal(0)).toFixed(), counted, excluded };
}
