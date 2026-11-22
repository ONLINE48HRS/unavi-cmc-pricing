import test from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import {
  assessPosition,
  checkListedCoin,
  checkToken,
  cmcClient,
  CmcError,
  jupiterClient,
  QuoteError,
  v2Out,
  QUOTE_TOKENS,
  USDC_MINT,
  type CmcClient,
  type Fetcher,
  type RouteVenue,
  type Security,
} from '../src/index.ts';

// Invented fixtures in the shape of the real responses; prices other than 1 so every multiplication is exercised.
const NOW = '2026-11-21T12:00:00.000Z',
  now = () => new Date(NOW),
  ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();
const TKN = '0x' + '1'.repeat(40),
  THIN = '0x' + 'c'.repeat(40),
  POOL = '0x' + 'a'.repeat(40),
  THIN_POOL = '0x' + 'b'.repeat(40);
const WETH = Object.keys(QUOTE_TOKENS).find((a) => QUOTE_TOKENS[a] === 'WETH')!,
  V2_FACTORY = '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f';
const MINT = 'Tkn1111111111111111111111111111111111111111';

// A CMC client answering from a table of handlers, one credit per call, recording calls as the real client does.
function fakeCmc(handlers: Record<string, (params: Record<string, any>, payload?: any) => any>): CmcClient {
  const calls: CmcClient['calls'] = [];
  const send = async (endpoint: string, params: Record<string, any>, payload?: any) => {
    const h = handlers[endpoint];
    if (!h) throw new CmcError(`no fixture for ${endpoint}`, 400, 400);
    const body = h(params, payload);
    calls.push({
      endpoint,
      params,
      status: 200,
      credits: 1,
      at: NOW,
      sha256: '0'.repeat(64),
      body: JSON.stringify(body),
    });
    return body;
  };
  return { get: (e, p = {}) => send(e, p), post: (e, p) => send(e, {}, p), calls, credits: () => calls.length };
}
const info = (rows: Record<string, { id: number; symbol: string }>) => (p: any) => {
  const r = rows[p.address];
  return {
    data: r
      ? { [r.id]: { ...r, name: r.symbol, slug: r.symbol.toLowerCase(), platform: { token_address: p.address } } }
      : {},
  };
};
const quotes = (rows: Record<number, { symbol: string; price: number; volume?: number; at?: string }>) => (p: any) => ({
  data: String(p.id)
    .split(',')
    .map(Number)
    .filter((id) => rows[id])
    .map((id) => ({
      id,
      symbol: rows[id].symbol,
      quote: [
        {
          symbol: 'USD',
          price: rows[id].price,
          volume_24h: rows[id].volume ?? null,
          last_updated: rows[id].at ?? ago(60_000),
        },
      ],
    })),
});

