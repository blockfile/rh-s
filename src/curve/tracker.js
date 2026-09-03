'use strict';

// Watches every live curve accumulate traction, so the entry decision can be
// made from what was actually visible at the time.
//
// The wallets this models do NOT snipe. Measured entry across 7 of them:
//
//   wallet     delay    trades already done   curve already funded
//   N1/N3       53 s            32                   28%
//   N2          83 s            38                   30%
//   A/B/C     70-87 s          36-42                 10%
//
// So the bot's job is not to be first. It is to sit on every new curve for a
// minute and buy only the ones the crowd has already validated. That also
// keeps it far outside the +2..+10 block window where a 99% snipe tax fires.

const { WebSocketProvider } = require('ethers');
const cfg = require('./config');
const { provider } = require('./chain');
const { REGISTRY, TOPIC, ETH_QUOTE } = require('./abi');

const addr = (t) => '0x' + t.slice(26).toLowerCase();
const word = (d, i) => BigInt('0x' + d.slice(2).slice(64 * i, 64 * (i + 1)));
const asNum = (v) => (typeof v === 'number' ? v : parseInt(v, 16));

class Tracker {
  constructor() {
    this.curves = new Map();   // curve addr -> state
  }

  onCreate(log) {
    const pairToken = '0x' + log.data.slice(2).slice(24, 64).toLowerCase();
    if (pairToken !== ETH_QUOTE) return null;        // ETH-quoted only
    const c = {
      token: addr(log.topics[1]),
      curve: addr(log.topics[2]),
      creator: addr(log.topics[3]),
      gradThreshold: word(log.data, 2),
      createdBlock: asNum(log.blockNumber),
      createdAt: Date.now(),
      buys: 0, sells: 0,
      fundedWei: 0n,
      costSamples: [],
      graduated: false,
      decided: false,
    };
    this.curves.set(c.curve, c);
    return c;
  }

  /**
   * Read one curve's whole trade history in a single call, at the moment we
   * need it.
   *
   * The obvious design — subscribing chain-wide to CurveBuy/CurveSell and
   * counting as they stream — does not work: that is ~5 events per second of
   * firehose, and in testing it starved the creation subscription badly enough
   * that only 13 of an expected 45 launches were seen in three minutes. We
   * only care about a curve once, sixty seconds in, so one getLogs per
   * candidate (~15/min) is both lighter and complete.
   */
  async load(c) {
    const logs = await provider.send('eth_getLogs', [{
      address: c.curve,
      topics: [[TOPIC.CURVE_BUY, TOPIC.CURVE_SELL]],
      fromBlock: '0x' + c.createdBlock.toString(16),
      toBlock: 'latest',
    }]);
    c.buys = 0; c.sells = 0; c.fundedWei = 0n; c.costSamples = [];
    for (const l of logs) {
      const isBuy = l.topics[0] === TOPIC.CURVE_BUY;
      const q = word(l.data, isBuy ? 0 : 1);
      const fee = word(l.data, 2);
      const tax = word(l.data, 3);
      if (isBuy) { c.buys++; c.fundedWei += q - fee - tax; }
      else { c.sells++; c.fundedWei -= q + fee + tax; }
      // The real cost this curve charges, read off its own trades. This is how
      // a 1000bps creator-tax curve is detected without parsing launch
      // calldata: the modelled wallets bought 0 of 114 such tokens.
      if (isBuy && q > 0n) c.costSamples.push(Number((fee + tax) * 10000n / q));
    }
    return c;
  }

  onGraduate(log) {
    const tok = addr(log.topics[1]);
    for (const c of this.curves.values()) if (c.token === tok) { c.graduated = true; return c; }
    return null;
  }

  costBps(c) {
    if (!c.costSamples.length) return null;
    const s = [...c.costSamples].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  fundingPct(c) {
    if (c.gradThreshold === 0n) return 0;
    return Number(c.fundedWei * 10_000n / c.gradThreshold) / 100;
  }

  /** Curves old enough to judge and not yet acted on. */
  ready(nowMs) {
    const out = [];
    for (const c of this.curves.values()) {
      if (c.decided || c.graduated) continue;
      if (nowMs - c.createdAt >= cfg.entryDelayMs) out.push(c);
    }
    return out;
  }

  // Curves die constantly; without this the map grows until the process does.
  sweep(nowMs) {
    for (const [k, c] of this.curves) {
      if (nowMs - c.createdAt > cfg.trackTtlMs) this.curves.delete(k);
    }
  }
}

/** Subscribe to creations, trades and graduations over one websocket. */
async function run(tracker, { onCreate, onGraduate }) {
  const ws = new WebSocketProvider(cfg.wsUrl, cfg.chainId, { staticNetwork: true });
  await ws.getBlockNumber();
  console.log(`   transport: WEBSOCKET (push)`);

  ws.on({ address: REGISTRY, topics: [TOPIC.CREATE] }, (l) => {
    const c = tracker.onCreate(l); if (c && onCreate) onCreate(c);
  });
  ws.on({ address: REGISTRY, topics: [TOPIC.GRADUATE] }, (l) => {
    const c = tracker.onGraduate(l); if (c && onGraduate) onGraduate(c);
  });
  // Deliberately NOT subscribing to curve trades here — see Tracker.load().

  ws.websocket.onclose = () => {
    console.error('   websocket closed — reconnecting in 1s');
    setTimeout(() => run(tracker, { onCreate, onGraduate }).catch(e => console.error(e.message)), 1000);
  };
  return ws;
}

module.exports = { Tracker, run };
