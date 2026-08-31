'use strict';

// One position: buy on the curve, hold briefly, sell back.

const { parseEther, formatEther, Contract } = require('ethers');
const cfg = require('./config');
const { provider, wallet, curveIface, FEES, takeNonce, resyncNonce } = require('./chain');
const { CURVE_ABI, ERC20_ABI } = require('./abi');
const { expectedTokens, expectedQuote, stateAfterBuy, floorTokens } = require('./pricing');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Send the buy. Everything that can be precomputed is, because the gap between
 * detecting the curve and landing the transaction IS the strategy.
 */
async function buy(curve) {
  const amountIn = parseEther(cfg.buyEth);
  const floor = floorTokens(amountIn);
  const data = curveIface.encodeFunctionData('buy', [amountIn, floor, wallet.address]);

  const tx = {
    to: curve,
    data,
    value: amountIn,
    gasLimit: cfg.gasLimit,
    nonce: takeNonce(),
    chainId: cfg.chainId,
    type: 2,
    ...FEES,
  };
  return wallet.sendTransaction(tx);
}

/** Approve the curve to pull the token, so the exit is not blocked on it. */
async function ensureApproval(token, curve) {
  const erc = new Contract(token, ERC20_ABI, wallet);
  const allowance = await erc.allowance(wallet.address, curve);
  if (allowance > 0n) return null;
  return erc.approve(curve, (1n << 256n) - 1n, {
    gasLimit: 120_000, nonce: takeNonce(), ...FEES,
  });
}

async function sell(curve, token, tokensIn) {
  const data = curveIface.encodeFunctionData('sell', [tokensIn, 0n, wallet.address]);
  return wallet.sendTransaction({
    to: curve, data, value: 0n,
    gasLimit: cfg.gasLimit, nonce: takeNonce(), chainId: cfg.chainId, type: 2, ...FEES,
  });
}

/**
 * Hold, then exit. Take-profit and stop-loss are evaluated against the curve
 * state we model locally plus the trades we can see, so the common case costs
 * no extra round trips.
 */
async function holdAndExit({ curve, token, tokensHeld, spentWei, onLog }) {
  const st = stateAfterBuy(parseEther(cfg.buyEth), tokensHeld);
  const deadline = Date.now() + cfg.holdMs;
  const tp = (BigInt(spentWei) * BigInt(10_000 + cfg.takeProfitBps)) / 10_000n;
  const sl = (BigInt(spentWei) * BigInt(10_000 - cfg.stopLossBps)) / 10_000n;

  while (Date.now() < deadline) {
    await sleep(1000);
    const mark = expectedQuote(tokensHeld, st.Q, st.T);
    if (mark >= tp) { onLog(`   take-profit at ${formatEther(mark)} ETH`); break; }
    if (mark <= sl) { onLog(`   stop-loss at ${formatEther(mark)} ETH`); break; }
  }

  if (cfg.dryRun) return null;
  const erc = new Contract(token, ERC20_ABI, wallet);
  const bal = await erc.balanceOf(wallet.address);
  if (bal === 0n) { onLog('   nothing to sell (buy did not fill)'); return null; }
  await ensureApproval(token, curve);
  const tx = await sell(curve, token, bal);
  const rec = await tx.wait(1);
  return rec;
}

module.exports = { buy, sell, ensureApproval, holdAndExit, expectedTokens };
