# Stake tracking — what we learned the hard way

Handoff notes for anyone building reporting on LINGO staking. Everything below was
verified on-chain against Base mainnet (dates noted where numbers are involved).
The traps in §5 are the ones that produced *wrong numbers that looked right*.

---

## 1. Core addresses (Base mainnet)

| What | Address |
|---|---|
| LINGO token | `0xfb42da273158b0f642f59f2ba7cc1d5457481677` |
| Staking contract | `0x9aF8C0dac726CcEE2BFd6c0f3E21f320d42398AC` |
| Vesting contract | `0xAd11F733E401E16C72033c5DECAf05dcC0e1BEB8` |
| Vesting #2 (Decubate BeaconProxy) | `0x8001b2029782bbf1b3c85c3a23ecae60e3fa0447` |
| APY claim contract | `0x2f26621e931c32542579CF8860D7e8616DF32E0E` |
| Reward wallet (current) | `0xFfc781DDfA8D1358cE8C7DDa7cEd1e56e922aea6` |
| Reward wallet (previous, still used) | `0x64967c0DD5605Dd3Efc6a9BB148b2687a532c15F` |
| LINGO/WETH Uniswap **V3 pool** | `0x9399dA51C1a85e64CCe4b30B554875D2b89b2445` |
| LINGO/WETH Uniswap **V2 pair** | `0xb08fefa8f0f01b9a224fdef416e919b1ceba0d84` |
| Wormhole NTT bridge manager | `0x7c91bAca69ad289eC5De46B0b36287770a1Ea91e` |
| Buy-and-stake wallet (users send USDC) | `0x2Bd8Fc849F7c91ce2d3E9C78dD85792A0B14DA6D` |
| Stake-on-behalf operator wallet | `0x53A78a339262e374950C491884B0954323B616eF` |
| Team wallet (project-owned staker) | `0xe8313a4b7a6aaea9e92a8d4acbb08034cb39bf2f` |
| USDC (native, Base) | `0x833589fcD6eDb6E08f4c7C32D4f71b54bdA02913` |
| USDbC (bridged) | `0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA` |

Events:

```
Staked(address,uint256,uint256)   topic0 0x1449c6dd7851abc30abf37f57715f492010519147cc2652fbc38202c18a6ee90
                                  topics[1] = staker, data w0 = amount(1e18), data w1 = lock duration
ERC-20 Transfer                   topic0 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
Vesting Claimed(address,uint256)  topic0 0xc7798891864187665ac6dd119286e44ec13f014527aeeb2b8eb3fd413df93179
                                  no indexed params: data w0 = claimer, w1 = amount
```

---

## 2. Two thresholds, deliberately different

| | Alerts (`api/discord-alerts.ts`) | Reporting (`api/backfill-stake-sources.ts`) |
|---|---|---|
| Floor | **$100** | **$10** |
| Clamp on derived LINGO bar | 1k – 1M | 100 – 100k |
| Fallback when no price | 10,000 LINGO | 1,000 LINGO |
| Price basis | live price, cached 24h | **each stake priced at its own day** |

A floor on a ping is noise control; a floor on a report biases the answer. Measured
2026-09-16 over 7 days: **54 stakes ≥$100 vs 91 more in $10–100** — 63% of stakes were
invisible at the old floor while being only ~16% of the LINGO, and the small ones skew
toward APY claims and re-stakes. Do not "align" these two numbers.

Clamps must stay **below** the LINGO value of their own `MIN_USD`, or they silently
override it (a 1,000-LINGO floor would have overridden a $10 bar at ~$0.0137).

Backfills are nearly always historical, and LINGO moved **33% in one week**
(2026-08-25 $0.0105 → 2026-09-02 $0.0140), so pricing a historical window at today's
rate misclassified 3 of 5 realistic test cases, in both directions.

---

## 3. How a stake's source is decided

**Tier A — the stake transaction itself.** In order: funded-by-an-on-behalf-wallet →
swap event → claim event → the largest inbound LINGO leg (≥50% of the stake).

**Tier B — all inbound LINGO in the ~24h before the stake** (`PROV_WINDOW_BLOCKS`
43,200), grouped by sender and weighted **by value, not recency**, producing a `mix`.
The dominant source becomes primary; confidence tracks concentration.

