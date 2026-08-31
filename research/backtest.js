'use strict';
// Stage 3+4: simulate an entry rule across the FULL cohort.
//
// Every position the rule opens is counted, including curves that never
// graduate. Those are not worth zero — they are sold back into the curve at
// the timeout. Scoring them at zero would overstate losses as badly as
// dropping them understates them.

const fs = require('fs');
const path = require('path');

const WAD = 10n ** 18n;
const f = (x) => Number(x) / 1e18;

// ── curve model ───────────────────────────────────────────────────────────
// The curve is constant-product against a virtual quote reserve. Given the
// first two buys we can solve (Q0, T0) exactly:
//   t1 = T0*q1/(Q0+q1)
//   t2 = (T0-t1)*q2/(Q0+q1+q2)
// => Q0 = t2*q1*(q1+q2) / (t1*q2 - t2*q1),  T0 = t1*(Q0+q1)/q1
// Solving per curve rather than assuming a global config means curves with
// different phantom reserves are each priced on their own terms.
const netQ = (tr) => Number(tr.q) - Number(tr.f || 0) - Number(tr.x || 0);

function solveReserves(trades) {
  const buys = trades.filter((t) => t.buy).slice(0, 2);
  if (buys.length < 2) return null;
  const q1 = netQ(buys[0]), t1 = Number(buys[0].t);
  const q2 = netQ(buys[1]), t2 = Number(buys[1].t);
  const denom = t1 * q2 - t2 * q1;
  if (!(Math.abs(denom) > 0)) return null;
  const Q0 = (t2 * q1 * (q1 + q2)) / denom;
  if (!(Q0 > 0) || !isFinite(Q0)) return null;
  const T0 = (t1 * (Q0 + q1)) / q1;
  if (!(T0 > 0) || !isFinite(T0)) return null;
  return { Q0, T0 };
}

const buyOut  = (Q, T, q) => (T * q) / (Q + q);      // tokens out for quote in
const sellOut = (Q, T, t) => (Q * t) / (T + t);      // quote out for tokens in

// ── costs ─────────────────────────────────────────────────────────────────
const AGG_FEE = 0.01;     // aggregator skims 1%, observed on-chain
const GAS = 0.00008;      // ETH per tx; A averaged 0.0000736 over 11 txs
// Curve cost is fee + tax, measured per curve from its own trades rather than
// assumed: on SPACEINU it is 1% + 2%, but the tax component is the decaying
// snipe tax and is not constant across curves or across a curve's life.
function curveCost(trades) {
  const rs = trades.filter((t) => t.buy && Number(t.q) > 0)
    .map((t) => (Number(t.f || 0) + Number(t.x || 0)) / Number(t.q))
    .sort((a, b) => a - b);
  if (!rs.length) return 0.03;
  return rs[Math.floor(rs.length / 2)];
}

function simulate(curve, entryPct, sizeEth, timeoutBlocks) {
  const r = solveReserves(curve.trades);
  if (!r) return null;
  const thresh = Number(curve.gradThreshold);
  if (!(thresh > 0)) return null;

  const CFEE = curveCost(curve.trades);
  let Q = r.Q0, T = r.T0, funded = 0;
  let held = 0, entryBlock = null, spent = 0;

  for (const tr of curve.trades) {
    const q = netQ(tr), t = Number(tr.t);

    // Enter the first time funding crosses the threshold, before this trade.
    if (held === 0 && entryBlock === null && funded / thresh >= entryPct) {
      const net = sizeEth * 1e18 * (1 - AGG_FEE) * (1 - CFEE);
      const got = buyOut(Q, T, net);
      if (!(got > 0)) return null;
      held = got; entryBlock = tr.b; spent = sizeEth + GAS;
      Q += net; T -= got; funded += net;   // our own buy moves the curve
    }

    // Replay the observed trade.
    if (tr.buy) { Q += q; T -= t; funded += q; } else { Q -= q; T += t; funded -= q; }
    if (T <= 0 || Q <= 0) return null;

    if (held > 0) {
      const graduated = curve.graduated && tr.b >= curve.gradBlock;
      const timedOut = tr.b - entryBlock >= timeoutBlocks;
      if (graduated || timedOut) {
        const out = sellOut(Q, T, held) * (1 - CFEE) * (1 - AGG_FEE);
        return { pnl: out / 1e18 - spent - GAS, entryBlock, exitBlock: tr.b, graduated };
      }
    }
  }
  if (held > 0) {
    // The curve went quiet: no further trades, so the in-loop timeout never
    // fired. This is the common case — 98.9% of curves die — and it MUST get a
    // real exit block, or the sequential simulation filters out every loser and
    // reports the survivors as if they were the whole population.
    const last = curve.trades[curve.trades.length - 1].b;
    const out = sellOut(Q, T, held) * (1 - CFEE) * (1 - AGG_FEE);
    return {
      pnl: out / 1e18 - spent - GAS,
      entryBlock,
      exitBlock: Math.max(last, entryBlock + timeoutBlocks),
      graduated: false,
    };
  }
  return null;
}