function ethereum() {
  const cmc = fakeCmc({
    '/v2/cryptocurrency/info': info({
      [TKN]: { id: 9001, symbol: 'TKN' },
      [WETH]: { id: 2396, symbol: 'WETH' },
      [THIN]: { id: 9002, symbol: 'THIN' },
    }),
    '/v3/cryptocurrency/quotes/latest': quotes({
      9001: { symbol: 'TKN', price: 0.002, volume: 1_000_000 },
      2396: { symbol: 'WETH', price: 3000 },
      9002: { symbol: 'THIN', price: 5 },
      1: { symbol: 'BTC', price: 90000, volume: 40_000_000_000 },
    }),
    '/v1/dex/token/price': () => ({ data: { p: 0.002, l: 500000, v24h: 200000, ts: Date.parse(NOW) } }),
    '/v1/dex/security/detail': () => ({
      data: [
        {
          tokenContractAddress: TKN,
          extra: { sellTax: '0', source: 'X' },
          evmDisplay: { honeypotStatus: 'No' },
          securityItems: [],
        },
      ],
      status: { timestamp: NOW },
    }),
    // The thin pool reports more liquidity, so it is tried first; it must be skipped for its quote token.
    '/v1/dex/token/pools': () => ({
      data: [
        {
          addr: THIN_POOL,
          exn: 'Uniswap V2',
          fa: V2_FACTORY,
          liqUsd: '999999',
          t0: { addr: TKN, sym: 'TKN', liq: '1000' },
          t1: { addr: THIN, sym: 'THIN', liq: '1000' },
        },
        {
          addr: POOL,
          exn: 'Uniswap V2',
          fa: V2_FACTORY,
          liqUsd: '200000',
          t0: { addr: TKN, sym: 'TKN', liq: '50000000' },
          t1: { addr: WETH, sym: 'WETH', liq: '33.333333333333333333' },
        },
      ],
    }),
    '/v1/dex/holders/list': () => ({ data: { holders: [] } }),
  });
  const word = (n: bigint | string) =>
    (typeof n === 'string' ? n.replace(/^0x/, '') : n.toString(16)).padStart(64, '0');
  const rpc = async (method: string, params: any[]) => {
    if (method === 'eth_blockNumber') return '0x100';
    const { data } = params[0];
    if (data === '0x313ce567') return '0x' + word(18n);
    if (data === '0x0902f1ac')
      return '0x' + word(50_000_000n * 10n ** 18n) + word(33_333_333_333_333_333_333n) + word(0n);
    if (data === '0x0dfe1681') return '0x' + word(TKN);
    if (data === '0xc45a0155') return '0x' + word(V2_FACTORY);
    throw Error('unexpected eth_call ' + data);
  };
  return { cmc, rpc };
}

test('checkToken on Ethereum: identity, mark and security from CMC; proceeds from the confirmed pool model in WETH; a thin quote token is skipped', async () => {
  const { cmc, rpc } = ethereum();
  const r = await checkToken(
    { chain: 'ethereum', address: TKN.toUpperCase().replace('0X', '0x'), quantity: '1000000' },
    { cmc, rpc, now },
  );
  assert.deepEqual(
    [r.token.symbol, r.token.cmcId, r.token.matchedBy, r.mark?.price],
    ['TKN', 9001, 'address', '0.002'],
  );
  assert.deepEqual([r.full.state, r.full.method, r.full.venue], ['assessed', 'pool-model', `uniswap-v2:${POOL}`]);
  const expected = v2Out(
    { protocol: 'uniswap-v2', reserveToken: '50000000', reserveQuote: '33.333333333333333333', at: NOW },
    '1000000',
    '0',
  ).mul(3000);
  assert.equal(new Decimal(r.full.proceeds!).toFixed(8), expected.toFixed(8), 'proceeds = pool output × the WETH mark');
  assert.equal(r.full.mark, '2000');
  assert.ok(
    r.notes.some((n) => n.includes(THIN_POOL) && n.includes('only WETH, USDC, USDT, DAI and WBTC')),
    'the THIN pool is named and skipped',
  );
  assert.ok(!r.venues.some((v) => v.id.includes(THIN_POOL)));
  assert.equal(r.slider.length, 4);
  assert.equal(r.full.liquidity?.band, 'low');
});

test('evidence lists only the calls each check made, even on a shared client', async () => {
  const { cmc, rpc } = ethereum();
  const first = await checkToken({ chain: 'ethereum', address: TKN, quantity: '1000' }, { cmc, rpc, now });
  assert.equal(first.evidence.credits, first.evidence.cmc.length);
  assert.ok(first.evidence.cmc.length > 0);
  const second = await checkListedCoin({ cmcId: 1, quantity: '0.5' }, { cmc, now });
  assert.deepEqual(
    second.evidence.cmc.map((c) => c.endpoint),
    ['/v3/cryptocurrency/quotes/latest'],
  );
  assert.equal(second.evidence.credits, 1);
  assert.ok(!JSON.stringify(second.evidence).includes(TKN), "the second check does not list the first check's calls");
});

