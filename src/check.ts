import { Decimal } from 'decimal.js';
import { CmcError, type CmcClient } from './client.ts';
import { resolver } from './resolve.ts';
import { latestQuotes } from './prices.ts';
import { dexPools, dexPrice, holdersList, poolKind, securityDetail, type Chain } from './dex.ts';
import { classifySecurity } from './security.ts';
import { holderOverhang } from './overhang.ts';
import { USDC_MINT, type jupiterClient } from './jupiter.ts';
import { blockNumber, decimals as evmDecimals, v2Factory, v2Reserves, v3Fee, v3Quote, type Rpc } from './evm.ts';
import { assessPosition, sliderQuantities, type RouteQuote, type Venue } from './assess.ts';
import type { Lot } from './lots.ts';

// The any-token check: chain, contract, quantity and optional purchase lots in; the same engine the product uses out.
// CMC supplies identity, the mark, pool discovery, security and holders; the chain and Jupiter supply executable amounts.
export type CheckInput = { chain: Chain; address: string; quantity: string; lots?: Lot[]; verifiedSellTax?: string };
export type CheckDeps = {
  cmc: CmcClient;
  jupiter?: ReturnType<typeof jupiterClient>;
  rpc?: Rpc;
  solanaDecimals?: (mint: string) => Promise<number>;
  solanaTransferFee?: (mint: string) => Promise<string | null>;
  now?: () => Date;
};

// CMC's pool amounts must match the chain within 1% before a pool is modelled (measured: they matched exactly on PEPE/WETH).
const RESERVE_TOLERANCE = '0.01',
  REFERENCE_USD = '50',
  MAX_V3_POOLS = 2;
// Proceeds are counted only in deep, widely held quote tokens. A pool pairing the token with another thin token could show
// high "proceeds" in something that cannot itself be sold at its mark, and the best-paying venue would win.
export const QUOTE_TOKENS: Record<string, string> = {
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'WETH',
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT',
  '0x6b175474e89094c44da98b954eedeac495271d0f': 'DAI',
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 'WBTC',
};
const toRaw = (q: string, d: number) =>
  BigInt(new Decimal(q).mul(new Decimal(10).pow(d)).toFixed(0, Decimal.ROUND_DOWN));
