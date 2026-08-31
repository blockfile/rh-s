'use strict';
// Stage 1+2: sweep logs and join them into one record per ETH-quoted curve.
//
// Restricted to curves quoted in native ETH (pairToken 0x0), which is 51.75%
// of all creations. That keeps every number ETH-denominated with no FX
// conversion — the other curves are quoted in USDG and Robinhood's tokenised
// equities (SPY, NVDA, TSLA…) and would each need a price series.

const fs = require('fs');
const path = require('path');
const { provider, REGISTRY, TOPIC, ETH_QUOTE, addrOf, wordAt, sweep } = require('./lib');

const HOURS = Number(process.env.HOURS || 24);
const OUT = path.join(__dirname, 'data');

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const head = await provider.getBlockNumber();
  const blocks = Math.round(HOURS * 36000); // 100ms blocks
  const from = head - blocks;
  console.log(`window ${from} → ${head}  (${HOURS}h, ${blocks} blocks)`);

  // ── creations ───────────────────────────────────────────────────────────
  const curves = new Map(); // curve addr → record
  const byToken = new Map();
  let allCreations = 0;
  await sweep({ address: REGISTRY, topics: [TOPIC.CREATE] }, from, head, (logs) => {
    for (const l of logs) {
      allCreations++;
      const pairToken = '0x' + l.data.slice(2).slice(24, 64).toLowerCase();
      if (pairToken !== ETH_QUOTE) continue;
      const rec = {
        token: addrOf(l.topics[1]),
        curve: addrOf(l.topics[2]),
        creator: addrOf(l.topics[3]),
        gradThreshold: wordAt(l.data, 2).toString(),
        createdBlock: parseInt(l.blockNumber, 16),
        graduated: false,
        gradBlock: null,
        trades: [],
      };
      curves.set(rec.curve, rec);
      byToken.set(rec.token, rec);
    }
  }, { label: 'creations' });
  console.log(`  ${allCreations} creations total, ${curves.size} ETH-quoted (${(curves.size / allCreations * 100).toFixed(1)}%)`);

  // ── graduations ─────────────────────────────────────────────────────────
  let grads = 0;
  await sweep({ address: REGISTRY, topics: [TOPIC.GRADUATE] }, from, head, (logs) => {
    for (const l of logs) {
      grads++;
      const rec = byToken.get(addrOf(l.topics[1]));
      if (rec) { rec.graduated = true; rec.gradBlock = parseInt(l.blockNumber, 16); }
    }
  }, { label: 'graduations' });
  const ethGrads = [...curves.values()].filter((c) => c.graduated).length;
  console.log(`  ${grads} graduations total, ${ethGrads} of our ETH-quoted cohort`);

  // ── trades ──────────────────────────────────────────────────────────────
  // Filter server-side by curve address rather than sweeping every curve event
  // on the chain. ~48% of chain-wide curve traffic belongs to curves quoted in
  // USDG or tokenised equities and is pure waste to download; batching the
  // addresses we actually care about turns hours of sweeping into minutes.
  const addrs = [...curves.keys()];
  const BATCH = 400;
  let kept = 0;
  const onTrade = (logs) => {
    for (const l of logs) {
      const rec = curves.get(l.address.toLowerCase());
      if (!rec) continue;
      kept++;
      const isBuy = l.topics[0] === TOPIC.CURVE_BUY;
      // buy:  w0 quoteIn,  w1 tokensOut, w2 fee, w3 tax
      // sell: w0 tokensIn, w1 quoteOut,  w2 fee, w3 tax
      //
      // fee and tax are NOT cosmetic: the amount that actually reaches the
      // curve is quoteIn - fee - tax. Replaying with the gross quote misprices
      // the reserves by ~47% and every downstream number with it.
      rec.trades.push({
        b: parseInt(l.blockNumber, 16),
        i: parseInt(l.logIndex, 16),
        buy: isBuy,
        q: (isBuy ? wordAt(l.data, 0) : wordAt(l.data, 1)).toString(),
        t: (isBuy ? wordAt(l.data, 1) : wordAt(l.data, 0)).toString(),
        f: wordAt(l.data, 2).toString(),
        x: wordAt(l.data, 3).toString(),
      });
    }
  };
  for (let i = 0; i < addrs.length; i += BATCH) {
    const batch = addrs.slice(i, i + BATCH);
    await sweep(
      { address: batch, topics: [[TOPIC.CURVE_BUY, TOPIC.CURVE_SELL]] },
      from, head, onTrade,
      { chunk: 90000, label: `trades ${i + batch.length}/${addrs.length}` }
    );
  }
  console.log(`  ${kept} trades on our cohort`);

  for (const rec of curves.values()) rec.trades.sort((a, b) => a.b - b.b || a.i - b.i);

  const out = path.join(OUT, `cohort-${HOURS}h.json`);
  fs.writeFileSync(out, JSON.stringify({
    head, from, hours: HOURS, allCreations, grads,
    curves: [...curves.values()],
  }));
  console.log(`\nwrote ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
