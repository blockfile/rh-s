'use strict';
// Buyer identity for a SLICE of a cohort, chosen by creation block.
// Used to build an out-of-sample window disjoint from the one the rule was
// derived on. Slicing keeps the address set to a size the sweep survives.
const fs = require('fs');
const { TOPIC, sweep } = require('./lib');

const IN = process.env.IN, OUT = process.env.OUT;
const LO = Number(process.env.LO), HI = Number(process.env.HI);

async function main() {
  const data = JSON.parse(fs.readFileSync(IN, 'utf8'));
  const sel = data.curves.filter((c) => c.createdBlock >= LO && c.createdBlock <= HI);
  console.log(`slice ${LO}-${HI}: ${sel.length} curves, ${sel.filter(c=>c.graduated).length} graduated`);
  const want = new Set(sel.map((c) => c.curve));
  const addrs = [...want];
  const ids = new Map();
  const idOf = (a) => { let v = ids.get(a); if (v === undefined) { v = ids.size; ids.set(a, v); } return v; };
  const perCurve = new Map();
  let kept = 0;
  const onBatch = (logs) => {
    for (const l of logs) {
      const c = l.address.toLowerCase();
      if (!want.has(c)) continue;
      kept++;
      let arr = perCurve.get(c); if (!arr) { arr = []; perCurve.set(c, arr); }
      arr.push(parseInt(l.blockNumber, 16), parseInt(l.logIndex, 16),
        idOf('0x' + l.topics[1].slice(26).toLowerCase()),
        idOf('0x' + l.topics[2].slice(26).toLowerCase()));
    }
  };
  // trades can only occur at or after creation, so start the sweep at LO
  const BATCH = 400;
  for (let i = 0; i < addrs.length; i += BATCH) {
    const b = addrs.slice(i, i + BATCH);
    await sweep({ address: b, topics: [[TOPIC.CURVE_BUY, TOPIC.CURVE_SELL]] }, LO, data.head, onBatch,
      { chunk: 90000, label: `buyers ${i + b.length}/${addrs.length}` });
  }
  console.log(`kept ${kept} logs, ${ids.size} addresses`);
  fs.writeFileSync(OUT, JSON.stringify({ addrs: [...ids.keys()], curves: Object.fromEntries(perCurve) }));
  console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB)`);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
