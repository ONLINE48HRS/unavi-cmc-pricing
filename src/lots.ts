import { Decimal } from 'decimal.js';

// A purchase lot as the ledger records it. cost is the full acquisition cost in the reporting currency, fees included.
export type Lot = { id: string; acquiredAt: string; quantity: string; cost: string };
export type LotSlice = { id: string; acquiredAt: string; quantity: string; cost: string };

// The lots a sale of `quantity` would consume under FIFO, oldest first. A lot only partly used contributes cost in
// proportion to the quantity taken from it. `covered` is false when the lots hold less than the quantity sold; the basis
// then covers only what the lots hold and the caller must not present a gain for the rest.
export function fifoSlice(lots: Lot[], quantity: string) {
  let left = new Decimal(quantity);
  if (left.isNegative()) throw RangeError('Quantity sold cannot be negative');
  const ordered = [...lots].sort(
      (a, b) => Date.parse(a.acquiredAt) - Date.parse(b.acquiredAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    ),
    slices: LotSlice[] = [];
  let basis = new Decimal(0),
    held = new Decimal(0);
  for (const lot of ordered) {
    if (left.isZero()) break;
    const q = new Decimal(lot.quantity);
    if (q.lte(0)) continue;
    const take = Decimal.min(q, left),
      cost = new Decimal(lot.cost).mul(take).div(q);
    slices.push({ id: lot.id, acquiredAt: lot.acquiredAt, quantity: take.toFixed(), cost: cost.toFixed() });
    basis = basis.plus(cost);
    held = held.plus(take);
    left = left.minus(take);
  }
  return { quantity: held.toFixed(), basis: basis.toFixed(), slices, covered: left.isZero() };
}

// Marked gain and execution-adjusted gain on the SAME lots, so the two are comparable at any slider position.
export function gains({
  lots,
  quantity,
  markPrice,
  proceeds,
}: {
  lots: Lot[];
  quantity: string;
  markPrice: string;
  proceeds: string | null;
}) {
  const slice = fifoSlice(lots, quantity),
    mark = new Decimal(slice.quantity).mul(markPrice);
  if (!slice.covered)
    return { ...slice, mark: mark.toFixed(), markedGain: null, adjustedGain: null, flipsToLoss: false };
  const markedGain = mark.minus(slice.basis),
    adjustedGain = proceeds === null ? null : new Decimal(proceeds).minus(slice.basis);
  return {
    ...slice,
    mark: mark.toFixed(),
    markedGain: markedGain.toFixed(),
    adjustedGain: adjustedGain?.toFixed() ?? null,
    flipsToLoss: Boolean(adjustedGain && markedGain.gt(0) && adjustedGain.lt(0)),
  };
}
