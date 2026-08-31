'use strict';

// The curve is constant product against a virtual quote reserve. Validated to
// 0.0000% against SPACEINU's known-true parameters over 346 trades —
// see research/test-curve-model.js.
//
// The one thing that must not be got wrong: a BUY adds the NET amount
// (amountIn - fee - tax) to the reserve, while a SELL removes the GROSS
// amount (quoteOut + fee + tax). Using net on both sides misprices the
// reserve by up to 2.1% and every number downstream with it.

const cfg = require('./config');

const BPS = 10_000n;

/** Tokens out for a fresh curve, given the gross ETH we send. */
function expectedTokens(amountInWei, { costBps = cfg.assumedCostBps } = {}) {
  const net = (BigInt(amountInWei) * (BPS - BigInt(costBps))) / BPS;
  const Q = cfg.phantomQuoteWei;
  const T = cfg.supplyWei;
  return (T * net) / (Q + net);
}

/** Quote out for selling `tokens` back into a curve at state (Q, T). */
function expectedQuote(tokensWei, Q, T, { costBps = cfg.assumedCostBps } = {}) {
  const gross = (BigInt(Q) * BigInt(tokensWei)) / (BigInt(T) + BigInt(tokensWei));
  return (gross * (BPS - BigInt(costBps))) / BPS;
}

/**
 * Curve state after our own buy, so the exit can be priced without another
 * round trip to the chain.
 */
function stateAfterBuy(amountInWei, tokensOut, { costBps = cfg.assumedCostBps } = {}) {
  const net = (BigInt(amountInWei) * (BPS - BigInt(costBps))) / BPS;
  return { Q: cfg.phantomQuoteWei + net, T: cfg.supplyWei - BigInt(tokensOut) };
}

/**
 * The floor that makes a late fill revert.
 *
 * Priced against a FRESH curve on purpose. If anyone landed ahead of us the
 * curve has already moved, we get fewer tokens than this, and the buy reverts
 * — which is exactly the intent. Measured expectancy past ~6 blocks is
 * negative, so "be early or do not trade" is the correct behaviour, and a
 * revert costs only gas.
 */
function floorTokens(amountInWei) {
  const expected = expectedTokens(amountInWei);
  return (expected * (BPS - BigInt(cfg.slippageBps))) / BPS;
}

module.exports = { expectedTokens, expectedQuote, stateAfterBuy, floorTokens };
