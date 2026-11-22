import test from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { fifoSlice, gains, type Lot } from '../src/lots.ts';
import { routeBridge, v2Bridge, v2MaxSale, v2Out, type PoolState } from '../src/pool-model.ts';

const sum = (parts: { value: string }[]) => parts.reduce((s, p) => s.plus(p.value), new Decimal(0));

test('v2 output matches a hand-worked case and Uniswap v2 getAmountOut on raw integers', () => {
  const flat: PoolState = {
    protocol: 'uniswap-v2',
    reserveToken: '1000',
    reserveQuote: '1000',
    at: '2026-11-20T00:00:00Z',
  };
  // 100 in at 0.3%: effective 99.7, out = 1000·99.7/1099.7
  assert.equal(v2Out(flat, '100').toFixed(12), new Decimal(99700).div(1099.7).toFixed(12));
  // Uniswap v2 Library.getAmountOut: amountInWithFee = in·997; out = amountInWithFee·reserveOut / (reserveIn·1000 + amountInWithFee), floored.
  const getAmountOut = (i: bigint, ri: bigint, ro: bigint) => {
    const w = i * 997n;
    return (w * ro) / (ri * 1000n + w);
  };
  for (const [i, ri, ro] of [
    [10n ** 18n, 5n * 10n ** 21n, 2n * 10n ** 21n],
    [123456789n, 987654321000n, 55555555555n],
    [3n * 10n ** 24n, 10n ** 27n, 4n * 10n ** 20n],
  ] as [bigint, bigint, bigint][]) {
    const pool: PoolState = {
      protocol: 'uniswap-v2',
      reserveToken: ri.toString(),
      reserveQuote: ro.toString(),
      at: 't',
    };
    const ours = v2Out(pool, i.toString()),
      ref = getAmountOut(i, ri, ro);
    assert.ok(
      ours.minus(ref.toString()).abs().lt(1),
      `within one raw unit of the reference: ${ours.toFixed(0)} vs ${ref}`,
    );
  }
  assert.equal(
    v2Out({ ...flat, protocol: 'pancakeswap-v2' }, '100').toFixed(12),
    new Decimal(99750).div(1099.75).toFixed(12),
    'PancakeSwap v2 charges 0.25%',
  );
  assert.throws(
    () => v2Out({ ...flat, protocol: 'uniswap-v3' }, '1'),
    /Not a modelled constant-product/,
    'concentrated liquidity is never put through the v2 formula',
  );
});

test('transfer tax is taken from the tokens sent in, before the swap', () => {
  const pool: PoolState = { protocol: 'uniswap-v2', reserveToken: '1000', reserveQuote: '1000', at: 't' };
  assert.equal(
    v2Out(pool, '100', '0.05').toFixed(12),
    new Decimal(1000)
      .mul(100 * 0.95 * 0.997)
      .div(new Decimal(1000).plus(100 * 0.95 * 0.997))
      .toFixed(12),
  );
  assert.throws(() => v2Out(pool, '1', '1'), /Invalid/);
});

test('the bridge parts add to mark minus proceeds exactly, and each part is the right size', () => {
  const pool: PoolState = { protocol: 'uniswap-v2', reserveToken: '1000000', reserveQuote: '500', at: 't' }; // spot 0.0005 quote/token
  const b = v2Bridge(pool, '10000', { markPrice: '1.02', quotePrice: '2000', tax: '0.02' });
  assert.equal(sum(b.parts).toFixed(), new Decimal(b.mark).minus(b.proceeds).toFixed(), 'no residual is hidden');
  const part = (n: string) => new Decimal(b.parts.find((p) => p.name === n)!.value);
  assert.equal(part('reference').toFixed(), '200', 'mark 1.02 vs pool spot 1.00 on 10,000 tokens');
  assert.equal(part('tax').toFixed(), '200', '2% of 10,000 tokens at spot');
  assert.equal(part('fee').toFixed(), '29.4', '0.3% of the 9,800 tokens that reach the pool');
  assert.ok(part('impact').gt(0), 'selling moves the price against the seller');
  const r = routeBridge('100', { markPrice: '2', quotePrice: '1', proceedsOut: '180', referenceOutPerToken: '1.95' });
  assert.deepEqual(
    r.parts.map((p) => [p.name, p.value]),
    [
      ['reference', '5'],
      ['route', '15'],
    ],
    'a route quote shows one route cost, never a fee and an impact it cannot separate',
  );
  assert.deepEqual(
    routeBridge('1', { markPrice: '2', quotePrice: '1', proceedsOut: '1.5', referenceOutPerToken: null }).parts.map(
      (p) => p.name,
    ),
    ['residual'],
    'without a reference quote the gap is left unexplained, not split',
  );
});

test('proceeds per token fall as the sale grows, and the 1% sale size holds the price within 1%', () => {
  const pool: PoolState = { protocol: 'uniswap-v2', reserveToken: '1000000', reserveQuote: '500', at: 't' };
  let last = Infinity;
  for (const q of ['1000', '10000', '100000', '500000']) {
    const perToken = v2Out(pool, q).div(q).toNumber();
    assert.ok(perToken < last);
    last = perToken;
  }
  const q1 = v2MaxSale(pool, '0.01'),
    spot = new Decimal(500).div(1000000);
  assert.equal(
    v2Out(pool, q1).div(q1).div(spot).toFixed(12),
    '0.990000000000',
    'exactly 1% below spot at the boundary',
  );
  assert.ok(new Decimal(v2MaxSale(pool, '0.02')).gt(q1));
  assert.equal(v2MaxSale(pool, '0.002'), '0', 'a 0.2% limit is inside the 0.3% fee, so no sale qualifies');
});

test('FIFO slices take the oldest lots first and cost partly used lots in proportion', () => {
  const lots: Lot[] = [
    { id: 'b', acquiredAt: '2025-06-01', quantity: '10', cost: '300' },
    { id: 'a', acquiredAt: '2025-01-01', quantity: '10', cost: '100' },
  ];
  const s = fifoSlice(lots, '15');
  assert.deepEqual(
    s.slices.map((x) => [x.id, x.quantity, x.cost]),
    [
      ['a', '10', '100'],
      ['b', '5', '150'],
    ],
  );
  assert.equal(s.basis, '250');
  assert.equal(s.covered, true);
  assert.equal(fifoSlice(lots, '25').covered, false, 'selling more than the lots hold is reported, not costed at zero');
  const g = gains({ lots, quantity: '15', markPrice: '20', proceeds: '240' });
  assert.deepEqual(
    [g.mark, g.markedGain, g.adjustedGain, g.flipsToLoss],
    ['300', '50', '-10', true],
    'a $50 gain on screen is a $10 loss after a realistic exit',
  );
  assert.equal(
    gains({ lots, quantity: '25', markPrice: '20', proceeds: '400' }).markedGain,
    null,
    'no gain is shown for quantities without lots',
  );
});
