'use strict';

// Everything the bot needs to know, in one place.
//
// The chain addresses are not guesses — they were read off the live factory's
// own launch and dex config, and the trade shape was decoded from a working
// sniper's transaction (0x88c7cd75…, a 0.004 ETH buy on HAPPYCAT). Where a
// value came from an observed transaction rather than from the chain's config,
// the comment says so.

require('dotenv').config();

const str = (v, d) => (v === undefined || v === '' ? d : v);
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : v === 'true' || v === '1');

module.exports = {
  rpcUrl: str(process.env.RPC_URL, 'https://rpc.mainnet.chain.robinhood.com'),
  chainId: num(process.env.CHAIN_ID, 4663),
  privateKey: str(process.env.PRIVATE_KEY, ''),

  // ── the chain, as the factory itself reports it ───────────────────────────
  // Pons V2. The original factory (0xA5aAb3F0…51feB) is dormant: no
  // TokenLaunched in 9,000,000 blocks (~10 days) and no logs of any kind in 83
  // hours, verified against this repo's own topic hash. V2 is an EIP-1967
  // proxy (impl 0x02081d3d…96ae) emitting the IDENTICAL event signature, so
  // FACTORY_ABI is unchanged. launchConfig #0 is also identical — same WETH
  // pair, same tick, same supply, same 500/550bps caps — EXCEPT
  // restrictionBlocks, which went 2 → 366.
  //
  // router/weth/poolFee below were re-verified against V2: every recent launch
  // reports dexId 0 and dexFactory 0x1f7d7550…2EfA, which is exactly what
  // SwapRouter02.factory() returns, and every pool is WETH at fee 10000.
  factory: str(process.env.FACTORY_ADDRESS, '0xf4fc0cd27fc8ecf17e55ee4c3f7201897df3eb75'),
  // Previous deployments, both now dormant. Kept for reference only:
  //   0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB  (0 launches/24h)
  //   0x966ffA3957a6d3621D3EfC96E22160806f0EF141  (0 launches/24h)
  // A dormant factory does not error, it simply never fires -- which is why
  // the boot check below refuses to start against one.
  minLaunchesPerDay: num(process.env.MIN_LAUNCHES_PER_DAY, 1),
  // dexConfig #0: swapRouter. This is SwapRouter02, and it is what the working
  // sniper calls — `to` on every one of its buys.
  router: '0xCaf681a66D020601342297493863E78C959E5cb2',
  // launchConfig #0: pairToken. Every pons pool is TOKEN/WETH.
  weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  // dexConfig #0: poolFee. 10000 = 1%.
  poolFee: num(process.env.POOL_FEE, 10000),
  // block.number as a CONTRACT sees it is not the RPC height on this chain,
  // and every launch restriction is written against the former. Multicall3 at
  // the standard address is the cheapest way to ask.
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',

  // ── what to bid ───────────────────────────────────────────────────────────
  // The observed sniper spends exactly this, every time, on every launch —
  // 102 buys out of 102. It never scales to the pool.
  buyEth: str(process.env.BUY_ETH, '0.004'),

  // SKIP a launch whose atomic dev buy is at or above this. This is the single
  // most important number in the file. Measured across 45 consecutive
  // launches, the sniper this is modelled on took every launch below ~1.0 ETH
  // of dev buy and skipped 10 of 10 above it: past that point the pool is too
  // expensive for a small fixed ticket to clear its own gas.
  //
  // WARNING — on V2 this filter is currently INERT. Measured across 92
  // consecutive V2 launches (~42h, 2.2 launches/hr): median 0.01, p75 0.05,
  // p90 0.06, p99 0.30, max 0.30 ETH, and 21 of 92 with no dev buy at all.
  // ZERO of 92 reach 1.0, so this never fires and the bot takes every launch.
  // For reference, thresholds that would actually bite: 0.25 skips 1 in 92,
  // 0.1 skips 2 in 92. Re-measure and re-tune before running live, or accept
  // that the bot is buying indiscriminately.
  maxDevBuyEth: str(process.env.MAX_DEV_BUY_ETH, '1.0'),

  // The floor on tokens received, as a haircut off the modelled output. The
  // observed sniper sets its amountOutMinimum around 85% of expected, which is
  // both slippage tolerance AND the guard that makes a bad fill revert rather
  // than execute. Setting this to 0 would buy at ANY price — never do that.
  slippageBps: num(process.env.SLIPPAGE_BPS, 1500),

  // ── how to send ───────────────────────────────────────────────────────────
  // Both taken from the observed sniper's transaction. Note the priority fee
  // is ZERO and it still lands at the front: this chain orders by ARRIVAL, not
  // by price, so paying more buys nothing. The generous maxFee is only there
  // so a base-fee spike cannot strand the transaction.
  gasLimit: num(process.env.GAS_LIMIT, 600000),
  maxFeeGwei: str(process.env.MAX_FEE_GWEI, '2'),
  priorityFeeGwei: str(process.env.PRIORITY_FEE_GWEI, '0'),

  // How often to read block.number while waiting for the launch block to pass.
  // The wait is ~12s and this is the whole race, so it is polled hard.
  pollMs: num(process.env.POLL_MS, 25),

  // ── exit ──────────────────────────────────────────────────────────────────
  // The bots this models flip within minutes — they hold nothing. 0 disables
  // selling entirely and leaves the position for you to manage by hand.
  sellAfterMs: num(process.env.SELL_AFTER_MS, 0),

  // ── safety ────────────────────────────────────────────────────────────────
  // Nothing is broadcast unless this is explicitly turned off. Every run
  // prints what it WOULD do first.
  dryRun: bool(process.env.DRY_RUN, true) || process.argv.includes('--dry'),
};