const fromRaw = (n: bigint, d: number) => new Decimal(n.toString()).div(new Decimal(10).pow(d)).toFixed();
const key = (q: string) => new Decimal(q).toFixed();
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function checkToken(input: CheckInput, deps: CheckDeps) {
  const clock = deps.now ?? (() => new Date()),
    started = clock().toISOString(),
    addr = input.chain === 'ethereum' ? input.address.toLowerCase() : input.address,
    notes: string[] = [];
  const mark0 = callMark(deps);
  if (!new Decimal(input.quantity).gt(0)) throw RangeError('Quantity must be positive');
  const resolve = resolver(deps.cmc),
    prices = new Map<string, string | null>();
  const priceOf = async (address: string) => {
    if (!prices.has(address)) {
      const id = (await resolve({ symbol: '', address }))?.id;
      prices.set(address, id ? ((await latestQuotes(deps.cmc, [id])).get(id)?.price ?? null) : null);
    }
    return prices.get(address)!;
  };

  const listed = await resolve({ symbol: '', address: addr }),
    quote = listed ? (await latestQuotes(deps.cmc, [listed.id])).get(listed.id) : undefined;
  const dex = await dexPrice(deps.cmc, input.chain, addr);
  // A listed quote is the mark; otherwise CMC's DEX price. A DEX price without a time cannot be shown as fresh.
  const mark = quote
    ? { price: quote.price, at: quote.at, source: `CoinMarketCap #${listed!.id} quotes/latest` }
    : dex
      ? { price: dex.price, at: dex.at ?? '1970-01-01T00:00:00.000Z', source: 'CoinMarketCap DEX token price' }
      : null;
  // On Solana the chain settles the tax question: the mint's own program decides whether a transfer can be charged a fee.
  let chainTax: string | null = null;
  if (input.chain === 'solana' && deps.solanaTransferFee) {
    try {
      chainTax = await deps.solanaTransferFee(addr);
    } catch {}
  }
  if (chainTax !== null)
    notes.push(
      chainTax === '0'
        ? 'Transfer fee checked on-chain: this mint cannot charge one.'
        : `Transfer fee checked on-chain: ${new Decimal(chainTax).mul(100).toFixed()}% per transfer.`,
    );
  const detail = await securityDetail(deps.cmc, input.chain, addr),
    security = {
      ...classifySecurity(detail, { verifiedSellTax: chainTax ?? input.verifiedSellTax }),
      at: detail?.fetchedAt ?? clock().toISOString(),
    };
  const pools = await dexPools(deps.cmc, input.chain, addr, 10);
  let overhang: ReturnType<typeof holderOverhang> | null = null;
  try {
    overhang = holderOverhang(await holdersList(deps.cmc, input.chain, addr), {
      pools: new Set(pools.map((p) => p.address)),
    });
  } catch (e) {
    if (!(e instanceof CmcError)) throw e;
    notes.push(`holders list unavailable: ${e.message}`);
  }

  // A failed chain connection leaves the exit not assessed; the mark, the rating and the marked gain still stand.
  const chainName = input.chain === 'ethereum' ? 'Ethereum' : 'Solana',
    failed = (e: unknown) => `${chainName} connection failed, so the exit was not assessed (${message(e)})`;
  let decimals = 18,
    exitError: string | undefined;
  try {
    decimals =
      input.chain === 'ethereum'
        ? await evmDecimals(need(deps.rpc, 'an Ethereum RPC'), addr)
        : await need(deps.solanaDecimals, 'Solana decimals')(addr);
  } catch (e) {
    exitError = failed(e);
  }
  const quantity = new Decimal(input.quantity).toDecimalPlaces(decimals, Decimal.ROUND_DOWN).toFixed(),
    sizes = sliderQuantities(quantity, decimals);
  const reference = mark
    ? Decimal.min(quantity, new Decimal(REFERENCE_USD).div(mark.price))
        .toDecimalPlaces(decimals, Decimal.ROUND_DOWN)
        .toFixed()
    : null;
  const held = overhang ? new Decimal(overhang.tokens).toDecimalPlaces(decimals, Decimal.ROUND_DOWN) : new Decimal(0);
  // Route quotes are needed only at the sale sizes and the reference size; the stress case uses the pool model alone.
  const quoteSizes = [...new Set([...sizes, ...(reference && new Decimal(reference).gt(0) ? [reference] : [])])];
  const venues: Venue[] = [];
  let block: number | null = null;

  if (!exitError)
    try {
      if (input.chain === 'ethereum') {
        const rpc = need(deps.rpc, 'an Ethereum RPC');
        block = await blockNumber(rpc);
        let v3 = 0;
        for (const p of [...pools].sort((a, b) => new Decimal(b.liquidityUsd ?? 0).cmp(a.liquidityUsd ?? 0))) {
          const kind = poolKind('ethereum', p),
            mine = p.tokens.find((t) => t.address === addr),
            other = p.tokens.find((t) => t.address !== addr);
          if (!kind || !mine || !other) continue;
          if (!QUOTE_TOKENS[other.address]) {
            notes.push(`${p.address}: paired with ${other.symbol}; only WETH, USDC, USDT, DAI and WBTC pools are used`);
            continue;
          }
          const outPrice = await priceOf(other.address);
          if (!outPrice) {
            notes.push(`${p.address}: no CoinMarketCap price for ${other.symbol}`);
            continue;
          }
          const outDecimals = await evmDecimals(rpc, other.address, block),
            output = { symbol: other.symbol, price: outPrice };
          if (kind.kind === 'v2') {
            const [r, factory] = await Promise.all([
                v2Reserves(rpc, p.address, block),
                v2Factory(rpc, p.address, block),
              ]),
              mineIs0 = r.token0 === addr;
            const reserveToken = fromRaw(mineIs0 ? r.reserve0 : r.reserve1, decimals),
              reserveQuote = fromRaw(mineIs0 ? r.reserve1 : r.reserve0, outDecimals);
            const near = (cmc: string | null, chain: string) =>
              cmc !== null && new Decimal(cmc).minus(chain).abs().lte(new Decimal(chain).mul(RESERVE_TOLERANCE));
            venues.push({
              kind: 'pool',
              id: `${kind.protocol}:${p.address}`,
              pool: { protocol: kind.protocol, reserveToken, reserveQuote, block, at: clock().toISOString() },
              output,
              confirmed: factory === p.factory && near(mine.amount, reserveToken) && near(other.amount, reserveQuote),
            });
          } else if (v3++ < MAX_V3_POOLS) {
            const fee = await v3Fee(rpc, p.address, block),
              quotes: Record<string, RouteQuote> = {};
            for (const q of quoteSizes) {
              try {
                const r = await v3Quote(
                  rpc,
                  { tokenIn: addr, tokenOut: other.address, amountIn: toRaw(q, decimals), fee },
                  block,
                );
                quotes[key(q)] = { out: fromRaw(r.amountOut, outDecimals), at: clock().toISOString() };
              } catch (e) {
                quotes[key(q)] = { error: message(e), at: clock().toISOString() };
              }
            }
            const ref = reference ? quotes[key(reference)] : undefined;
            venues.push({
              kind: 'route',
              id: `uniswap-v3:${p.address}`,
              source: 'uniswap-v3',
              output,
              reference: ref && 'out' in ref ? { quantity: reference!, out: ref.out } : null,
              quotes,
            });
          }
        }
      } else {
        const jupiter = need(deps.jupiter, 'a Jupiter client'),
          usdc = await priceOf(USDC_MINT),
          quotes: Record<string, RouteQuote> = {};
        if (!usdc) notes.push('no CoinMarketCap price for USDC');
        else {
          for (const q of quoteSizes) {
            try {
              const r = await jupiter.order({ inputMint: addr, amount: toRaw(q, decimals) });
              quotes[key(q)] = { out: fromRaw(BigInt(r.outAmount), 6), at: r.at };
            } catch (e) {
              quotes[key(q)] = { error: message(e), at: clock().toISOString() };
            }
          }
          const ref = reference ? quotes[key(reference)] : undefined;
          venues.push({
            kind: 'route',
            id: `jupiter:${addr}`,
            source: 'jupiter',
            output: { symbol: 'USDC', price: usdc },
            reference: ref && 'out' in ref ? { quantity: reference!, out: ref.out } : null,
            quotes,
          });
        }
      }
    } catch (e) {
      exitError = failed(e);
      venues.length = 0;
      block = null;
    }
  // The whole market's 24h volume: the listing's figure, or CMC's DEX figure when that is higher (thin listings can report 0).
  const volumes = [quote?.volume24h, dex?.volume24hUsd].filter((v): v is string => v != null),
    volume = volumes.sort((a, b) => new Decimal(b).cmp(a))[0] ?? null;

  const now = clock().toISOString(),
    symbol = listed?.symbol ?? pools.flatMap((p) => p.tokens).find((t) => t.address === addr)?.symbol ?? '?';
  const at = (q: string, withOverhang: boolean) =>
    assessPosition({
      symbol,
      quantity: q,
      now,
      mark,
      security,
      venues,
      lots: input.lots,
      volume24hUsd: volume,
      exitError,
      overhang:
        withOverhang && held.gt(0) ? { tokens: held.toFixed(), liquidityUsd: dex?.liquidityUsd ?? null } : undefined,
    });
  return {
    token: {
      chain: input.chain as Chain | 'listed',
      address: addr,
      symbol,
      decimals,
      cmcId: listed?.id ?? null,
      matchedBy: listed?.by ?? null,
    },
    mark,
    security,
    quantity,
    started,
    assessedAt: now,
    block,
    notes,
    pools: pools.map((p) => ({
      address: p.address,
      protocol: p.protocol,
      kind: poolKind(input.chain, p)?.kind ?? null,
      liquidityUsd: p.liquidityUsd,
    })),
    overhang: overhang && {
      tokens: held.toFixed(),
      counted: overhang.counted.map((h) => ({ address: h.address, name: h.name, balance: h.balance })),
      excluded: overhang.excluded.map((e) => ({ address: e.holder.address, name: e.holder.name, reason: e.reason })),
    },
    full: at(quantity, true),
    slider: sizes.map((q) => at(q, false)),
    venues,
    evidence: evidenceSince(mark0, deps),
  };
}