Taking only the most recent transfer was wrong in the two commonest real shapes: a
small reward landing after a large unstake made the whole stake read "reward payout",
and "unstaked, then bought more" read as a pure re-stake with the buy invisible. On live
data **5 of 6 sampled stakes were genuinely mixed**.

---

## 4. Taxonomy (14 sources)

```
bought              bought straight from a LINGO pool or via a router/aggregator
bought_cex          withdrawn from a centralised exchange → they bought there
bought_direct       we bought and staked FOR the user (stake-on-behalf flow)
bridged             arrived via a bridge (Wormhole NTT, Relay, Across, …)
claimed_apy         APY reward claim contract
claimed_vesting     vesting contract (incl. mints from 0x0)
claimed             some other verified claim contract
reward              reward-wallet payout
restaked            came from the staking contract (unstaked → re-staked)
transferred         an ordinary wallet we cannot identify
transferred_bought_upstream   same, but that sender demonstrably bought on-chain
internal            a known project wallet
preheld             no inbound LINGO in the 24h window — they already held it
unknown             an unrecognised CONTRACT sent it (a real gap; do not guess)
```

Address tables currently: 8 pools, 32 routers/aggregators, 66 CEX wallets, 14 bridges,
8 project wallets, 4 claim contracts, 2 reward wallets, 1 on-behalf wallet.

---

## 5. Traps — each of these produced wrong numbers in production

1. **EIP-7702 delegated EOAs.** A delegated wallet's `eth_getCode` returns 23 bytes
   (`0xef0100` + implementation), *not* `0x`. Testing `code !== '0x'` treats ordinary
   user wallets as contracts. Six such wallets were **844 of 5,933 sampled transfers
   (14.2%)** — roughly one in seven inbound transfers was being reported as a bogus
   low-confidence "claimed". Detect with `code.startsWith('0xef0100')`.

2. **Mints from `0x0` are vesting claims.** The vesting contract mints to the claimer,
   so a token-transfer scan misses every claim and a `from == 0x0` transfer is not an
   anonymous sender. Zero-address is the single largest "sender" by volume. Read the
   contract's own `Claimed` event, not transfers.

3. **A DEX pool disguised as a project wallet.** `0x9399dA51…` was labelled "Liquidity"
   in the known-wallets map, so every buy out of the pool reported as "From project
   wallet". Its bytecode has `token0`/`token1`/`swap`/`slot0`/`fee`/`tickSpacing` — it is
   a Uniswap V3 pool. Check pools/routers/CEX/bridges *before* any generic wallet map.

4. **`0x7c91bAcA…` is a Wormhole NTT bridge**, not the "Upgradeable Distribution
   Contract" it is still called in `api/supply.ts`. LINGO from it was bridged in.

5. **Never match a token by name or symbol.** The buy wallet is under active address
   poisoning: a lookalike **"UṢDC"** (`0x6c9458b7…`, dotted Ṣ) arrives minutes after each
   real USDC transfer, sent from a vanity address copying the real sender's first *and*
   last characters, plus scam "claim" tokens whose events spoof the USDC contract as
   `from`. Filter on the **emitting contract address**, server-side, and re-check it.

6. **Print full addresses.** Poisoning works precisely because the fake is identical once
   truncated: real `0xc86486f1…fa76f38` vs fake `0xc86447b6…f3176f38`. Anyone copying an
   address out of that wallet's history can lose funds.

7. **Stake-on-behalf looks like nothing.** In the direct-buy flow the operator sends LINGO
   straight to the staking contract and the `Staked` event credits the *user*, so the
   user's wallet never receives LINGO and the stake falls through to **"pre-held"**. Detect
   it by looking at who paid the staking contract *in the stake tx*
   (tx `0x98439042…`, block 51,566,506). ~300K LINGO ran through this in one day.

8. **Project-owned stakes are in your user metrics.** `0xe8313a4b…` (funded by the Project
   Safe) staked 3.14M LINGO / ~$28K across 4 stakes in 120 days, all Flexible. Only 0.2%
   of stakes but a real share of LINGO, and it skews the lock-duration mix. Revenue is
   unaffected — revenue comes from MM capture / product / trading fees, never from stakes.

9. **Unrecognised contract ≠ claim.** Guessing "claimed" hides a gap. Report `unknown`
   with the address so it can be mapped.

