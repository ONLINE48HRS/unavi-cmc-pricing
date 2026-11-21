# unavi-cmc-pricing

Prices the long tail of a crypto portfolio with the [CoinMarketCap API](https://coinmarketcap.com/api/).

[UNAVI](https://unavi.ai) is a personal and family wealth terminal: bank accounts, brokers, exchanges and wallets in one reconciled ledger. Its crypto prices come from Binance spot markets, which cover the large coins well. A real wallet holds more than that: Solana memecoins, Cosmos tokens, small ERC-20s. Those used to show up as **unpriced**, which understates net worth.

This module fills those gaps with CoinMarketCap, and only those gaps:

1. **The primary source prices what it can** (Binance in UNAVI; any function you pass).
2. **Everything else is resolved to a CoinMarketCap ID by contract or mint address first**, because symbols are not unique: hundreds of tokens call themselves "PEPE". A symbol-only match takes the top-ranked active listing and says so.
3. **All the gaps are priced in one batched quote call**, so a wallet full of small tokens costs a few credits, not one per token.
4. **Every request and response is kept**, with a SHA-256 hash of the response, so each price can be traced to a real API call.

Prices stay exact: CoinMarketCap returns JSON numbers (tiny prices arrive as `1.23e-7`), and they are written out in full as decimal strings. Values are multiplied as exact decimals and never pass through floating point.

## Liquidity reality check (in development for Build with CMC, Round 2)

New for the hackathon: an engine that says what a holding is marked at, what selling it could realistically return, and what that does to the profit on the holder's own purchase lots. The pricing module above predates the event; everything in this section is new.

```
npx tsx demo/check-token.ts <ethereum|solana> <contract or mint> <quantity> [cost basis USD]
```

A real run (21 Nov 2026, Ethereum block 26461926, 5 billion PEPE with an illustrative $12,000 cost basis):

```
State: assessed (pool-model via uniswap-v2:0xa43fe16908251ee70ef74718545e4fe6c5ccec9f)
On screen: +$4,640.05 · After a realistic exit: +$4,579.47
Marked $16,640.05 · Estimated proceeds $16,579.47 (in the pool's quote token, not bank cash)
If the top holders sold first (75.9 trillion tokens, 10.3× DEX liquidity): proceeds $29.38
CoinMarketCap: 10 calls, 10 credits
```

- **Mark:** CMC listed quote, else CMC DEX price, each with its time. Older than 15 minutes is stale, and a stale or missing price is never shown as zero.
- **Exit, by where the token trades.**
  - On Ethereum, Uniswap v2 and SushiSwap pools found by CMC are priced with the constant-product formula from reserves read on-chain. A pool is used only when CMC's protocol name and factory agree, the pair's own `factory()` matches, and CMC's amounts are within 1% of the chain (they matched exactly on PEPE/WETH).
  - Uniswap v3 pools are quoted with QuoterV2.
  - On Solana, Jupiter's `/swap/v2/order` quotes the actual size.
  - The seller uses the single venue that pays most; venues are never combined.
- **Bridge from mark to proceeds:**
  - Pool model: reference difference, transfer tax, fee and price impact.
  - Route quote: reference difference and one route cost, because a router cannot separate fees from impact.
  - The parts always add up to mark minus proceeds exactly.
- **Ledger:** marked gain and execution-adjusted gain on the same FIFO lots, for every slider size (10/25/50/100%).
- **Security** (`/v1/dex/security/detail`):
  - No record means "not checked", never safe, and the position is not assessed.
  - Only a reported honeypot sets proceeds to zero.
  - Other reported risks are shown alongside the proceeds.
- **Holder overhang** (`/v1/dex/holders/list`):
  - Counts the top 10 holders, excluding pools, burn, exchange and locker wallets, each with its reason.
  - Compares their tokens with DEX liquidity, then prices the user's sale after they sell first. This is exact for a pool; for routes it is shown only when the two quotes are consistent.
- **Exchange-only holdings:** an indicative time to sell at 1%, 5%, 10% or 15% of CMC's exchange volume. This is labelled as a warning, never as proceeds.
- **Three states:** assessed, indicative or not assessed. Portfolio totals reconcile to the crypto mark. Two holdings selling into the same venue are moved out of the assessed total, not summed. Net worth is passed through unchanged.

Validation: `npx tsx scripts/validate-v2.ts` prices the same sales with the formula and with the Uniswap v2 router at one block (matched within one raw unit on PEPE/WETH). Tests use synthetic fixtures only; no recorded CoinMarketCap data is shipped here.

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
| `GET /v1/dex/token/price` | Mark for tokens without a listing; total DEX liquidity | 1 credit (measured) |
| `GET /v1/dex/token/pools` | Pool discovery: protocol, factory, both sides' amounts | 1 credit (measured) |
| `GET /v1/dex/security/detail` | Honeypot, sell tax, reported contract risks | 1 credit (measured) |
| `POST /v1/dex/holders/list` | Top 100 wallets, for holder overhang | 1 credit (measured) |

A full any-token check costs 8–10 credits. The DEX endpoints' credit costs are not documented; these were measured on the Basic plan.

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
npm test        # offline, synthetic fixtures
npm run typecheck
```

## What the API made possible, and where it got in the way

- **Made possible:** pricing tokens no centralised exchange lists, by address, in one batched call. The keyless public API meant the demo runs with no signup.
- **Got in the way:** v3 `quotes/latest` returns `quote` as an array, while v3 `quotes/historical` returns it as an object keyed by currency. `interval=daily` returns the first quote of the day, not the close, so you have to know to use `24h` from 23:59. Contract lookups go through the metadata endpoint (`info`); a dedicated address-to-ID lookup would be clearer.
- **Made possible (DEX API):** pool discovery with protocol and factory, contract security and holder lists for any token, all on the free plan. CMC's pool amounts matched on-chain reserves exactly, so CMC can find and label pools while the chain supplies the reserves.
- **Got in the way (DEX API):**
  - `security/detail` documents `sellTax` only as "Sell tax", with no unit. A non-zero value could be a fraction or a percentage, so it cannot be applied safely; such tokens stay not assessed unless a verified rate is supplied. The values of `honeypotStatus` are not documented either: we observed "Unknown" and act only on "Yes".
  - The DEX endpoints' credit costs are not documented. `token-liquidity/query` returned "Parameter error" with the documented optional parameters.
  - Holder history and exchange depth (`holders/trend/list`, `market-pairs/latest`) are not on the free plan.

## Licence

MIT. CoinMarketCap data is subject to [CoinMarketCap's terms](https://coinmarketcap.com/api/).
