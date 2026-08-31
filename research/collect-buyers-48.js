'use strict';
// Supplementary sweep: CURVE_BUY/SELL logs carry topics[1]=msg.sender (often a
// router) and topics[2]=recipient (the real buyer). collect.js kept only data
// words, so buyer identity has to be fetched separately. Keyed by (curve,b,i)
// so it zips onto the existing trade array exactly.
const fs = require('fs');
const path = require('path');
const { provider, TOPIC, sweep } = require('./lib');

const IN = process.env.IN;
const OUT = process.env.OUT;

async function main() {
  const data = JSON.parse(fs.readFileSync(IN, 'utf8'));
  const from = data.from, head = data.head;
  const want = new Set(data.curves.map((c) => c.curve));
  const addrs = [...want];

  const ids = new Map();          // addr -> int
  const idOf = (a) => { let v = ids.get(a); if (v === undefined) { v = ids.size; ids.set(a, v); } return v; };
  const perCurve = new Map();     // curve -> [b, i, senderId, recipId, ...]

  let kept = 0;
  const onBatch = (logs) => {
    for (const l of logs) {
      const c = l.address.toLowerCase();
      if (!want.has(c)) continue;
      kept++;
      let arr = perCurve.get(c); if (!arr) { arr = []; perCurve.set(c, arr); }
      arr.push(
        parseInt(l.blockNumber, 16), parseInt(l.logIndex, 16),
        idOf('0x' + l.topics[1].slice(26).toLowerCase()),
        idOf('0x' + l.topics[2].slice(26).toLowerCase()),
      );
    }
  };

  const BATCH = 400;
  for (let i = 0; i < addrs.length; i += BATCH) {
    const b = addrs.slice(i, i + BATCH);
    await sweep({ address: b, topics: [[TOPIC.CURVE_BUY, TOPIC.CURVE_SELL]] }, from, head, onBatch,
      { chunk: 90000, label: `buyers ${i + b.length}/${addrs.length}` });
  }
  console.log(`kept ${kept} logs, ${ids.size} distinct addresses`);
  fs.writeFileSync(OUT, JSON.stringify({
    addrs: [...ids.keys()],
    curves: Object.fromEntries(perCurve),
  }));
  console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
