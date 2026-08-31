'use strict';
// INDEPENDENT verification of the f1 composite rule. Written from scratch
// rather than reusing the search code, so agreement means something.
//
// Rule: at the first trade where net funding crosses 1% of graduationThreshold,
// buy if nBuyers>=2 AND buyerMaxCurves<=2 AND creatorPriorLaunches==0 AND fundPct<10%.

const fs = require('fs');
const coh = JSON.parse(fs.readFileSync(process.env.COHORT || 'research/data/cohort-12h.json', 'utf8'));
const bz  = JSON.parse(fs.readFileSync(process.env.BUYERS || 'research/scratch-features/buyers-12h.json', 'utf8'));

const AGG = 0.01, GAS = 0.00008;
const netQ = (t) => Number(t.q) - Number(t.f || 0) - Number(t.x || 0);
const buyOut  = (Q, T, q) => (T * q) / (Q + q);
const sellOut = (Q, T, t) => (Q * t) / (T + t);

function solve(trades) {
  const b = trades.filter((t) => t.buy).slice(0, 2);
  if (b.length < 2) return null;
  const q1 = netQ(b[0]), t1 = Number(b[0].t), q2 = netQ(b[1]), t2 = Number(b[1].t);
  const d = t1 * q2 - t2 * q1;
  if (!(Math.abs(d) > 0)) return null;
  const Q0 = (t2 * q1 * (q1 + q2)) / d;
  if (!(Q0 > 0) || !isFinite(Q0)) return null;
  const T0 = (t1 * (Q0 + q1)) / q1;
  return (T0 > 0 && isFinite(T0)) ? { Q0, T0 } : null;
}
function cost(trades) {
  const r = trades.filter((t) => t.buy && Number(t.q) > 0)
    .map((t) => (Number(t.f || 0) + Number(t.x || 0)) / Number(t.q)).sort((a, b) => a - b);
  return r.length ? r[Math.floor(r.length / 2)] : 0.03;
}

// recipient per (curve, block, logIndex)
const recip = new Map();
for (const [curve, flat] of Object.entries(bz.curves))
  for (let i = 0; i < flat.length; i += 4)
    recip.set(`${curve}|${flat[i]}|${flat[i + 1]}`, flat[i + 3]);

// creator prior launches — strictly earlier createdBlock only
const byCreator = new Map();
for (const c of coh.curves) (byCreator.get(c.creator) || byCreator.set(c.creator, []).get(c.creator)).push(c.createdBlock);
for (const v of byCreator.values()) v.sort((a, b) => a - b);
const priorLaunches = (c) => byCreator.get(c.creator).filter((b) => b < c.createdBlock).length;

// buyerMaxCurves: distinct curves a buyer touched STRICTLY BEFORE a given block.
// Built by one chronological pass so there is no lookahead.
const events = [];
for (const c of coh.curves)
  for (const t of c.trades) {
    const r = recip.get(`${c.curve}|${t.b}|${t.i}`);
    if (r !== undefined) events.push({ b: t.b, i: t.i, curve: c.curve, r });
  }
events.sort((a, b) => a.b - b.b || a.i - b.i);
const seen = new Map();           // buyerIdx -> Set(curve)
const curvesBefore = new Map();   // "curve|b|i" -> count for that buyer at that instant
for (const e of events) {
  let s = seen.get(e.r); if (!s) seen.set(e.r, s = new Set());
  curvesBefore.set(`${e.curve}|${e.b}|${e.i}`, s.size);
  s.add(e.curve);
}

const LAT = Number(process.env.LAT_BLOCKS || 1);
const SIZE = Number(process.env.SIZE || 0.1);
let fires = 0, grads = 0, tot = 0, wins = 0; const pnls = []; const TRADES = [];

for (const c of coh.curves) {
  const r = solve(c.trades); if (!r) continue;
  const thr = Number(c.gradThreshold); if (!(thr > 0)) continue;
  const CF = cost(c.trades), pl = priorLaunches(c);

  let Q = r.Q0, T = r.T0, funded = 0;
  const buyers = new Set(); let maxCurves = 0, trigger = null;

  for (const tr of c.trades) {
    const q = netQ(tr), t = Number(tr.t);
    const key = `${c.curve}|${tr.b}|${tr.i}`;
    const rc = recip.get(key);
    if (rc !== undefined) { buyers.add(rc); maxCurves = Math.max(maxCurves, curvesBefore.get(key) ?? 0); }
    if (tr.buy) { Q += q; T -= t; funded += q; } else { Q -= q; T += t; funded -= q; }
    if (T <= 0 || Q <= 0) break;

    if (trigger === null && funded / thr >= 0.01) {
      trigger = { b: tr.b, fundPct: funded / thr, nBuyers: buyers.size, maxCurves };
      break;
    }
  }
  if (!trigger) continue;
  if (!(trigger.nBuyers >= 2 && trigger.maxCurves <= 2 && pl === 0 && trigger.fundPct < 0.10)) continue;

  // replay to the entry point: LAT blocks after the trigger block
  Q = r.Q0; T = r.T0; funded = 0;
  let held = 0, entryB = null, spent = 0;
  for (const tr of c.trades) {
    if (held === 0 && entryB === null && tr.b > trigger.b + LAT - 1) {
      const net = SIZE * 1e18 * (1 - AGG) * (1 - CF);
      const got = buyOut(Q, T, net);
      if (!(got > 0)) break;
      held = got; entryB = tr.b; spent = SIZE + GAS; Q += net; T -= got; funded += net;
    }
    const q = netQ(tr), t = Number(tr.t);
    if (tr.buy) { Q += q; T -= t; funded += q; } else { Q -= q; T += t; funded -= q; }
    if (T <= 0 || Q <= 0) break;
    if (held > 0 && c.graduated && tr.b >= c.gradBlock) {
      const out = sellOut(Q, T, held) * (1 - CF) * (1 - AGG);
      const p = out / 1e18 - spent - GAS;
      fires++; grads++; tot += p; pnls.push(p); if (p > 0) wins++;
      TRADES.push({ entry: entryB, exit: tr.b, pnl: p, grad: true });
      held = 0; break;
    }
  }
  if (held > 0) { // never graduated: exit at the last observed curve state
    const out = sellOut(Q, T, held) * (1 - CF) * (1 - AGG);
    const p = out / 1e18 - spent - GAS;
    fires++; tot += p; pnls.push(p); if (p > 0) wins++;
    TRADES.push({ entry: entryB, exit: c.trades[c.trades.length - 1].b, pnl: p, grad: false });
  }
}
// keep entry/exit blocks for the sequential simulation
fs.writeFileSync(process.env.TRADES_OUT || 'research/scratch-main-trades.json', JSON.stringify(TRADES));
pnls.sort((a, b) => a - b);
console.log(`INDEPENDENT CHECK — f1 composite, latency ${LAT} block(s), size ${SIZE} ETH`);
console.log(`  fires        ${fires}`);
console.log(`  graduated    ${grads}  → precision ${(grads / fires * 100).toFixed(2)}%  (base rate 1.080%)`);
console.log(`  wins         ${wins}  (${(wins / fires * 100).toFixed(1)}%)`);
console.log(`  total P&L    ${tot.toFixed(4)} ETH`);
console.log(`  avg per pos  ${(tot / fires).toFixed(6)} ETH   median ${pnls[Math.floor(pnls.length / 2)].toFixed(6)}`);
console.log(`  best ${pnls[pnls.length - 1].toFixed(4)}   worst ${pnls[0].toFixed(4)}`);
