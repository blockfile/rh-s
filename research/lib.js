'use strict';
// Shared plumbing for the curve-graduation research pipeline.
// Read-only. No keys, no signing, no broadcasting.

const { JsonRpcProvider } = require('ethers');

const RPC = process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const provider = new JsonRpcProvider(RPC, 4663, { staticNetwork: true, batchMaxCount: 1 });

const REGISTRY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';

// Verified by keccak match against the live contracts, not guessed.
const TOPIC = {
  CREATE:     '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607',
  GRADUATE:   '0xcdb72f157fd3666758a6ce201387ffb52038c7562e4fff352828da1096c4b6b4',
  CURVE_BUY:  '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455',
  CURVE_SELL: '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df',
};

const ETH_QUOTE = '0x0000000000000000000000000000000000000000';

const addrOf = (topic) => '0x' + topic.slice(26).toLowerCase();
const wordAt = (data, i) => BigInt('0x' + data.slice(2).slice(64 * i, 64 * (i + 1)));

// The node silently caps a response at 10,000 logs — truncation is NOT an
// error, so a chunk that comes back near the cap has to be split and retried
// or we lose data without ever knowing. Everything downstream depends on this.
const CAP = 10000;
const NEAR_CAP = 9900;

async function getLogs(filter, from, to, onBatch, depth = 0) {
  let logs;
  for (let attempt = 0; ; attempt++) {
    try {
      logs = await provider.send('eth_getLogs', [{
        ...filter,
        fromBlock: '0x' + from.toString(16),
        toBlock: '0x' + to.toString(16),
      }]);
      break;
    } catch (err) {
      // Retrying does not help a response that is simply too large — the node
      // fails the same way every time. Split instead, and only give up when
      // the range is a single block and therefore unsplittable.
      if (attempt >= 2) {
        if (to > from) {
          const mid = Math.floor((from + to) / 2);
          await getLogs(filter, from, mid, onBatch, depth + 1);
          await getLogs(filter, mid + 1, to, onBatch, depth + 1);
          return;
        }
        throw new Error(`getLogs ${from}-${to}: ${err.shortMessage || err.message}`);
      }
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  if (logs.length >= NEAR_CAP && to > from) {
    const mid = Math.floor((from + to) / 2);
    await getLogs(filter, from, mid, onBatch, depth + 1);
    await getLogs(filter, mid + 1, to, onBatch, depth + 1);
    return;
  }
  if (logs.length >= CAP) throw new Error(`unsplittable chunk at ${from} hit the cap`);
  onBatch(logs);
}

async function sweep(filter, from, to, onBatch, { chunk = 25000, label = '' } = {}) {
  const total = Math.ceil((to - from) / chunk);
  let done = 0;
  for (let s = from; s <= to; s += chunk) {
    await getLogs(filter, s, Math.min(s + chunk - 1, to), onBatch);
    if (++done % 20 === 0 || done === total) {
      process.stderr.write(`\r  ${label} ${done}/${total} chunks`);
    }
  }
  process.stderr.write('\n');
}

module.exports = { provider, REGISTRY, TOPIC, ETH_QUOTE, addrOf, wordAt, sweep };
