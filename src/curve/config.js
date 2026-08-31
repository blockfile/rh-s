'use strict';

// Every number here came from measurement on this chain. Where a value is a
// judgement call rather than an observation, the comment says so.

require('dotenv').config();

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const str = (v, d) => (v === undefined || v === '' ? d : v);
const bool = (v, d) => (v === undefined || v === '' ? d : v === 'true' || v === '1');

module.exports = {
  rpcUrl: str(process.env.RPC_URL, 'https://rpc.mainnet.chain.robinhood.com'),
  // Push beats polling by a whole round trip, and there IS a websocket on this
  // chain even though the official docs only list HTTP. Measured from Asia:
  // official HTTP 282ms median, publicnode HTTP 150ms. Set this and detection
  // stops costing a request at all.
  // Measured from Asia: official HTTP 240ms median, publicnode 155ms, and
  // publicnode also serves websockets. arrowrpc returns 530 and is dead.
  //   WS_URL=wss://robinhood-rpc.publicnode.com
  //   RPC_URL=https://robinhood-rpc.publicnode.com
  wsUrl: str(process.env.WS_URL, ''),
  chainId: num(process.env.CHAIN_ID, 4663),
  privateKey: str(process.env.PRIVATE_KEY, ''),

  // ── the trade ─────────────────────────────────────────────────────────────
  // 0.07-0.09 ETH is the only band both measurements agree on. The 10-wallet
  // farm that made +8.89 ETH on 17.6 staked runs ~0.08. Below that the
  // evidence conflicts: one operator at 0.066 made +2.0 ETH while its twin at
  // 0.0297 was NEGATIVE (t=-0.50), yet a separate sweep found ROI flat from
  // 0.005 up. Until that is settled, do not shrink the ticket to fit more
  // slots. Above the band ROI decays with your own impact: 12.5% at 0.1 ETH,
  // 6.4% at 0.5, 2.4% at 1.0.
  buyEth: str(process.env.CURVE_BUY_ETH, '0.08'),

  // Floor on tokens received, in bps off the modelled output.
  //
  // 7500 == accept down to 25% of the modelled tokens. This is a
  // CONFISCATION GUARD, not a price guarantee, and it is sized from measured
  // outcomes rather than from trusting the model.
  //
  // The curve charges a snipe tax of up to snipeTaxStartBps = 9900, i.e. it
  // keeps 99% of the input. Measured across live buys by fill delay, for
  // non-deployer buyers:
  //
  //   +0-1  blocks   n= 41   max cost  1.00%   safe
  //   +2-10 blocks   n= 43   max cost 99.00%   3 of 43 CONFISCATED
  //   +11-30 blocks  n=159   max cost 11.19%
  //   +100+ blocks   n=1359  max cost  3.00%
  //
  // Two live buys landed at +3 blocks and each paid 99%: 0.02 ETH in,
  // ~0.1M tokens out against a modelled 11.4M, so 0.9% of expectation. The
  // position was worth ~0.0002 ETH the moment it filled.
  //
  // Legitimate curve-to-curve variance measured 0.5x to 6.6x of the model
  // (true output for 0.02 ETH ranged 6.25M-75M tokens on curves reporting
  // identical config), so a floor must sit below that spread. 25% clears the
  // lowest legitimate observation (54.7%) with room, and rejects a 99% tax
  // (0.9%) by a factor of 27.
  slippageBps: num(process.env.CURVE_SLIPPAGE_BPS, 7500),

  // ── timing, which is the whole edge ───────────────────────────────────────
  // Measured ROI by fill latency: <=150ms +94.6%, 150-350ms +52.4%,
  // 350-750ms +32.8%, 750-1500ms +2.8%, 1.5-3s -5.0%. Past ~6 blocks the
  // expectancy is negative and no amount of capital fixes it. Skip anything
  // we cannot reach in time rather than buying it late.
  maxEntryBlocks: num(process.env.CURVE_MAX_ENTRY_BLOCKS, 6),

  // How hard to poll for new creations. ethers' own event polling defaults to
  // 4000ms, which on a 100ms chain is 40 blocks of latency and would put every
  // fill deep in negative-expectancy territory. This is why the watcher polls
  // eth_getLogs directly.
  pollMs: num(process.env.CURVE_POLL_MS, 40),

  // Exit. Holding is where the returns go: exit at 10s returned +26.0%,
  // exit-on-first-other-sell +34.5%, hold-to-end -2.0%. The profitable farm
  // held a median 0.5 min.
  holdMs: num(process.env.CURVE_HOLD_MS, 30_000),
  takeProfitBps: num(process.env.CURVE_TP_BPS, 3000),   // exit early at +30%
  stopLossBps: num(process.env.CURVE_SL_BPS, 3500),     // and cut at -35%

  // ── curve model ───────────────────────────────────────────────────────────
  // Read off the contract: phantomQuote 1.68 ETH, supply 1e9, fee 100bps,
  // graduation at 4.2 ETH. Holds for 99.4% of curves.
  phantomQuoteWei: 1_680_000_000_000_000_000n,
  supplyWei: 1_000_000_000_000_000_000_000_000_000n,
  // Assumed fee+tax when pricing our own buy. The 100bps platform fee is
  // universal; `tax` is a per-curve CREATOR tax of up to 1000bps that 34% of
  // buys pay, and the snipe tax is ~5bps at <=200ms. Pricing against the
  // pessimistic case makes the floor bind slightly early, which is the safe
  // direction.
  assumedCostBps: num(process.env.CURVE_ASSUMED_COST_BPS, 300),

  // ── gas ───────────────────────────────────────────────────────────────────
  // Measured median 0.0000799 ETH/tx. Priority fee is 0 because this chain
  // orders by ARRIVAL, not price — bidding gas up buys nothing.
  gasLimit: num(process.env.CURVE_GAS_LIMIT, 300_000),
  maxFeeGwei: str(process.env.MAX_FEE_GWEI, '2'),
  priorityFeeGwei: str(process.env.PRIORITY_FEE_GWEI, '0'),

  // ── hard caps ─────────────────────────────────────────────────────────────
  // 69.6% of wallets on this venue lose money and the market is negative-sum
  // by ~520 ETH/day of rake. These exist so a bad run stops instead of
  // compounding.
  maxConcurrent: num(process.env.CURVE_MAX_CONCURRENT, 1),
  maxDailySpendEth: num(process.env.CURVE_MAX_DAILY_ETH, 2),
  maxConsecutiveLosses: num(process.env.CURVE_MAX_LOSS_STREAK, 8),

  // Nothing is broadcast unless this is explicitly turned off.
  dryRun: bool(process.env.DRY_RUN, true) || process.argv.includes('--dry'),
};
