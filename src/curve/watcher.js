'use strict';

// Detect new curves as fast as the transport allows.
//
// Two modes. WebSocket is strongly preferred and is the default when WS_URL is
// set: the node PUSHES matching logs, so detection costs one-way network time
// instead of a poll interval plus a full request/response. Over HTTP the same
// detection costs (pollMs/2) + one RTT, and on a 100ms chain a 300ms RTT is
// three blocks of pure loss before we have even decided anything.
//
// ethers' own contract.on() over HTTP polls at 4000ms — 40 blocks — which is
// why neither mode uses it.

const { WebSocketProvider } = require('ethers');
const { provider } = require('./chain');
const cfg = require('./config');
const { REGISTRY, TOPIC, ETH_QUOTE } = require('./abi');

const addr = (t) => '0x' + t.slice(26).toLowerCase();
const word = (d, i) => '0x' + d.slice(2).slice(64 * i, 64 * (i + 1));
const asNum = (v) => (typeof v === 'number' ? v : parseInt(v, 16));

const rtts = [];
function noteRtt(ms) { rtts.push(ms); if (rtts.length > 50) rtts.shift(); }
function medianRtt() {
  if (!rtts.length) return 0;
  const s = [...rtts].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function decode(log, head, rttMs) {
  const pairToken = '0x' + log.data.slice(2).slice(24, 64).toLowerCase();
  if (pairToken !== ETH_QUOTE) return null;
  return {
    token: addr(log.topics[1]),
    curve: addr(log.topics[2]),
    creator: addr(log.topics[3]),
    gradThreshold: BigInt(word(log.data, 2)),
    createdBlock: asNum(log.blockNumber),
    seenAt: Date.now(),
    headAtDetect: head,
    rttMs,
  };
}

/** Push-based. Detection is one-way; only the broadcast costs a round trip. */
async function watchWs(onCreate) {
  const ws = new WebSocketProvider(cfg.wsUrl, cfg.chainId, { staticNetwork: true });
  await ws.getBlockNumber();
  console.log(`   transport: WEBSOCKET ${cfg.wsUrl} (push, no poll)`);

  // Keep a cheap head estimate so latency can still be reported, without
  // putting a request on the detection path.
  let head = await ws.getBlockNumber();
  ws.on('block', (n) => { head = n; });

  ws.on({ address: REGISTRY, topics: [TOPIC.CREATE] }, (log) => {
    const ev = decode(log, Math.max(head, asNum(log.blockNumber)), 0);
    if (ev) onCreate(ev);
  });

  ws.websocket.onclose = () => {
    console.error('   websocket closed — reconnecting in 1s');
    setTimeout(() => watchWs(onCreate).catch((e) => console.error(e.message)), 1000);
  };
}

/** Fallback. Every detection pays a full round trip. */
async function watchHttp(onCreate) {
  console.log(`   transport: HTTP polling every ${cfg.pollMs}ms (set WS_URL for push)`);
  let from = (await provider.getBlockNumber()) + 1;
  for (;;) {
    const started = Date.now();
    try {
      const t0 = Date.now();
      const head = await provider.getBlockNumber();
      noteRtt(Date.now() - t0);
      if (head >= from) {
        const logs = await provider.send('eth_getLogs', [{
          address: REGISTRY, topics: [TOPIC.CREATE],
          fromBlock: '0x' + from.toString(16), toBlock: '0x' + head.toString(16),
        }]);
        for (const l of logs) {
          const ev = decode(l, head, medianRtt());
          if (ev) onCreate(ev);
        }
        from = head + 1;
      }
    } catch {
      // A dropped poll is not a reason to stop, and `from` is not advanced so
      // nothing is skipped.
    }
    const left = cfg.pollMs - (Date.now() - started);
    if (left > 0) await new Promise((r) => setTimeout(r, left));
  }
}

const watch = (onCreate) => (cfg.wsUrl ? watchWs(onCreate) : watchHttp(onCreate));

module.exports = { watch };
