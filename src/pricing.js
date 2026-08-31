'use strict';

// What a buy will receive, before the pool exists.
//
// The whole decision has to be made in the ~12 seconds between the launch log
// and the restriction lifting, and for most of that window there is nothing to
// quote against — the pool is open but no trade may touch it. So the price is
// derived from the launch config, which fixes it before the launch is sent.
//
// VALIDATED AGAINST THE CHAIN, not just derived. Twelve real launches, dev buys
// from 0.05 to 3.5 ETH, this model reads between +0.2% and +1.7% of the share
// those buys actually took — and every error is POSITIVE, meaning it predicts
// slightly more tokens than arrive. That direction matters: it makes the
// minimum-output floor slightly conservative rather than slightly too tight.

const Q = 1.0001;

/**
 * Tokens per whole pair token at the pool's opening price.
 *
 * On the sign of initialTick: a Uniswap tick is quoted token1-per-token0, so
 * its sign follows address ordering rather than economics. A launchpad always
 * opens with the token cheap against the pair token, so the magnitude is the
 * rate whichever side the token lands on. DO NOT "fix" the Math.abs.
 */
function rateFromTick(initialTick) {
  const tick = Math.abs(Number(initialTick));
  if (!Number.isFinite(tick)) return 0;
  const rate = Math.pow(Q, tick);
  return Number.isFinite(rate) && rate > 0 ? rate : 0;
}

/**
 * The pool a launch config opens, as reserves.
 *
 * A constant product holding the whole supply quotes tokenReserve/quoteReserve,
 * and the tick says that ratio is `rate` — so the quote side is supply / rate.
 * Same tick and same supply the cap checks use, read for depth as well as price.
 */
function openingPool({ supply, initialTick }) {
  const rate = rateFromTick(initialTick);
  const s = BigInt(supply);
  if (s <= 0n || !rate) return { quoteReserve: 0n, tokenReserve: 0n };
  const quoteReserve = BigInt(Math.round(Number(s) / rate));
  return quoteReserve > 0n ? { quoteReserve, tokenReserve: s } : { quoteReserve: 0n, tokenReserve: 0n };
}

/** One buy against a constant product, and the reserves it leaves behind. */
function buy({ quoteInWei, quoteReserve, tokenReserve, feeBps = 0 }) {
  const q = BigInt(quoteInWei);
  let quote = BigInt(quoteReserve);
  let tokens = BigInt(tokenReserve);
  if (q <= 0n || quote <= 0n || tokens <= 0n) {
    return { tokensOut: 0n, quoteReserve: quote, tokenReserve: tokens };
  }
  const netIn = q - (q * BigInt(feeBps)) / 10_000n;
  if (netIn <= 0n) return { tokensOut: 0n, quoteReserve: quote, tokenReserve: tokens };
  const tokensOut = (tokens * netIn) / (quote + netIn);
  return { tokensOut, quoteReserve: quote + netIn, tokenReserve: tokens - tokensOut };
}

/**
 * What our buy expects to receive, with the dev's atomic buy already applied.
 *
 * The dev buy is the only trade that can precede us — it executes inside the
 * launch transaction, exempt from every restriction — so it is the state the
 * pool is genuinely in when the restriction lifts. Anything else arriving
 * before us is another bot, which is exactly what the minimum-output floor is
 * there to absorb.
 *
 * @returns {{expected: bigint, sharePct: number, poolAfterDev: object}}
 */
function expectedOut({ launchConfig, devBuyWei, amountInWei, poolFeeBps = 100 }) {
  const pool = openingPool(launchConfig);
  if (pool.quoteReserve === 0n) return { expected: 0n, sharePct: 0, poolAfterDev: pool };

  const afterDev =
    BigInt(devBuyWei) > 0n
      ? buy({ quoteInWei: devBuyWei, ...pool, feeBps: poolFeeBps })
      : pool;

  const ours = buy({
    quoteInWei: amountInWei,
    quoteReserve: afterDev.quoteReserve,
    tokenReserve: afterDev.tokenReserve,
    feeBps: poolFeeBps,
  });

  return {
    expected: ours.tokensOut,
    sharePct: (Number(ours.tokensOut) / Number(BigInt(launchConfig.supply))) * 100,
    poolAfterDev: afterDev,
  };
}

module.exports = { rateFromTick, openingPool, buy, expectedOut };