test('a failed Ethereum connection leaves the exit not assessed, with the mark, rating and reason kept', async () => {
  const { cmc } = ethereum();
  const r = await checkToken(
    { chain: 'ethereum', address: TKN, quantity: '1000000' },
    {
      cmc,
      rpc: async () => {
        throw Error('refused');
      },
      now,
    },
  );
  assert.equal(r.full.state, 'not-assessed');
  assert.equal(r.full.mark, '2000');
  assert.equal(r.full.liquidity?.band, 'low');
  assert.ok(r.full.reasons.some((x) => /Ethereum connection failed.*refused/.test(x)));
});

test('checkToken on Solana: Jupiter route quotes at each sale size, an on-chain transfer fee, and no dollar stress figure for a route', async () => {
  const cmc = fakeCmc({
    '/v2/cryptocurrency/info': info({ [MINT]: { id: 9100, symbol: 'SLT' }, [USDC_MINT]: { id: 3408, symbol: 'USDC' } }),
    '/v3/cryptocurrency/quotes/latest': quotes({
      9100: { symbol: 'SLT', price: 0.6, volume: 5_000_000 },
      3408: { symbol: 'USDC', price: 0.9998 },
    }),
    '/v1/dex/token/price': () => ({ data: { p: 0.6, l: 250000, v24h: 4_000_000, ts: Date.parse(NOW) } }),
    '/v1/dex/security/detail': () => ({
      data: [
        {
          tokenContractAddress: MINT,
          extra: { source: 'X' },
          solanaDisplay: { honeypotStatus: 'No' },
          securityItems: [],
        },
      ],
      status: { timestamp: NOW },
    }),
    '/v1/dex/token/pools': () => ({ data: [] }),
    '/v1/dex/holders/list': () => ({
      data: {
        holders: [
          {
            walletAddress: 'Whale1111111111111111111111111111111111111',
            balance: '2000000',
            percent: '20',
            publicName: null,
            tags: '{}',
          },
        ],
      },
    }),
  });
  const asked: bigint[] = [];
  const jupiter = jupiterClient({
    gapMs: 0,
    now,
    fetcher: async (url) => {
      const amount = BigInt(new URL(url).searchParams.get('amount')!);
      asked.push(amount);
      // 0.5 USDC per token (6 decimals each side): a little below the 0.6 mark.
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () =>
          JSON.stringify({ inAmount: amount.toString(), outAmount: (amount / 2n).toString(), router: 'metis' }),
      };
    },
  });
  const r = await checkToken(
    { chain: 'solana', address: MINT, quantity: '10000' },
    { cmc, jupiter, solanaDecimals: async () => 6, solanaTransferFee: async () => '0', now },
  );
  assert.deepEqual([r.full.state, r.full.method, r.full.venue], ['assessed', 'route-quote', `jupiter:${MINT}`]);
  assert.equal(
    new Decimal(r.full.proceeds!).toFixed(6),
    new Decimal(5000).mul('0.9998').toFixed(6),
    'USDC received × the USDC mark',
  );
  assert.ok(r.notes.some((n) => /this mint cannot charge one/.test(n)));
  assert.equal(r.evidence.jupiter.length, asked.length);
  assert.equal(new Set(asked.map(String)).size, asked.length, 'each size is quoted once');
  assert.ok(!asked.includes(2_000_000n * 10n ** 6n), "no quote is spent at the holders' size");
  assert.deepEqual(
    [r.full.overhang?.proceedsAfter, r.full.overhang?.depthMultiple],
    [null, '4.8'],
    'holders 2M × $0.6 against $250k of DEX liquidity',
  );
});

