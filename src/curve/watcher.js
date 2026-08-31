'use strict';

// Detect new curves as fast as the RPC allows.
//
// ethers' own contract.on() polls at 4000ms by default. On a 100ms chain that
// is 40 blocks of latency, which lands every fill in the measured
// negative-expectancy zone (past ~6 blocks). So we poll eth_getLogs directly
// and keep the request narrow enough to come back fast.

const { provider } = require('./chain');
const cfg = require('./config');
const { REGISTRY, TOPIC, ETH_QUOTE } = require('./abi');

const addr = (topic) => '0x' + topic.slice(26).toLowerCase();
const word = (data, i) => '0x' + data.slice(2).slice(64 * i, 64 * (i + 1));

/**
 * Calls onCreate({...}) for every ETH-quoted curve creation, as soon as it is
 * visible. `seenAt` is captured before any awaiting so the latency numbers
 * describe the chain, not our own bookkeeping.
 */
async function watch(onCreate) {
  let from = (await provider.getBlockNumber()) + 1;

  for (;;) {
    const started = Date.now();
    try {
      const head = await provider.getBlockNumber();
      if (head >= from) {
        const logs = await provider.send('eth_getLogs', [{
          address: REGISTRY,
          topics: [TOPIC.CREATE],
          fromBlock: '0x' + from.toString(16),
          toBlock: '0x' + head.toString(16),
        }]);
        const seenAt = Date.now();
        for (const l of logs) {
          const pairToken = '0x' + l.data.slice(2).slice(24, 64).toLowerCase();
          if (pairToken !== ETH_QUOTE) continue;   // ETH-quoted only
          onCreate({
            token: addr(l.topics[1]),
            curve: addr(l.topics[2]),
            creator: addr(l.topics[3]),
            gradThreshold: BigInt(word(l.data, 2)),
            createdBlock: parseInt(l.blockNumber, 16),
            seenAt,
            headAtDetect: head,
          });
        }
        from = head + 1;
      }
    } catch (err) {
      // A dropped poll is not a reason to stop watching. Do not advance
      // `from`, so nothing is skipped.
    }
    const elapsed = Date.now() - started;
    if (elapsed < cfg.pollMs) await new Promise((r) => setTimeout(r, cfg.pollMs - elapsed));
  }
}

module.exports = { watch };
