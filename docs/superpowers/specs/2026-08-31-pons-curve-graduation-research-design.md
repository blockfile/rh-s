# Pons Curve Graduation — Research Analyzer

**Date:** 2026-08-31
**Status:** design approved, not yet implemented
**Scope:** research only. No keys, no execution, no live trading.

## 1. Why

The `rh-sniper` bot in this repo buys at `launchBlock + 1` on the Pons V3/WETH
factory. Measured on-chain, that strategy loses money on the bonding-curve
venue: on the SPACEINU launch, nine buyers landed inside a single EVM block,
took 23.83% of supply, and netted between **+0.0034 and −0.0164 ETH**. The
venue defends itself with a decaying snipe tax (`snipeTaxStartBps = 9900`,
`snipeTaxSeconds = 3`), confirmed by direct call.

Over the same launch, a three-wallet cluster that entered **25 minutes late**
at 3x the launch price and sold into the graduation migration made
**+0.0714502 and +0.0878125 ETH** — verified two independent ways, to the wei.

This project determines whether that graduation trade is a repeatable edge or
a single lucky observation.

## 2. The question

**What is the best entry point on a curve's funding path, if any?**

Not "which curves graduate". A curve at 75% funded is a near-certain
graduation; the real question is whether entering that late leaves enough of
the move to pay for the ones that die. Creation-time features are secondary.

## 3. Non-goals

- No live trading, order execution, private keys, or wallet management.
- No UI. Output is JSONL plus a text report.
- If the edge validates, execution is a **separate** project with its own spec.

## 4. Established facts

All verified on-chain during design; none are assumptions.

| Fact | Value |
|---|---|
| Chain | Robinhood Chain, id 4663, Arbitrum Orbit, 100ms blocks |
| Chain age | ~58 days (genesis ~2026-07-04) |
| `block.number` | = L1 block (`l1BlockNumber`), ticks ~12s, NOT the RPC height |
| Curve registry | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` |
| Creation event | `0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607` |
| Graduation event | `0xcdb72f157fd3666758a6ce201387ffb52038c7562e4fff352828da1096c4b6b4` (token indexed) |
| Post-grad pair events | `0xa0a18f5b…`, `0x0a44ef75…` fire ~4 blocks later |
| `CurveBuy` | `0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455` — 2 indexed (buyer, recipient), 4 data words (quoteIn, tokensOut, fee, tax) |
| `CurveSell` | `0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df` |
| `SnipeTaxCharged` | `0x3bc39a5562b28f5fe8f36cecabfbaa12bb969acf05717994709225fc412a9934` |
| Snipe tax | `snipeTaxStartBps = 9900`, `snipeTaxSeconds = 3` |
| Aggregator (1% fee) | `0x65050A9b7E5075A2bA5cED7b1b64EE66262c40Dc`, selector `0x4d819a2a` |
| Graduation base rate | **1.545%** — 349 of 22,590 creations in 24h |
| Post-graduation venue | Uniswap V4 PoolManager `0x8366a39CC670B4001A1121B8F6A443A643e40951` |

### Hard constraints

- **No archive state.** Historical `eth_call` / `eth_getCode` fail. Every
  feature must be derivable from **logs alone**.
- **`eth_getLogs` caps at 10,000 logs per response, silently.** Truncation is
  not an error. Chunking must subdivide on any near-limit response.
- **Block span limit** between 100k and 1M. Use <= 90k and subdivide.
- No `trace_*` / `debug_*` methods.
- Curve trades are emitted by per-curve contracts. Scanning 158k contracts
  individually is infeasible; sweep **chain-wide by topic0, no address filter**.

## 5. Architecture

Four stages, each resumable, each writing to disk so it can be re-run alone.

```
collector  ->  builder  ->  features  ->  backtest
 raw logs      cohort      predictors     P&L
