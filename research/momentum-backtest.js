'use strict';

// Backtest the momentum rule: wait T seconds, require the crowd to have shown
// up already, then hold to graduation.
//
// Everything the repo has learned the hard way is baked in:
//  - a BUY adds (quoteIn - fee - tax) to the reserve, a SELL removes
//    (quoteOut + fee + tax) GROSS
//  - reserves are SOLVED per curve from its own first two buys, because the
//    configured phantomQuote/supply is wrong by up to 12x on some curves
//  - curves that never graduate are the overwhelming majority and are included
//    at their real sell-back value, neither dropped nor scored as zero
//  - the headline reports the MEDIAN and what survives with the best trades
//    removed, because the wallets this models made 42-75% of their profit from
//    one 15x

const fs = require('fs');

const netQ = (t) => Number(t.q) - Number(t.f || 0) - Number(t.x || 0);
const grossQ = (t) => Number(t.q) + Number(t.f || 0) + Number(t.x || 0);
const buyOut = (Q, T, q) => (T * q) / (Q + q);
const sellOut = (Q, T, t) => (Q * t) / (T + t);

function solveReserves(trades) {
  const b = trades.filter((t) => t.buy).slice(0, 2);
  if (b.length < 2) return null;
  const q1 = netQ(b[0]), t1 = Number(b[0].t), q2 = netQ(b[1]), t2 = Number(b[1].t);
  const den = t1 * q2 - t2 * q1;
  if (!(Math.abs(den) > 0)) return null;
  const Q0 = (t2 * q1 * (q1 + q2)) / den;
  if (!(Q0 > 0) || !isFinite(Q0)) return null;
  const T0 = (t1 * (Q0 + q1)) / q1;
  return (T0 > 0 && isFinite(T0)) ? { Q0, T0 } : null;
}

const GAS = 0.00016;   // buy + sell

/**
 * @param delayBlocks  RPC blocks to wait (100ms each) before deciding
 * @param minTrades    trades that must already have happened
 * @param minFundPct   % of graduation threshold already funded
 * @param holdBlocks   give up waiting for graduation after this many blocks
 */
function simulate(c, { delayBlocks, minTrades, minFundPct, maxCostBps, sizeEth, holdBlocks }) {
  const r = solveReserves(c.trades);
  if (!r) return null;
  const thresh = Number(c.gradThreshold);
  if (!(thresh > 0)) return null;

  const decideAt = c.createdBlock + delayBlocks;
  let Q = r.Q0, T = r.T0, funded = 0, seen = 0;
  const costs = [];
  let i = 0;

  // Replay only what was visible at the decision point.
  for (; i < c.trades.length; i++) {
    const tr = c.trades[i];
    if (tr.b > decideAt) break;
    if (tr.buy) {
      const q = netQ(tr);
      const gross = Number(tr.q);
      if (gross > 0) costs.push((Number(tr.f || 0) + Number(tr.x || 0)) * 10000 / gross);
      Q += q; T -= Number(tr.t); funded += q;
    } else {
      const g = grossQ(tr);
      Q -= g; T += Number(tr.t); funded -= g;
    }
    if (!(Q > 0) || !(T > 0)) return null;
    seen++;
  }

  const fundPct = (funded / thresh) * 100;
  costs.sort((a, b) => a - b);
  const costBps = costs.length ? costs[Math.floor(costs.length / 2)] : null;
  if (seen < minTrades || fundPct < minFundPct) return null;
  if (costBps === null || costBps > maxCostBps) return null;

  // Enter.
  const net = sizeEth * 1e18 * (1 - costBps / 10000);
  const tokens = buyOut(Q, T, net);
  if (!(tokens > 0)) return null;
  Q += net; T -= tokens; funded += net;
  const entryBlock = decideAt;

  // Hold to graduation, or bail at the timeout, marking against the real tape.
  let exitBlock = null, graduated = false;
  for (; i < c.trades.length; i++) {
    const tr = c.trades[i];
    if (c.graduated && c.gradBlock && tr.b >= c.gradBlock) { graduated = true; exitBlock = tr.b; break; }
    if (tr.b - entryBlock >= holdBlocks) { exitBlock = tr.b; break; }
    if (tr.buy) { Q += netQ(tr); T -= Number(tr.t); }
    else { Q -= grossQ(tr); T += Number(tr.t); }
    if (!(Q > 0) || !(T > 0)) return null;
  }
  if (exitBlock === null) exitBlock = c.trades.length ? c.trades[c.trades.length - 1].b : entryBlock;

  const out = sellOut(Q, T, tokens) * (1 - costBps / 10000) / 1e18;
  return { pnl: out - sizeEth - GAS, graduated, heldBlocks: exitBlock - entryBlock, fundPct, seen };
}

