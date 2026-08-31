'use strict';
// Golden-record test for the curve model.
//
// SPACEINU (0xa75262b1…) has known-true parameters read from its launch
// config: phantomQuote 28.88 SPCX and supply 1e27. If solveReserves() cannot
// recover those from its trade log, every P&L downstream is fiction.
//
// This test is what caught the original model being 47% wrong: replaying with
// the gross quoteIn instead of (quoteIn - fee - tax) gave Q0 = 15.33 against a
// true 28.88, and a 20% median error on 224 buys.
//
// Run: node research/test-curve-model.js

const { provider, TOPIC } = require('./lib');

const CURVE = '0xE21a2990eBF8dc3E752F293D4E98c7f128e96852';
const FROM = 50039507, TO = 50090000;
const TRUE_Q0 = 28.88, TRUE_T0 = 1e9;
const TOL = 0.001; // 0.1%

const word = (d, i) => Number(BigInt('0x' + d.slice(2).slice(64 * i, 64 * (i + 1))));
const netQ  = (t) => t.q - t.f - t.x;  // buy: what enters the reserve
const sellQ = (t) => t.q + t.f + t.x;  // sell: what LEAVES it (gross)

async function loadTrades() {
  const out = [];
  for (let s = FROM; s < TO; s += 25000) {
    const e = Math.min(s + 24999, TO);
    for (const topic of [TOPIC.CURVE_BUY, TOPIC.CURVE_SELL]) {
      const logs = await provider.send('eth_getLogs', [{
        address: CURVE, topics: [topic],
        fromBlock: '0x' + s.toString(16), toBlock: '0x' + e.toString(16),
      }]);
      const isBuy = topic === TOPIC.CURVE_BUY;
      for (const l of logs) {
        out.push({
          b: parseInt(l.blockNumber, 16), i: parseInt(l.logIndex, 16), buy: isBuy,
          q: word(l.data, isBuy ? 0 : 1), t: word(l.data, isBuy ? 1 : 0),
          f: word(l.data, 2), x: word(l.data, 3),
        });
      }
    }
  }
  return out.sort((a, b) => a.b - b.b || a.i - b.i);
}

function solve(trades) {
  const b = trades.filter((t) => t.buy).slice(0, 2);
  const q1 = netQ(b[0]), t1 = b[0].t, q2 = netQ(b[1]), t2 = b[1].t;
  const Q0 = (t2 * q1 * (q1 + q2)) / (t1 * q2 - t2 * q1);
  return { Q0, T0: (t1 * (Q0 + q1)) / q1 };
}

(async () => {
  const trades = await loadTrades();
  const { Q0, T0 } = solve(trades);
  const errQ = Math.abs(Q0 / 1e18 / TRUE_Q0 - 1);
  const errT = Math.abs(T0 / 1e18 / TRUE_T0 - 1);

  let Q = Q0, T = T0; const errs = [];
  for (const tr of trades) {
    if (tr.buy) {
      const q = netQ(tr), pred = (T * q) / (Q + q);
      if (tr.t > 0) errs.push(Math.abs(pred - tr.t) / tr.t);
      Q += q; T -= pred;
    } else {
      Q -= sellQ(tr); T += tr.t;
    }
  }
  errs.sort((a, b) => a - b);
  const median = errs[Math.floor(errs.length / 2)];

  // Replay a SECOND time from the known-true reserves. The fitted version
  // above cannot catch a sell-side error: solveReserves absorbs it into Q0/T0
  // and still reports 0.0000%. This is how the gross/net sell bug survived.
  let Qt = TRUE_Q0 * 1e18, Tt = TRUE_T0 * 1e18; const errsTrue = [];
  for (const tr of trades) {
    if (tr.buy) {
      const q = netQ(tr), pred = (Tt * q) / (Qt + q);
      if (tr.t > 0) errsTrue.push(Math.abs(pred - tr.t) / tr.t);
      Qt += q; Tt -= pred;
    } else { Qt -= sellQ(tr); Tt += tr.t; }
  }
  errsTrue.sort((a, b) => a - b);
  const maxTrue = errsTrue[errsTrue.length - 1];

  const checks = [
    ['trades loaded',      trades.length > 300,  `${trades.length}`],
    ['Q0 within 0.1%',     errQ < TOL,           `${(Q0 / 1e18).toFixed(4)} vs ${TRUE_Q0} (${(errQ * 100).toFixed(4)}%)`],
    ['T0 within 0.1%',     errT < TOL,           `${(T0 / 1e18).toExponential(4)} vs 1.0000e+9 (${(errT * 100).toFixed(4)}%)`],
    ['replay median <0.1%', median < TOL,        `${(median * 100).toFixed(4)}% over ${errs.length} buys`],
    ['TRUE-reserve MAX <0.1%', maxTrue < TOL,    `${(maxTrue * 100).toFixed(4)}% over ${errsTrue.length} buys`],
  ];
  let failed = 0;
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(22)} ${detail}`);
    if (!ok) failed++;
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})();
