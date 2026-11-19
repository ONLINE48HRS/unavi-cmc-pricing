# unavi-cmc-pricing

Prices the long tail of a crypto portfolio with the [CoinMarketCap API](https://coinmarketcap.com/api/).

[UNAVI](https://unavi.ai) is a personal and family wealth terminal: bank accounts, brokers, exchanges and wallets in one reconciled ledger. Its crypto prices come from Binance spot markets, which cover the large coins well. A real wallet holds more than that: Solana memecoins, Cosmos tokens, small ERC-20s. Those used to show up as **unpriced**, which understates net worth.

This module fills those gaps with CoinMarketCap, and only those gaps:

1. **The primary source prices what it can** (Binance in UNAVI; any function you pass).
2. **Everything else is resolved to a CoinMarketCap ID by contract or mint address first**, because symbols are not unique: hundreds of tokens call themselves "PEPE". A symbol-only match takes the top-ranked active listing and says so.
3. **All the gaps are priced in one batched quote call**, so a wallet full of small tokens costs a few credits, not one per token.
4. **Every request and response is kept**, with a SHA-256 hash of the response, so each price can be traced to a real API call.

Prices stay exact: CoinMarketCap returns JSON numbers (tiny prices arrive as `1.23e-7`), and they are written out in full as decimal strings. Values are multiplied as exact decimals and never pass through floating point.

## Run the demo

```
npm install
npm run demo                               # keyless public API
CMC_API_KEY=your-key npm run demo          # with a key: higher limits, full catalogue
npm run demo -- path/to/holdings.json      # your own holdings
```

A real run (keyless, 18 Nov 2026):

```
Token    Amount           Price (USD)        Value (USD)        Source
SOL      2.5              74.58              186.45             Binance
...
MNDE     900              0.0195447987866405 17.590318907976495 CoinMarketCap #13803 (symbol)
         Matched by symbol only (Marinade). Add the contract address to be sure.
NOTREAL  1                —                  —                  unpriced
         Not listed on CoinMarketCap

7 priced by Binance, 1 filled by CoinMarketCap, 1 unpriced. CoinMarketCap: 3 calls, 2 credits.
```

Each run saves its requests and responses to `evidence/`. The API key is sent only in the `X-CMC_PRO_API_KEY` header and is never logged or written.

## CoinMarketCap endpoints used

| Endpoint | Used for | Cost |
|---|---|---|
| `GET /v2/cryptocurrency/info?address=` | Resolve a contract or mint address to a CMC ID | 1 credit per 250 assets |
| `GET /v1/cryptocurrency/map?symbol=` | Fall back to a symbol when no address is known | no credit |
| `GET /v3/cryptocurrency/quotes/latest?id=` | Current price for every gap, batched 100 per call | 1 credit per 250 assets |
| `GET /v3/cryptocurrency/quotes/historical?interval=24h` | One close per UTC day (the quote nearest 23:59 UTC) | 1 credit per 100 points |

Daily history is clamped to what the plan allows (Basic: one year), and the clamp is reported, never guessed. Without a key, the client uses CMC's keyless public API (`/public-api/...`). A `429` waits as long as `Retry-After` asks, then retries.

## Use it

```ts
import {cmcClient,priceHoldings,dailyCloses} from 'unavi-cmc-pricing';

const client=cmcClient({apiKey:process.env.CMC_API_KEY});
const rows=await priceHoldings(client,holdings,asset=>myPrimaryPrice(asset));
const {closes}=await dailyCloses(client,29210,'2026-01-01','2026-11-17',{historyDays:365});
console.log(client.credits(),client.calls);   // what it cost, and the evidence
```

## Tests

```
npm test        # offline, recorded responses
npm run typecheck
```

## What the API made possible, and where it got in the way

- **Made possible:** pricing tokens no centralised exchange lists, by address, in one batched call. The keyless public API meant the demo runs with no signup.
- **Got in the way:** v3 `quotes/latest` returns `quote` as an array, while v3 `quotes/historical` returns it as an object keyed by currency. `interval=daily` returns the first quote of the day, not the close, so you have to know to use `24h` from 23:59. Contract lookups go through the metadata endpoint (`info`); a dedicated address-to-ID lookup would be clearer.

## Licence

MIT. CoinMarketCap data is subject to [CoinMarketCap's terms](https://coinmarketcap.com/api/).
