# Who is buying LINGO, and why — research findings

Recommendation only. Nothing has been built. Measured over **2026-08-24 → 2026-09-23**
(30 days), against a single denominator so every bucket is comparable.

Six parallel investigations produced a method and a split; an adversarial critic then
re-checked it on-chain and found two real errors. **The numbers below are the corrected
ones** — where the raw synthesis and the critic disagreed, the correction is noted inline.

---

## 1. Headline

> **Product demand is 16–30% of buy volume. Trading is ~58–65%. About 5% is unattributed.**

The range is not measurement error — it is one definitional question:

| Definition of "product demand" | Share | USD |
|---|---|---|
| Bought **through our product** (pays the treasury fee in the buy tx) | **15.6%** | $16,972 |
| …plus bought anywhere **and then staked** | **29.6%** | $32,232 |
| …and still holding at window close | ~25.9% | — |

Pick one and publish it with the components shown. I'd publish **29.6% with the split
visible**, because "bought and staked" is product demand by any reasonable reading, but
the 15.6% is the number that survives the strictest challenge.

---

## 2. The denominator

**8,244,086 LINGO / $108,999 / 2,547 buy legs / 2,541 txs / 238 distinct buyers.**

A "buy" is a LINGO transfer *out of one of our pools* in a tx that also emits a pool
`Swap`. That Swap filter matters: without it you pick up 114 LP-withdrawal legs
(117,668 LINGO, 1.4%) leaving the V3 pool via the NonfungiblePositionManager, which are
not buys at all. Two independent pulls (Dune `erc20_base.evt_Transfer` and a raw
`eth_getLogs` pass) agree to the wei.

Two facts worth internalising:

- **Only 2 of 8 pools traded.** V3 0.3% `0x9399da51…` is 8,358,797 LINGO; the V2 pair is
  2,956. The 1% pool and all four Aerodrome pools moved **zero** LINGO in 30 days.
- **The market is 238 wallets.** Top 1 = 28.6%, top 5 = 53.6%, top 25 = 87.3%. Any
  conclusion about "demand" is really a statement about a few dozen addresses.

---

## 3. Buyer attribution: net-delta, not `tx.from`

Inside each buy tx, sum LINGO per address, drop the pools, take the largest positive net.

- `tx.from` is **wrong on 61.5% of volume** — it is the router, the bot operator or an
  ERC-4337 bundler, not the buyer.
- The immediate transfer recipient is wrong on 22.4%.
- It resolves all 50 ERC-4337 legs (226,264 LINGO) with no UserOperation decoding —
  28 distinct bundlers fronting 22 smart accounts.

**Correction from the critic:** the claim that "pass-through routers net to zero, so no
router allow-list is needed" is **false as stated**. A fee-taking intermediary retains a
cut and therefore nets *positive* — `0x32347bba…` kept 1.445% in one verified tx and would
be named as the buyer. Net-delta is still much better than `tx.from`, but it needs a
known-intermediary check on top. This matters for **19.8% of volume**, which passes through
intermediaries in neither `PROV_ROUTERS` nor the buyer set — chiefly `0x32347bba…` (6.1%)
and `0x8f10b468…` (5.6%). Those are real gaps in our router table.

---

## 4. Precedence (a buy matches several buckets — first match wins)

1. **Our market maker** — allow-list only: holds `INTERNAL_ROLE` (`hasRole`, one `eth_call`,
   exact) or treasury-funded. Never behavioural.
2. **Bridged to Solana** — buyer is the Wormhole NTT manager, or sends ≥50% of the buy to it.
3. **CEX–DEX arbitrage** — sent ≥30% of the buy to a known exchange wallet, terminal net
   ≈ 0, never staked.
4. **MEV / atomic same-block** — *per leg*, not per buyer.
5. **Product — treasury fee** paid inside the buy tx, rate within 0.4–3%.
6. **Product — staked** ≥50% of what was received.
7. **Third-party principal trader** — two-way, round-trip ratio ≥0.5, outflow returns to a pool.
8. **Activity floor** for rules 3 and 7: ≥20 trades or ≥5 active days.
9. **Short-term trader / holder** — "none of the above", a weak claim; don't dress it up.
10. **Unattributed** — report it, never pad it.

Two rules that are easy to get wrong:

- **Exclude staking transfers from a wallet's "sold" total.** Forgetting this moved the
  round-tripper share from 67.5% to 89.0% — it misreads every product buyer who staked as
  a seller.
- **Freeze nothing until 7 days after the window.** The team's own example `0x8f6a5b5e…`
  reads as a pure accumulator *only* because its five sales landed on 2026-09-23, one day
  past the cut.

---

## 5. The split (corrected)

| Bucket | LINGO | USD | Share | Confidence |
|---|---:|---:|---:|---|
| Third-party principal trader (`0x278d858f…`) | 2,359,611 | $31,198 | 28.6% | volume high, label medium |
| CEX–DEX arbitrage (8 EOAs → KuCoin/MEXC/Gate) | 1,304,119 | $17,242 | 15.8% | high (a floor) |
| Product — bought through our product (fee) | 1,283,690 | $16,972 | 15.6% | high |
| Product — bought then staked, no fee | 1,154,172 | $15,260 | 14.0% | medium |
| Other two-way desks, no venue evidence | 623,210 | $8,240 | 7.6% | low (shape only) |
| Short-term traders and holders | 579,227 | $7,658 | 7.0% | low |
| Bridged to Solana, buyer unidentified | 522,770 | $7,239 | 6.3% | medium |
| MEV / atomic same-block | 3,088 | $41 | 0.04% | high |
| **Unattributed** | 414,199 | $5,449 | **5.0%** | — |