```

Location: `research/` in this repo. Shares chain constants with the sniper,
nothing else.

### 5.1 collector

Sweeps three streams to JSONL with a checkpoint file for resume:

- `creations.jsonl` — registry creation events
- `graduations.jsonl` — registry graduation events
- `trades.jsonl` — chain-wide `CurveBuy` / `CurveSell` / `SnipeTaxCharged`

Adaptive chunking: start at 30k blocks; on any response with >= 9,900 logs,
halve and retry. Record per-chunk log counts so truncation risk is auditable
after the fact.

### 5.2 builder

Joins raw logs into one record per token (`cohort.jsonl`):

- **identity** — token, curve, creator, pairToken, `graduationThreshold`,
  createdAt (RPC block, l1Block, timestamp)
- **outcome** — `graduated: bool`, graduationBlock, timeToGraduation
- **series** — ordered trades with `(block, ts, buyer, quoteIn|quoteOut,
  tokens, cumulativeFunding, fundingPct)`

`fundingPct = cumulativeFunding / graduationThreshold` is the spine of the
whole analysis.

### 5.3 features

Snapshots each curve at fixed **times** (t+30s, +2m, +10m) and at fixed
**funding levels** (10 / 25 / 50 / 75%):

dev buy size; distinct buyers; buy count; quote volume; buy velocity;
largest single buy; quote asset; creator's prior launch count and prior
graduation rate.

### 5.4 backtest

Simulates an entry rule across the **full cohort**.

**Every position the rule would have opened is counted.** This is the entire
point of the design and the one thing that must not be compromised.

A curve that never graduates is **not** worth zero — it can still be sold back
into the curve. Non-graduating positions exit on a timeout (default 6h after
entry, configurable) at the prevailing curve price implied by the last observed
trade, net of the 100bps curve fee. A curve with no trades after entry exits at
the entry-time curve price, which after fees is a small loss, not a wipeout.
Reporting zero here would overstate losses as badly as ignoring them would
understate them.

Costs modelled: 1% aggregator fee, 100bps curve fee, snipe tax when inside 3s,
gas. Reports trades taken, hit rate, gross and net P&L, return distribution,
max drawdown, and a sweep across entry thresholds.

## 6. Fill model

Prices come from the curve's own trade logs: `quoteIn / tokensOut` gives a
realized price per trade. A hypothetical fill is priced against curve state at
that moment **including our own market impact**, never at the observed price.

At 0.05–0.2 ETH this is material. Assuming impact away is the easiest way to
manufacture a profitable backtest that does not exist.

## 7. Testing

**Golden record — SPACEINU `0xa75262b1c9cd4ceb50bb944c5209f42f649ebca8`.**
Fully characterised during design: launch at RPC 50039507 / l1 25868338,
graduation at RPC 50088315, complete trade series.

The assertion is the **curve leg only** — accumulate on the curve, sell into
the graduation squeeze — because that is the strategy under test and the only
part this pipeline collects:

| wallet | curve-leg P&L |
|---|---|
| A `0xf127a538…` | **+0.0627638 ETH** |
| B `0x9085e1ab…` | **+0.0726503 ETH** |

Their full-lifetime figures (+0.0714502 / +0.0878125) additionally include a
post-graduation Uniswap V4 scalp and a late V4 round trip. **V4 swap data is
out of scope for v1** — collecting it would mean a fourth log stream off the
PoolManager singleton, and the graduation trade does not depend on it. If the
edge validates and the post-graduation leg looks worth modelling, that is a
scope extension with its own decision, not a silent addition.

Unit tests: chunk subdivision under the 10k cap, collector resume, funding-%
math, snipe-tax application inside/outside the 3s window.

## 8. Rollout

1. Collect **3 days** (~68k creations, ~1,000 graduations) and iterate.
2. Validate against the golden record.
3. Extend to 7+ days once the pipeline is stable.

Estimated 30–60 min per sweep, a few hundred MB.

## 9. Risks

- **Curve event uniformity.** Signatures are confirmed on one curve
  (SPACEINU's). If other curve versions differ, the chain-wide sweep needs
  per-version handling. Check topic0 counts against creation counts early; a
  large mismatch means non-uniform curves.
- **Silent truncation.** Mitigated by subdivision, but a bug here corrupts
  everything downstream invisibly. Per-chunk counts are logged for audit.
- **Survivorship bias.** Structurally prevented by the full-cohort rule in 5.4.
- **Exit-timeout sensitivity.** The 6h default for non-graduating positions is
  a guess, not a measurement. The backtest must report results across several
  timeouts; if the sign of the P&L flips with the timeout, the edge is an
  artefact of that parameter rather than a real effect.
- **The likely outcome is no edge.** A negative result is a valid and useful
  deliverable, and the design must be able to produce one.
