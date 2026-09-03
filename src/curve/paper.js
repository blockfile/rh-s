'use strict';

// Paper trading that actually scores itself.
//
// A dry run that only prints "would buy" tells you the trigger fires. It does
// not tell you whether firing was a good idea, which is the only question that
// matters. This follows each hypothetical position on the real curve and marks
// it with the real curve maths, so a night of watching produces a P&L
// distribution instead of a list of intentions.
//
// The curve is constant product. A BUY adds (quoteIn - fee - tax) to the quote
// reserve; a SELL removes (quoteOut + fee + tax) GROSS. Getting the sell side
// wrong mis-states reserves by up to 2.1% and compounds over a trade series.

const fs = require('fs');
const path = require('path');
const { formatEther } = require('ethers');
const { provider } = require('./chain');
const { TOPIC } = require('./abi');
const cfg = require('./config');

const word = (d, i) => BigInt('0x' + d.slice(2).slice(64 * i, 64 * (i + 1)));

/**
 * Solve the curve's virtual reserves from its own first two buys.
 *
 * Preferred over the configured phantomQuote/supply because those are only
 * right for the standard template: measured true output for a fixed input
 * varied 12x across curves reporting an identical launchConfigId. The curve's
 * own trades are ground truth; the config is a guess.
 */
function solveReserves(trades) {
  const buys = trades.filter((t) => t.buy).slice(0, 2);
  if (buys.length < 2) return null;
  const q1 = Number(buys[0].netQ), t1 = Number(buys[0].tok);
  const q2 = Number(buys[1].netQ), t2 = Number(buys[1].tok);
  const den = t1 * q2 - t2 * q1;
  if (!(Math.abs(den) > 0)) return null;
  const Q0 = (t2 * q1 * (q1 + q2)) / den;
  if (!(Q0 > 0) || !isFinite(Q0)) return null;
  const T0 = (t1 * (Q0 + q1)) / q1;
  return (T0 > 0 && isFinite(T0)) ? { Q0, T0 } : null;
}

/** Replay a trade series to the curve's current reserves. */
function replay(trades) {
  const r = solveReserves(trades);
  if (!r) return null;
  let Q = r.Q0, T = r.T0;
  for (const t of trades) {
    if (t.buy) { Q += Number(t.netQ); T -= Number(t.tok); }
    else { Q -= Number(t.grossQ); T += Number(t.tok); }
    if (!(Q > 0) || !(T > 0)) return null;
  }
  return { Q, T };
}

async function fetchTrades(curve, fromBlock) {
  const logs = await provider.send('eth_getLogs', [{
    address: curve,
    topics: [[TOPIC.CURVE_BUY, TOPIC.CURVE_SELL]],
    fromBlock: '0x' + fromBlock.toString(16),
    toBlock: 'latest',
  }]);
  return logs.map((l) => {
    const buy = l.topics[0] === TOPIC.CURVE_BUY;
    const q = word(l.data, buy ? 0 : 1);
    const fee = word(l.data, 2);
    const tax = word(l.data, 3);
    return {
      buy,
      tok: word(l.data, buy ? 1 : 0),
      netQ: q - fee - tax,     // what a buy adds to the reserve
      grossQ: q + fee + tax,   // what a sell removes from it
      costBps: q > 0n ? Number((fee + tax) * 10000n / q) : 0,
    };
  });
}

const buyOut = (Q, T, q) => (T * q) / (Q + q);
const sellOut = (Q, T, t) => (Q * t) / (T + t);

class PaperBook {
  constructor(file) {
    this.file = file || path.join(__dirname, '..', '..', 'research', 'paper-trades.jsonl');
    this.open = new Map();
    this.closed = [];
  }

  /** Record a hypothetical entry priced against the curve's real state. */
  async enter(c, sizeEth) {
    const trades = await fetchTrades(c.curve, c.createdBlock);
    const st = replay(trades);
    if (!st) return null;
    const costs = trades.filter((t) => t.buy).map((t) => t.costBps).sort((a, b) => a - b);
    const costBps = costs.length ? costs[Math.floor(costs.length / 2)] : 300;
    const net = sizeEth * 1e18 * (1 - costBps / 10000);
    const tokens = buyOut(st.Q, st.T, net);
    if (!(tokens > 0)) return null;
    const pos = {
      token: c.token, curve: c.curve, createdBlock: c.createdBlock,
      openedAt: Date.now(), sizeEth, costBps, tokens,
      entryTrades: trades.length, entryFundedPct: c.fundedPct ?? null,
      peak: sizeEth,
    };
    this.open.set(c.curve, pos);
    return pos;
  }

  /** Value a position at the curve's current state, net of exit cost and gas. */
  async mark(pos) {
    const trades = await fetchTrades(pos.curve, pos.createdBlock);
    const st = replay(trades);
    if (!st) return null;
    const gross = sellOut(st.Q, st.T, pos.tokens);
    const outEth = (gross / 1e18) * (1 - pos.costBps / 10000);
    if (outEth > pos.peak) pos.peak = outEth;
    return { outEth, pnl: outEth - pos.sizeEth - 0.00016, trades: trades.length };
  }

  async close(pos, reason) {
    const m = await this.mark(pos);
    const rec = {
      ...pos,
      closedAt: Date.now(),
      heldSec: Math.round((Date.now() - pos.openedAt) / 1000),
      reason,
      outEth: m ? m.outEth : 0,
      pnl: m ? m.pnl : -pos.sizeEth,
      exitTrades: m ? m.trades : null,
      tokens: undefined,   // large and not useful in the log
    };
    this.open.delete(pos.curve);
    this.closed.push(rec);
    try { fs.appendFileSync(this.file, JSON.stringify(rec) + '\n'); } catch { /* non-fatal */ }
    return rec;
  }

  /** Means lie when one trade is a 15x. Report the median and the top-1 share. */
  stats() {
    const n = this.closed.length;
    if (!n) return null;
    const p = this.closed.map((r) => r.pnl).sort((a, b) => a - b);
    const tot = p.reduce((a, b) => a + b, 0);
    const wins = p.filter((x) => x > 0).length;
    const best = p[p.length - 1];
    return {
      n, wins, winPct: (wins / n) * 100, total: tot,
      mean: tot / n, median: p[Math.floor(n / 2)],
      best, worst: p[0],
      topShare: tot > 0 ? (best / tot) * 100 : 0,
    };
  }
}

module.exports = { PaperBook, fetchTrades, replay, solveReserves, buyOut, sellOut };