**Correction from the critic (−4.2pp):** the synthesis reported Solana at 871,670 LINGO
(10.6%) by adding the NTT manager's 28 inbound legs to a feeder wallet's 17 legs and
declaring them disjoint because the counts differ. The 17 are *inside* the 28. Corrected to
522,770, and relabelled — it is a **venue** label, not an intent label. Unattributed rises
from a suspiciously tidy 0.79% to 5.0%, which also shows the danger of a residual plug:
it absorbed the double count silently.

Treat the last three low-confidence rows honestly: **~5% is unattributed and a further
~15% rests on behavioural shape rather than positive evidence.**

---

## 6. What each signal is actually worth

- **Denominator ~99%.** Reproducible to the wei. *But* the critic found the block range is
  misaligned by 3–4 hours at both ends — it was computed as `days × 43,200` rather than
  resolved from timestamps. Two methods agreeing on the wrong interval proves
  reproducibility, not accuracy. **Resolve window blocks by timestamp.**
- **Our MM = 0% is true of the allow-list, unknown of reality.** Both whitelisted wallets
  have never moved a single LINGO. That is not "the desk didn't buy".
- **Treasury-fee marker ~90% precision, unknown recall.** Band-limiting to 0.4–3% is what
  earns it; any-positive-fee catches 21.7% but its tail includes a "74% fee rate", which is
  coincidental treasury traffic. **Nobody internal has confirmed this fee path exists.**
- **Stake marker ~95% precision.** Unambiguous; the risk is definitional.
- **CEX arb ~95% precision, ~70% recall** — 15.8% is a **floor**, true range 16–25%.
  1-hop arbitrage (buy → own second wallet → CEX) adds a measured upper bound of 3.6%.
- **MEV ≈ 0 is a solid negative result.** No sandwich bot appeared across 3,657 txs.
- **USD column ±2.6% monthly**, worse per day: LINGO-daily-close gives $108,999, the WETH
  actually paid into the pools gives $111,886.

---

## 7. Blind spots

- **Delta-neutral trading that never moves tokens is invisible.** A desk holding inventory
  on both Base and a CEX has no on-chain CEX leg at all.
- **`0x278d858f…` is 28.6% of buy volume and we don't know whose it is.** Its bytecode is an
  owner-gated proxy (owner `0xe2963654…` hardcoded), it holds no `INTERNAL_ROLE`, turnover
  0.98, active 26 of 30 days — and **our own table calls it "a swap router"**.
- **Solana-side sales are out of reach.** Bridged LINGO sold on a Solana venue is
  economically CEX arbitrage but shows here only as a bridge transfer.
- **The multi-buyer tie-break is unaudited** — 233 legs (22.2% of volume) have more than one
  positive-net address and "take the largest" has never been checked.
- **Everything rests on 2 pools and 3 exchanges.** 63 of our 66 CEX wallets saw zero LINGO.
  One new listing or pool changes the picture.

---

## 8. Cost

**~660 Alchemy calls / ~15,300 CU for a cold month; ~100–150 calls warm.** Under $0.01
either way. One `eth_getLogs` pull of LINGO transfers yields pool outflows, CEX deposits,
CEX withdrawals and staking transfers — four buckets for the price of one.

*Correction:* the synthesis compared this to "1.0–1.5M CU/day"; actual account usage is
**~313k CU/day (9.4M over 30 days, $4.23)**. The run is still negligible. Also note the
claim that the backfill could run on Dune for free is wrong — `api/refresh-dune.ts` only
*reads* cached query results; it cannot execute new queries.

---

## 9. Recommended build order

- **Phase 0 (half a day, do first):** fix the table bugs. Remove `0x278d858f…` from
  `PROV_ROUTERS` — it is a directional bot, not a router, and mislabelling it also affects
  stake provenance. Add `0x32347bba…` and `0x8f10b468…` as intermediaries.
- **Phase 1 (1 day):** a scratch script, not an endpoint. One per-buy CSV: tx, block, buyer
  (net-delta), LINGO, USD, treasury fee, staked flag. ~10 Alchemy calls.
- **Phase 2 (1 day):** precedence rules 1–4 as pure joins against existing tables.
- **Phase 3 (half a day):** the product rows — and **ask the product team to confirm the fee path**.
- **Phase 4 (half a day):** make it resumable, checkpointing like `api/lingo-buys.ts`.
- **Phase 5:** the 7-day lookahead before freezing any classification.
- **Phase 6:** only then a monthly cron, after two months have been run by hand.

**Do not build:** a price-spread classifier (the pool-vs-CEX basis exceeds 1% in 36.7% of
random minutes, and CEX-above-pool is a coin flip at 51%); a hardcoded arb/MM wallet list
(all 8 arb wallets first appeared on or after 2026-08-27, 6 of 8 lived ~9 days); the
reverse CEX leg as a bucket boundary (no plateau — 6.2% at 5min rising steadily to 10.7%
at 7 days); and never net raw CEX deposits against buy volume — Gate received 8.57M LINGO
in the window, 140% of total buy volume, mostly unrelated traffic.

---

## 10. Two questions before any code

1. **To the trading desk:** do you recognise `0xe2963654c2d243c52ebc6998b5a40eb5d2cd5658`?
   It is hardcoded as owner in the bytecode of `0x278d858f…`, which is **28.6% of the
   month's buy volume**. Also: please give us the desk's *complete* wallet list — both
   whitelisted wallets have never moved any LINGO, so "our MM bought 0" is currently a
   statement about an empty allow-list.
2. **To the product owner:** is the LINGO fee to the treasury inside a buy tx (median 1.25%)
   really our in-app purchase path? That single marker carries the 15.6% product-demand row.

Both answers are free and could move 28.6% and 15.6% of the split respectively. They are
worth more than any further on-chain work.
