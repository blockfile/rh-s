'use strict';
// Splits backtest results by outcome. The mechanical rule losing money does not
// tell you WHY: is the graduation trade itself unprofitable, or is it profitable
// but drowned by the 98.9% of curves that die? Those need different answers.

const fs = require('fs');
const bt = fs.readFileSync(require('path').join(__dirname, 'backtest.js'), 'utf8');
// reuse the simulator by loading it in a sandbox that exposes simulate()
const mod = { exports: {} };
new Function('module', 'exports', 'require', '__dirname', bt.replace(/^main\(\);$/m, 'module.exports = { simulate, curveCost };'))
  (mod, mod.exports, require, __dirname);
const { simulate } = mod.exports;

const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const curves = data.curves.filter((c) => c.trades.length >= 3);
const SIZE = 0.1, TIMEOUT = 1 * 36000;

console.log('Split by outcome — position 0.1 ETH, 1h timeout\n');
console.log('entry%  |        GRADUATED (perfect selection)      |            DIED                 | breakeven');
console.log('        |    n   hit%     avgPnL      totalPnL      |    n     avgPnL    totalPnL     | precision');
console.log('─'.repeat(112));

for (const pct of [0.05, 0.10, 0.25, 0.50, 0.75, 0.90]) {
  const g = [], d = [];
  for (const c of curves) {
    const s = simulate(c, pct, SIZE, TIMEOUT);
    if (!s) continue;
    (c.graduated ? g : d).push(s.pnl);
  }
  if (!g.length || !d.length) { console.log(`${(pct * 100).toFixed(0).padStart(5)}%  insufficient`); continue; }
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const gAvg = avg(g), dAvg = avg(d);
  const gHit = g.filter((x) => x > 0).length / g.length * 100;
  // A selector that picks graduating curves with precision p has expectancy
  // p*gAvg + (1-p)*dAvg. Break even at p = -dAvg / (gAvg - dAvg).
  const be = gAvg > dAvg ? (-dAvg / (gAvg - dAvg)) * 100 : NaN;
  console.log(
    `${(pct * 100).toFixed(0).padStart(5)}%  |${String(g.length).padStart(5)} ${gHit.toFixed(0).padStart(5)}%` +
    ` ${gAvg.toFixed(5).padStart(10)} ${(gAvg * g.length).toFixed(4).padStart(12)}      |` +
    `${String(d.length).padStart(5)} ${dAvg.toFixed(5).padStart(10)} ${(dAvg * d.length).toFixed(4).padStart(11)}     |` +
    `  ${isNaN(be) ? '  never' : be.toFixed(1).padStart(5) + '%'}`
  );
}
console.log('\nbase rate of graduation in cohort: ' +
  (data.curves.filter((c) => c.graduated).length / data.curves.length * 100).toFixed(3) + '%');