test('CMC client: a 429 with retries:0 fails at once; a hung call times out; an unreachable API says so', async () => {
  let paused = 0;
  const limited = cmcClient({
    apiKey: 'k',
    retries: 0,
    pause: async () => {
      paused++;
    },
    fetcher: async () => ({
      ok: false,
      status: 429,
      headers: { get: () => '60' },
      text: async () => JSON.stringify({ status: { error_code: 1008, error_message: 'rate limit' } }),
    }),
  });
  await assert.rejects(limited.get('/v1/key/info'), (e: any) => e instanceof CmcError && e.status === 429);
  assert.equal(paused, 0, 'no wait on the interactive path');
  // AbortSignal.timeout does not hold the event loop open, so the fake keeps a timer of its own until it is aborted.
  const hung: Fetcher = (url, init) =>
    new Promise((_, reject) => {
      const keep = setTimeout(() => {}, 5000);
      init!.signal!.addEventListener('abort', () => {
        clearTimeout(keep);
        reject(init!.signal!.reason);
      });
    });
  await assert.rejects(
    cmcClient({ apiKey: 'k', timeoutMs: 20, fetcher: hung }).get('/v1/key/info'),
    /did not answer within 0.02 s/,
  );
  await assert.rejects(
    cmcClient({
      apiKey: 'k',
      fetcher: async () => {
        throw new TypeError('fetch failed');
      },
    }).get('/v1/key/info'),
    /CoinMarketCap could not be reached/,
  );
  await assert.rejects(
    jupiterClient({ gapMs: 0, timeoutMs: 20, fetcher: hung }).order({ inputMint: MINT, amount: 1n }),
    (e: any) => e instanceof QuoteError && /did not answer/.test(e.message),
  );
});

// Freshness limits, each tested on both sides of its boundary.
const clean: Security & { at: string } = {
  class: 'no-warnings',
  sellTax: '0',
  hits: [],
  unknown: [],
  source: 'fixture',
  at: NOW,
};
const pool = (at: string) => ({
  kind: 'pool' as const,
  id: 'p',
  pool: { protocol: 'uniswap-v2', reserveToken: '50000', reserveQuote: '100000', at },
  output: { symbol: 'USDC', price: '1' },
  confirmed: true,
});
const route = (at: string): RouteVenue => ({
  kind: 'route',
  id: 'r',
  source: 'jupiter',
  output: { symbol: 'USDC', price: '1' },
  reference: null,
  quotes: { '100': { out: '190', at } },
});
const position = (over: object = {}) =>
  assessPosition({
    symbol: 'TKN',
    quantity: '100',
    now: NOW,
    mark: { price: '2', at: NOW, source: 'fixture' },
    security: clean,
    venues: [pool(NOW)],
    volume24hUsd: '1000000',
    ...over,
  });

test('freshness: price 15 min, pool 5 min, route quote 60 s, security 24 h, each assessed at the limit and not one millisecond past it', () => {
  const cases: [string, (age: number) => object, number][] = [
    ['price', (age) => ({ mark: { price: '2', at: ago(age), source: 'fixture' } }), 15 * 60_000],
    ['pool', (age) => ({ venues: [pool(ago(age))] }), 5 * 60_000],
    ['route', (age) => ({ venues: [route(ago(age))] }), 60_000],
    ['security', (age) => ({ security: { ...clean, at: ago(age) } }), 24 * 3_600_000],
  ];
  for (const [name, over, limit] of cases) {
    assert.equal(position(over(limit)).state, 'assessed', `${name} at its limit`);
    assert.notEqual(position(over(limit + 1)).state, 'assessed', `${name} past its limit`);
  }
});

test('the 1% reserve tolerance and the factory check decide whether a pool is modelled', async () => {
  for (const [reported, ok] of [
    ['50500000', true],
    ['50600000', false],
  ] as const) {
    const { cmc, rpc } = ethereum(),
      pools = cmc.get;
    const c: CmcClient = {
      ...cmc,
      get: async (e, p) => {
        const body = await pools(e, p);
        if (e === '/v1/dex/token/pools') body.data[1].t0.liq = reported;
        return body;
      },
    };
    const r = await checkToken({ chain: 'ethereum', address: TKN, quantity: '1000' }, { cmc: c, rpc, now });
    assert.equal(
      r.venues.find((v) => v.id.includes(POOL))?.kind === 'pool' &&
        (r.venues.find((v) => v.id.includes(POOL)) as any).confirmed,
      ok,
      `CMC reports ${reported} against 50000000 on-chain`,
    );
  }
});