// Evidence covers only the calls this check made: a client shared across checks keeps every call, so each check notes
// where the list stood when it began. Responses another check already fetched (and a cache served) are not repeated here.
type Marker = { cmc: number; credits: number; jupiter: number };
const callMark = (deps: { cmc: CmcClient; jupiter?: ReturnType<typeof jupiterClient> }): Marker => ({
  cmc: deps.cmc.calls.length,
  credits: deps.cmc.credits(),
  jupiter: deps.jupiter?.calls.length ?? 0,
});
const evidenceSince = (m: Marker, deps: { cmc: CmcClient; jupiter?: ReturnType<typeof jupiterClient> }) => ({
  cmc: deps.cmc.calls.slice(m.cmc).map(({ body, ...c }) => c),
  jupiter: deps.jupiter?.calls.slice(m.jupiter).map(({ body, ...c }) => c) ?? [],
  credits: deps.cmc.credits() - m.credits,
});

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw Error(`This chain needs ${what}`);
  return v;
}

// Major native coins (BTC, ETH, SOL…) have no contract or pool to model. They are matched by CoinMarketCap id from a fixed
// list, never by a typed symbol, and rated against the whole market's 24-hour volume: indicative, never a proceeds figure.
export const MAJOR_COINS: Record<string, number> = {
  BTC: 1,
  ETH: 1027,
  SOL: 5426,
  BNB: 1839,
  XRP: 52,
  ADA: 2010,
  DOGE: 74,
  TRX: 1958,
  AVAX: 5805,
  DOT: 6636,
  LTC: 2,
  BCH: 1831,
  ATOM: 3794,
  XLM: 512,
  TON: 11419,
  GRAM: 11419,
};
export type CheckResult = Awaited<ReturnType<typeof checkToken>>;
export async function checkListedCoin(
  input: { cmcId: number; quantity: string; lots?: Lot[] },
  deps: { cmc: CmcClient; now?: () => Date },
): Promise<CheckResult> {
  const clock = deps.now ?? (() => new Date()),
    started = clock().toISOString(),
    mark0 = callMark(deps);
  if (!new Decimal(input.quantity).gt(0)) throw RangeError('Quantity must be positive');
  const q = (await latestQuotes(deps.cmc, [input.cmcId])).get(input.cmcId);
  const mark = q ? { price: q.price, at: q.at, source: `CoinMarketCap #${input.cmcId} quotes/latest` } : null,
    quantity = new Decimal(input.quantity).toDecimalPlaces(8, Decimal.ROUND_DOWN).toFixed();
  const security = { ...classifySecurity(null), at: clock().toISOString() },
    now = clock().toISOString(),
    symbol = q?.symbol ?? '?';
  const at = (size: string) =>
    assessPosition({
      symbol,
      quantity: size,
      now,
      mark,
      security,
      venues: [],
      lots: input.lots,
      volume24hUsd: q?.volume24h ?? null,
    });
  return {
    token: {
      chain: 'listed' as Chain | 'listed',
      address: `cmc:${input.cmcId}`,
      symbol,
      decimals: 8,
      cmcId: input.cmcId,
      matchedBy: 'id' as 'address' | 'symbol' | 'id' | null,
    },
    mark,
    security,
    quantity,
    started,
    assessedAt: now,
    block: null,
    notes: [
      'A native coin: no on-chain pool to model, so the exit is rated against the whole market’s 24-hour volume.',
    ],
    pools: [],
    overhang: null,
    full: at(quantity),
    slider: sliderQuantities(quantity, 8).map(at),
    venues: [] as Venue[],
    evidence: evidenceSince(mark0, deps),
  } as unknown as CheckResult;
}
