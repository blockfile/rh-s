'use strict';

// One launch, from the log that announces it to the buy that lands.

const { Contract, parseEther, formatEther, formatUnits } = require('ethers');
const config = require('./config');
const { provider, wallet, weth, evmBlockNumber } = require('./chain');
const { ROUTER_ABI } = require('./abi');
const { expectedOut } = require('./pricing');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const router = new Contract(config.router, ROUTER_ABI, wallet || provider);

/**
 * Should this launch be bought at all?
 *
 * The one filter that matters is the dev buy. It is the only trade that
 * precedes everyone, it is exempt from every cap, and it sets the price the
 * whole field enters at. Past a certain size a small fixed ticket cannot clear
 * its own gas — the bot this models took every launch below ~1.0 ETH of dev buy
 * and skipped ten out of ten above it.
 *
 * NOTE this threshold is calibrated for a SMALL ticket. Larger operators on
 * this chain buy through the same launches at ~0.07 ETH a wallet and tolerate
 * far more expensive pools; if you raise buyEth, raise this with it or the bot
 * will sit out launches it could still profit from.
 */
function shouldBuy({ devBuyWei }) {
  const limit = parseEther(config.maxDevBuyEth);
  if (BigInt(devBuyWei) >= limit) {
    return { ok: false, why: `dev buy ${formatEther(devBuyWei)} ETH >= limit ${config.maxDevBuyEth}` };
  }
  return { ok: true };
}

/**
 * Wait until the launch block has passed.
 *
 * The factory reverts every pool buy where block.number == launchBlock, with
 * only the dev's recipient exempt. block.number advances about every 12s with
 * several seconds of jitter, so this CANNOT be timed — it has to be watched.
 * Polled hard, because the whole contest is position inside the first legal
 * block and everything after this returns is already too late to change it.
 *
 * @returns {Promise<boolean>} false if the deadline passed without a tick
 */
async function waitForOpen(launchBlock, deadlineMs = 60_000) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    try {
      const n = await evmBlockNumber();
      if (n > BigInt(launchBlock)) return true;
    } catch {
      // A dropped poll is not a reason to miss the window.
    }
    await sleep(config.pollMs);
  }
  return false;
}

/**
 * Buy, once.
 *
 * Sends WETH rather than native ETH (value 0), which is why setup.js has to run
 * first: the approval must already exist, because doing it here would cost a
 * transaction inside the window that decides the price.
 *
 * amountOutMinimum is NOT slippage tolerance in the ordinary sense. It is the
 * profitability guard: if another bot got in first and moved the price, this
 * reverts instead of buying at whatever the pool now asks. A zero floor here
 * would buy at ANY price, which is how a sniper ends up as someone else's exit.
 */
async function executeBuy({ token, expected }) {
  const amountIn = parseEther(config.buyEth);
  const floor = (expected * BigInt(10_000 - config.slippageBps)) / 10_000n;

  // Before touching the wallet: `npm run watch` is documented as running
  // without a key, and building params first made it die on wallet.address and
  // report the crash as `no fill:` — which reads exactly like losing a race.
  if (config.dryRun) {
    console.log(
      `   [dry] would buy ${config.buyEth} WETH -> ${token}, floor ${formatUnits(floor, 18)} tokens`
    );
    return null;
  }

  if (!wallet) throw new Error('PRIVATE_KEY is not set — cannot broadcast a live buy');

  const params = {
    tokenIn: config.weth,
    tokenOut: token,
    fee: config.poolFee,
    recipient: wallet.address,
    amountIn,
    amountOutMinimum: floor,
    sqrtPriceLimitX96: 0n,
  };

  // Priority fee is zero on purpose. This chain orders by ARRIVAL, not by
  // price — a 0.00001 gwei transaction has been observed landing ahead of a
  // 0.067 gwei one in the same block. Paying more buys nothing here. The
  // generous maxFee only stops a base-fee spike stranding it.
  const tx = await router.exactInputSingle(params, {
    value: 0n,
    gasLimit: config.gasLimit,
    maxFeePerGas: parseEther(config.maxFeeGwei) / 10n ** 9n,
    maxPriorityFeePerGas: parseEther(config.priorityFeeGwei) / 10n ** 9n,
  });
  console.log(`   sent ${tx.hash}`);
  const rec = await tx.wait(1);
  console.log(`   ${rec.status === 1 ? 'FILLED' : 'REVERTED'} in block ${rec.blockNumber}`);
  return rec;
}

/**
 * The whole run for one launch: decide, wait, buy.
 */
async function handleLaunch({ token, devBuyWei, restrictionsEndBlock, launchConfig }) {
  const launchBlock = BigInt(restrictionsEndBlock) - BigInt(launchConfig.restrictionBlocks);
  const gate = shouldBuy({ devBuyWei });

  const { expected, sharePct } = expectedOut({
    launchConfig,
    devBuyWei,
    amountInWei: parseEther(config.buyEth),
    poolFeeBps: 100,
  });

  console.log(
    `\n${new Date().toISOString().slice(11, 19)}  ${token}` +
      `\n   dev buy ${formatEther(devBuyWei)} ETH | our ${config.buyEth} ETH would take ~${sharePct.toFixed(3)}% of supply`
  );

  if (!gate.ok) {
    console.log(`   SKIP — ${gate.why}`);
    return;
  }
  if (expected === 0n) {
    console.log('   SKIP — could not price this launch');
    return;
  }

  const opened = await waitForOpen(launchBlock);
  if (!opened) {
    console.log('   SKIP — launch block never cleared within the deadline');
    return;
  }

  try {
    await executeBuy({ token, expected });
  } catch (err) {
    // A revert here is the normal outcome when someone landed first — the
    // floor did its job. It is information, not a failure to fix.
    console.log(`   no fill: ${(err.shortMessage || err.message).slice(0, 100)}`);
  }
}

module.exports = { handleLaunch, shouldBuy, waitForOpen, executeBuy };