function split(rs, label) {
  const g = rs.filter((x) => x.graduated), d = rs.filter((x) => !x.graduated);
  const sum = (a) => a.reduce((x, y) => x + y.pnl, 0);
  const med = (a) => { if (!a.length) return 0; const p = a.map(x => x.pnl).sort((x, y) => x - y); return p[Math.floor(p.length / 2)]; };
  console.log('  ' + label);
  console.log('     graduated : n=' + String(g.length).padStart(4) +
    '  total ' + sum(g).toFixed(4).padStart(9) + '  median ' + med(g).toFixed(5).padStart(9) +
    '  (' + (rs.length ? (g.length / rs.length * 100).toFixed(1) : 0) + '% of trades)');
  console.log('     died      : n=' + String(d.length).padStart(4) +
    '  total ' + sum(d).toFixed(4).padStart(9) + '  median ' + med(d).toFixed(5).padStart(9));
  // How much would the post-graduation V4 leg have to add, per graduating
  // trade, just to break even overall? This backtest sells into the curve, but
  // the wallets modelled here sell into the pool AFTER migration.
  if (g.length) {
    const need = -(sum(g) + sum(d)) / g.length;
    console.log('     => the V4 leg would need to add ' + need.toFixed(5) +
      ' ETH per graduating trade just to reach breakeven');
  }
}

function summarise(rs, label) {
  if (!rs.length) { console.log(`  ${label.padEnd(34)} no trades`); return null; }
  const p = rs.map((x) => x.pnl).sort((a, b) => a - b);
  const tot = p.reduce((a, b) => a + b, 0);
  const wins = p.filter((x) => x > 0).length;
  const med = p[Math.floor(p.length / 2)];
  const best = p[p.length - 1];
  const exTop1 = p.slice(0, -1).reduce((a, b) => a + b, 0);
  const exTop3 = p.slice(0, -3).reduce((a, b) => a + b, 0);
  console.log(
    `  ${label.padEnd(34)}${String(rs.length).padStart(5)}` +
    `${(wins / rs.length * 100).toFixed(0).padStart(6)}%` +
    `${tot.toFixed(4).padStart(11)}` +
    `${med.toFixed(5).padStart(10)}` +
    `${best.toFixed(4).padStart(9)}` +
    `${exTop1.toFixed(4).padStart(11)}` +
    `${exTop3.toFixed(4).padStart(11)}`
  );
  return { n: rs.length, tot, med, best, exTop1, exTop3, winPct: wins / rs.length * 100 };
}

function main() {
  const file = process.argv[2] || 'research/data/cohort-48h.json';
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const curves = data.curves.filter((c) => c.trades.length >= 3);
  const SIZE = Number(process.env.SIZE || 0.05);
  const HOLD = Number(process.env.HOLD_MIN || 20) * 600;

  console.log(`cohort ${curves.length} ETH-quoted curves, ` +
    `${data.curves.filter((c) => c.graduated).length} graduated ` +
    `(${(data.curves.filter((c) => c.graduated).length / data.curves.length * 100).toFixed(2)}%)`);
  console.log(`size ${SIZE} ETH | hold cap ${HOLD / 600}m | gas ${GAS} ETH/round-trip\n`);

  // split by creation time for a genuine out-of-sample read
  const sorted = [...curves].sort((a, b) => a.createdBlock - b.createdBlock);
  const cut = Math.floor(sorted.length * 0.6);
  const early = sorted.slice(0, cut), late = sorted.slice(cut);

  const header = '  rule                                  n   win%      total    median     best   ex-top1   ex-top3';

  console.log('IN-SAMPLE (earlier 60%)');
  console.log(header);
  const grid = [];
  for (const delaySec of [30, 60, 120]) {
    for (const minTrades of [10, 30, 50]) {
      for (const minFundPct of [5, 20, 40]) {
        const opt = { delayBlocks: delaySec * 10, minTrades, minFundPct, maxCostBps: 500, sizeEth: SIZE, holdBlocks: HOLD };
        const rs = [];
        for (const c of early) { const s = simulate(c, opt); if (s) rs.push(s); }
        const label = `${delaySec}s / >=${minTrades} trades / >=${minFundPct}%`;
        const st = summarise(rs, label);
        if (st) grid.push({ opt, label, st });
      }
    }
  }

  const viable = grid.filter((g) => g.st.n >= 20).sort((a, b) => b.st.exTop3 - a.st.exTop3);
  if (!viable.length) { console.log('\nno configuration produced >=20 trades in-sample'); return; }

  console.log('\nBest by ex-top3 total (the number that is not one lucky name):');
  for (const g of viable.slice(0, 3)) console.log(`  ${g.label}  ex-top3 ${g.st.exTop3.toFixed(4)} ETH over ${g.st.n}`);

  console.log('');
  console.log('WHERE THE MONEY GOES (best config, in-sample)');
  {
    const g0 = viable[0];
    const rsplit = [];
    for (const c of early) { const s2 = simulate(c, g0.opt); if (s2) rsplit.push(s2); }
    split(rsplit, g0.label);
  }

  console.log('\nOUT-OF-SAMPLE (later 40%, no retuning)');
  console.log(header);
  for (const g of viable.slice(0, 3)) {
    const rs = [];
    for (const c of late) { const s = simulate(c, g.opt); if (s) rs.push(s); }
    summarise(rs, g.label);
  }
}
main();
