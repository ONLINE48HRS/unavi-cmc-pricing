// Independent check of the pool model: price the same sale with our formula (from on-chain reserves) and with the protocol's
// own router (getAmountsOut), both at ONE block, so live market moves cannot cause a mismatch. Pairs are looked up through
// each factory's getPair, so no pool address is taken on trust. Tax-free tokens only: a router does not apply transfer tax.
// Usage: npx tsx scripts/validate-v2.ts   (optional ETH_RPC_URL; public RPCs otherwise). Writes evidence/validate-v2-<block>.json
import { mkdir, writeFile } from 'node:fs/promises';
import { Decimal } from 'decimal.js';
import { blockNumber, rpcClient, v2Factory, v2Reserves, v2RouterOut, type Rpc } from '../src/evm.ts';
import { v2Out } from '../src/pool-model.ts';

const T = {
  WETH: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  USDC: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  DAI: '0x6b175474e89094c44da98b954eedeac495271d0f',
  WBTC: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
  PEPE: '0x6982508145454ce325ddbe47a25d4ec3d2311933',
};
const DEPLOYMENTS = {
  'uniswap-v2': {
    factory: '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f',
    router: '0x7a250d5630b4cf539739df2c5dacb4c659f2488d',
  },
  'sushiswap-v2': {
    factory: '0xc0aee478e3658e2610c5f7a4a2e1777ce9e4f2ac',
    router: '0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f',
  },
};
const CASES: [keyof typeof DEPLOYMENTS, keyof typeof T, keyof typeof T][] = [
  ['uniswap-v2', 'PEPE', 'WETH'],
  ['uniswap-v2', 'USDC', 'WETH'],
  ['uniswap-v2', 'DAI', 'WETH'],
  ['uniswap-v2', 'WBTC', 'WETH'],
  ['sushiswap-v2', 'USDC', 'WETH'],
];
// Sales of 0.01%, 0.1%, 1% and 10% of the pool's reserve of the token sold.
const SHARES = [10000n, 1000n, 100n, 10n];
const TOLERANCE = new Decimal('0.001');

const word = (a: string) => a.replace(/^0x/, '').padStart(64, '0');
async function getPair(rpc: Rpc, factory: string, a: string, b: string, block: number) {
  const r: string = await rpc('eth_call', [
    { to: factory, data: '0xe6a43905' + word(a) + word(b) },
    '0x' + block.toString(16),
  ]);
  return '0x' + r.slice(-40);
}

const rpc = rpcClient(),
  block = await blockNumber(rpc),
  rows = [];
let worst = new Decimal(0);
for (const [protocol, sell, receive] of CASES) {
  const d = DEPLOYMENTS[protocol],
    pair = await getPair(rpc, d.factory, T[sell], T[receive], block);
  if (/^0x0+$/.test(pair)) {
    console.error(`${protocol} has no ${sell}/${receive} pair`);
    process.exitCode = 1;
    continue;
  }
  const [r, factory] = await Promise.all([v2Reserves(rpc, pair, block), v2Factory(rpc, pair, block)]);
  if (factory !== d.factory) {
    console.error(`${pair} reports factory ${factory}`);
    process.exitCode = 1;
    continue;
  }
  const [x, y] = r.token0 === T[sell] ? [r.reserve0, r.reserve1] : [r.reserve1, r.reserve0];
  for (const share of SHARES) {
    const amountIn = x / share,
      model = v2Out(
        { protocol, reserveToken: x.toString(), reserveQuote: y.toString(), block, at: new Date().toISOString() },
        amountIn.toString(),
      );
    const router = await v2RouterOut(rpc, amountIn, [T[sell], T[receive]], block, d.router),
      diff = model.minus(router.toString()).div(router.toString()).abs();
    if (diff.gt(worst)) worst = diff;
    rows.push({
      protocol,
      pair,
      sell,
      receive,
      block,
      amountIn: amountIn.toString(),
      model: model.toFixed(0),
      router: router.toString(),
      relativeDifference: diff.toExponential(3),
    });
    console.log(
      `${protocol} ${sell}/${receive} @${block} sell ${new Decimal(100).div(share.toString())}% of reserve: model ${model.toFixed(0)} router ${router} diff ${diff.toExponential(2)}`,
    );
    if (diff.gt(TOLERANCE)) {
      console.error('MISMATCH: more than 0.1% from the router at the same block');
      process.exitCode = 1;
    }
  }
}
console.log(
  `${rows.length} sales on ${new Set(rows.map((r) => r.pair)).size} pools; largest difference ${worst.toExponential(2)} (tolerance 1e-3)`,
);
await mkdir('evidence', { recursive: true });
await writeFile(`evidence/validate-v2-${block}.json`, JSON.stringify(rows, null, 1));