function main() {
  const file = process.argv[2] || path.join(__dirname, 'data', 'cohort-24h.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const curves = data.curves.filter((c) => c.trades.length >= 3);
  const SIZE = Number(process.env.SIZE || 0.1);
  const TIMEOUT = Number(process.env.TIMEOUT_H || 6) * 36000;

  console.log(`cohort: ${data.curves.length} ETH-quoted curves, ${curves.length} with >=3 trades`);
  console.log(`graduated: ${data.curves.filter((c) => c.graduated).length} (${(data.curves.filter((c) => c.graduated).length / data.curves.length * 100).toFixed(3)}%)`);
  console.log(`position size ${SIZE} ETH | timeout ${TIMEOUT / 36000}h | costs: ${AGG_FEE * 100}% agg + per-curve fee+tax + ${GAS} ETH/tx gas\n`);

  console.log('entry%   trades    wins   hit%      totalPnL      avgPnL     medPnL       best      worst');
  console.log('─'.repeat(96));
  const results = {};
  for (const pct of [0.05, 0.10, 0.25, 0.50, 0.75, 0.90]) {
    const rs = [];
    for (const c of curves) { const s = simulate(c, pct, SIZE, TIMEOUT); if (s) rs.push(s); }
    if (!rs.length) { console.log(`${(pct * 100).toFixed(0).padStart(5)}%        0`); continue; }
    const pnls = rs.map((x) => x.pnl).sort((a, b) => a - b);
    const tot = pnls.reduce((a, b) => a + b, 0);
    const wins = pnls.filter((x) => x > 0).length;
    results[pct] = rs;
    console.log(
      `${(pct * 100).toFixed(0).padStart(5)}%  ${String(rs.length).padStart(7)} ${String(wins).padStart(7)}` +
      `  ${(wins / rs.length * 100).toFixed(1).padStart(5)}%  ${tot.toFixed(4).padStart(12)}` +
      `  ${(tot / rs.length).toFixed(6).padStart(10)}  ${pnls[Math.floor(pnls.length / 2)].toFixed(6).padStart(9)}` +
      `  ${pnls[pnls.length - 1].toFixed(4).padStart(9)}  ${pnls[0].toFixed(4).padStart(9)}`
    );
  }

  // ── sequential bankroll: one position at a time, which is what 0.1 ETH buys ──
  console.log('\n\nSEQUENTIAL BANKROLL — 0.1 ETH, one position at a time');
  console.log('─'.repeat(96));
  console.log('entry%   taken   wins   hit%    final ETH    return%     maxDD%');
  for (const pct of [0.05, 0.10, 0.25, 0.50, 0.75, 0.90]) {
    const rs = (results[pct] || []).filter((x) => x.exitBlock).sort((a, b) => a.entryBlock - b.entryBlock);
    let bank = 0.1, freeAt = 0, taken = 0, wins = 0, peak = 0.1, dd = 0;
    for (const t of rs) {
      if (t.entryBlock < freeAt) continue;       // capital still tied up
      // Bet what is actually in the account, never a multiple of it. The P&L
      // is per SIZE, so scale DOWN when the bankroll is smaller and never up.
      const stake = Math.min(bank, SIZE);
      const scaled = t.pnl * (stake / SIZE);
      bank += scaled; freeAt = t.exitBlock; taken++;
      if (scaled > 0) wins++;
      peak = Math.max(peak, bank);
      dd = Math.max(dd, (peak - bank) / peak);
      if (bank <= 0.001) break;                  // busted
    }
    console.log(
      `${(pct * 100).toFixed(0).padStart(5)}%  ${String(taken).padStart(6)} ${String(wins).padStart(6)}` +
      `  ${(taken ? wins / taken * 100 : 0).toFixed(1).padStart(5)}%  ${bank.toFixed(5).padStart(10)}` +
      `  ${((bank / 0.1 - 1) * 100).toFixed(2).padStart(9)}%  ${(dd * 100).toFixed(2).padStart(8)}%`
    );
  }
}
main();
