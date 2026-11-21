import {Decimal} from 'decimal.js';

// Constant-product (Uniswap v2-type) pools only. Fees are protocol constants; a pool whose protocol is not listed is
// never modelled. Reserves come from the chain (getReserves); CMC only finds and labels the pool.
export const V2_FEES:Record<string,string>={'uniswap-v2':'0.003','sushiswap-v2':'0.003','pancakeswap-v2':'0.0025'};

export type PoolState={protocol:string;reserveToken:string;reserveQuote:string;block?:number;at:string};

// Selling q tokens with transfer tax t (taken from the tokens sent in) into reserves x (token) and y (quote) at fee f:
// out = y·q(1−t)(1−f) / (x + q(1−t)(1−f)).
export function v2Out(pool:PoolState,quantity:string,tax='0'){
 const f=V2_FEES[pool.protocol];if(f===undefined)throw RangeError(`Not a modelled constant-product protocol: ${pool.protocol}`);
 const x=new Decimal(pool.reserveToken),y=new Decimal(pool.reserveQuote),q=new Decimal(quantity),t=new Decimal(tax);
 if(x.lte(0)||y.lte(0))throw RangeError('Pool reserves must be positive');if(q.lt(0)||t.lt(0)||t.gte(1))throw RangeError('Invalid quantity or tax');
 const effective=q.mul(new Decimal(1).minus(t)).mul(new Decimal(1).minus(f));
 return effective.isZero()?new Decimal(0):y.mul(effective).div(x.plus(effective));
}

export type Bridge={mark:string;proceeds:string;parts:{name:'reference'|'tax'|'fee'|'impact'|'route'|'residual'|'blocked';value:string}[]};

// Mark-to-proceeds bridge for the pool model, in the reporting currency. Every part is a value at the pool's spot price,
// so the parts add to mark − proceeds exactly:
//   reference = q·(mark price − spot·quote price)    tax = q·t·spot·quote price
//   fee = q(1−t)·f·spot·quote price                  impact = what remains: the price moved by the sale itself
export function v2Bridge(pool:PoolState,quantity:string,{markPrice,quotePrice,tax='0'}:{markPrice:string;quotePrice:string;tax?:string}):Bridge{
 const q=new Decimal(quantity),t=new Decimal(tax),f=new Decimal(V2_FEES[pool.protocol]??NaN),spot=new Decimal(pool.reserveQuote).div(pool.reserveToken).mul(quotePrice);
 const mark=q.mul(markPrice),proceeds=v2Out(pool,quantity,tax).mul(quotePrice);
 const reference=mark.minus(q.mul(spot)),taxCost=q.mul(t).mul(spot),fee=q.mul(new Decimal(1).minus(t)).mul(f).mul(spot);
 const impact=mark.minus(proceeds).minus(reference).minus(taxCost).minus(fee);
 return {mark:mark.toFixed(),proceeds:proceeds.toFixed(),parts:[{name:'reference',value:reference.toFixed()},{name:'tax',value:taxCost.toFixed()},{name:'fee',value:fee.toFixed()},{name:'impact',value:impact.toFixed()}]};
}

// A router or aggregator returns one price for the whole route, so fees and impact cannot be told apart. A small quote
// gives the route's reference price; everything else is the route cost. Nothing is invented to split it further.
export function routeBridge(quantity:string,{markPrice,quotePrice,proceedsOut,referenceOutPerToken}:{markPrice:string;quotePrice:string;proceedsOut:string;referenceOutPerToken:string|null}):Bridge{
 const q=new Decimal(quantity),mark=q.mul(markPrice),proceeds=new Decimal(proceedsOut).mul(quotePrice);
 if(referenceOutPerToken===null)return {mark:mark.toFixed(),proceeds:proceeds.toFixed(),parts:[{name:'residual',value:mark.minus(proceeds).toFixed()}]};
 const reference=mark.minus(q.mul(referenceOutPerToken).mul(quotePrice));
 return {mark:mark.toFixed(),proceeds:proceeds.toFixed(),parts:[{name:'reference',value:reference.toFixed()},{name:'route',value:mark.minus(proceeds).minus(reference).toFixed()}]};
}

// The largest sale whose execution price is within `impact` (e.g. 0.01) of the pool's spot price, fees included:
// price per token = out/q must stay ≥ spot·(1−impact). Solved in closed form from the v2 formula.
export function v2MaxSale(pool:PoolState,impact:string,tax='0'){
 const f=new Decimal(V2_FEES[pool.protocol]??NaN),k=new Decimal(1).minus(tax).mul(new Decimal(1).minus(f)),target=new Decimal(1).minus(impact);
 // out/q = y·k/(x+q·k) ≥ (y/x)·target  ⇔  q ≤ x·(k − target)/(k·target)
 const room=k.minus(target);if(room.lte(0))return '0';
 return new Decimal(pool.reserveToken).mul(room).div(k.mul(target)).toFixed();
}
