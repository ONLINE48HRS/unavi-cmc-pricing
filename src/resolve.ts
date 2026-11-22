import { CmcError, type CmcClient } from './client.ts';

export type Asset = { symbol: string; address?: string };
export type Resolved = {
  id: number;
  symbol: string;
  name: string;
  slug: string;
  by: 'address' | 'symbol';
  ambiguous: boolean;
};

const key = (a: Asset) =>
  a.address
    ? `address:${a.address.startsWith('0x') ? a.address.toLowerCase() : a.address}`
    : `symbol:${a.symbol.toUpperCase()}`;

// Symbols are not unique (hundreds of tokens call themselves "PEPE"), so a contract or mint address wins whenever we have one.
// A symbol-only lookup takes the highest-ranked active listing and says it was ambiguous.
export function resolver(client: CmcClient) {
  const cache = new Map<string, Resolved | null>();
  async function byAddress(address: string): Promise<Resolved | null> {
    const want = address.startsWith('0x') ? address.toLowerCase() : address;
    let body: any;
    try {
      body = await client.get('/v2/cryptocurrency/info', { address: want, aux: 'platform' });
    } catch (error) {
      if (error instanceof CmcError && error.status === 400) return null;
      throw error;
    }
    const coins = Object.values(body?.data ?? {}) as any[];
    const match =
      coins.find((c) => {
        const t = String(c?.platform?.token_address ?? '');
        return (t.startsWith('0x') ? t.toLowerCase() : t) === want;
      }) ?? (coins.length === 1 ? coins[0] : undefined);
    return match
      ? {
          id: Number(match.id),
          symbol: match.symbol,
          name: match.name,
          slug: match.slug,
          by: 'address',
          ambiguous: false,
        }
      : null;
  }
  async function bySymbol(symbol: string): Promise<Resolved | null> {
    let body: any;
    try {
      body = await client.get('/v1/cryptocurrency/map', { symbol: symbol.toUpperCase() });
    } catch (error) {
      if (error instanceof CmcError && error.status === 400) return null;
      throw error;
    }
    const coins = ((body?.data ?? []) as any[])
      .filter((c) => c?.is_active !== 0)
      .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
    return coins[0]
      ? {
          id: Number(coins[0].id),
          symbol: coins[0].symbol,
          name: coins[0].name,
          slug: coins[0].slug,
          by: 'symbol',
          ambiguous: coins.length > 1,
        }
      : null;
  }
  return async function resolve(asset: Asset): Promise<Resolved | null> {
    const k = key(asset);
    if (cache.has(k)) return cache.get(k)!;
    const found = asset.address ? await byAddress(asset.address) : await bySymbol(asset.symbol);
    cache.set(k, found);
    return found;
  };
}