10. **Dust and address-poisoning spam.** Ten spammer wallets account for 180k+ transfers
    worth almost nothing; unfiltered they dominate any by-count view. `PROV_DUST_LINGO`
    ignores <1 LINGO inbound; the USDC job ignores <$1.

11. **Verify exchange labels on-chain.** Several web-sourced "KuCoin / Gate / BitMart"
    addresses failed inspection (3 lifetime transactions; never touched LINGO). Confirmed
    useful ones: KuCoin `0x18b0f454…` (fan-out withdrawal wallet, holds 22.6M LINGO),
    MEXC `0x4e3ae00e…`, Gate `0x0d070796…`. Both KuCoin and MEXC were observed funding
    real stakers.

---

## 6. Reporting semantics that matter

- **Buckets are UTC days / Monday-anchored weeks.** Rolling windows ("last 7 days")
  extend **backwards** to the bucket boundary and say so in the label. Snapping *forward*
  silently drops data — at 00:05 UTC it shrank "last 24h" to five minutes.
- **Averages must use complete, fully-scanned buckets only**, or the numerator and
  denominator cover different spans.
- **A scan cut short is not a quiet day.** Paging runs newest-first, so the dropped part is
  always the older part. Render unscanned buckets as "not scanned", exclude them from
  averages, and report the range actually covered — not the range requested.
- **Mixed-funding attribution:** LINGO/USD count only the selected type's share.
  A stake counts as that type at ≥50% of its funding (`MAIN_SHARE`); smaller shares are
  tallied separately as "partly"; below 0.5% (`MIN_SHARE`) is ignored, otherwise a tiny
  reward share creates phantom "reward stakes".
- Limits: `MAX_DAYS` 190 per request; daily lists switch to weekly past 62 buckets.

---

## 7. Data-source notes (Alchemy, Base)

- `eth_getLogs` returns a real **`blockTimestamp` per log** — use it instead of
  interpolating block→time, and it removes bucket-boundary drift entirely.
- `Math.min(...arr)` **overflows the call stack** at ~100k+ logs. Use a loop.
- Prices: `POST /prices/v1/{key}/tokens/by-address` (live) and `/tokens/historical`
  (daily series, `interval=1d`, max 1yr). `value` is a **string**.
- Base blocks are ~2s, but never estimate a block from a timestamp over a long range and
  then trust it — filter by real timestamps.
- Cost: measured 2026-09-17 the whole Alchemy account ran ~1.0–1.5M CU/day ≈ $0.45–0.70.
  This dashboard was 49% of it; the Lingo backend, GachaMachine and frontend the rest.
  Rescanning all history per request is what gets expensive: the vesting endpoint went
  from 121 `eth_getLogs` to **1** by keeping per-bucket totals in Blob with the last block
  scanned (cursor deliberately 100 blocks behind head, so a tip reorg isn't baked in).

---

## 8. Where things live

```
api/backfill-stake-sources.ts   the classifier + per-stake JSON/CSV  (single source of truth)
api/discord-alerts.ts           2-min cron, Discord + Slack stake alerts (classifier inlined AGAIN)
api/slack-stake-report.ts       /stake-report and /stake-breakdown
api/monthly-stake-report.ts     1st-of-month digest
api/lingo-buys.ts               2-min cron, USDC buys → #lingo-buys
api/vesting-claims.ts           weekly/monthly vesting claims (Blob-cached, incremental)
```

Vercel `api/` functions **cannot import shared local modules** — helpers are duplicated on
purpose. After touching the classifier, diff the two copies of `provClassifySender` and
`classifyProvenance`; they must stay byte-identical. The threshold constants are
intentionally *not* identical.

**Adding a source or an address requires three edits**, and only the first is type-checked:

1. `ProvenanceSource` + `PROV_LABELS` in **both** classifier copies.
2. `SOURCE_ORDER` + `SOURCE_LABELS` in `slack-stake-report.ts` **and**
   `monthly-stake-report.ts` — untyped, and a missing `SOURCE_ORDER` entry silently drops
   that source from every summary.
3. `TYPE_ALIASES` in `slack-stake-report.ts` if it should be selectable in
   `/stake-breakdown`.

Useful without posting anything:

```
/api/backfill-stake-sources?days=7&limit=200&format=json      per-stake rows + summary + subs
/api/slack-stake-report?text=dex daily aug 14 to sep 14       renders the exact Slack blocks
/api/lingo-buys?dryRun=1                                      buys the job can see
```
