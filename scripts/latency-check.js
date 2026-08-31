'use strict';

// Pick the endpoint AND prove the VPS region, from the box itself.
//
// The edge on this chain is entry latency: <=150ms returns +94.6%, 350-750ms
// +32.8%, past ~1.5s it is negative. Blocks are 100ms, so every 100ms of
// round trip is a block of lag and roughly a band of ROI.
//
// Run this on each candidate VPS before paying for a month:
//   node scripts/latency-check.js
//   QN_URL=https://your-endpoint.quiknode.pro/xxxx node scripts/latency-check.js

const { JsonRpcProvider, WebSocketProvider } = require('ethers');

const HTTP = [
  ['publicnode',   'https://robinhood-rpc.publicnode.com'],
  ['official',     'https://rpc.mainnet.chain.robinhood.com'],
  ...(process.env.QN_URL ? [['quicknode', process.env.QN_URL]] : []),
  ...(process.env.EXTRA_URL ? [['extra', process.env.EXTRA_URL]] : []),
];
const WS = [
  ['publicnode-ws', 'wss://robinhood-rpc.publicnode.com'],
  ...(process.env.QN_WS ? [['quicknode-ws', process.env.QN_WS]] : []),
];

const REGISTRY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
const CREATE = '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607';

const band = (ms) =>
  ms <= 150 ? '+94.6%  TOP BAND' :
  ms <= 350 ? '+52.4%  good' :
  ms <= 750 ? '+32.8%  workable' :
  ms <= 1500 ? ' +2.8%  marginal' : 'NEGATIVE — do not trade';

async function bench(name, url) {
  try {
    const p = new JsonRpcProvider(url, 4663, { staticNetwork: true, batchMaxCount: 1 });
    await p.getBlockNumber(); await p.getBlockNumber();     // warm keep-alive
    const t = [];
    for (let i = 0; i < 25; i++) {
      const s = process.hrtime.bigint();
      await p.send('eth_blockNumber', []);
      t.push(Number(process.hrtime.bigint() - s) / 1e6);
    }
    t.sort((a, b) => a - b);
    const med = t[Math.floor(t.length / 2)], p90 = t[Math.floor(t.length * 0.9)];
    console.log(`  ${name.padEnd(14)} median ${med.toFixed(0).padStart(5)}ms  p90 ${p90.toFixed(0).padStart(5)}ms  ` +
      `= ${Math.round(med / 100)} blk   ${band(med)}`);
    return { name, med };
  } catch (e) {
    console.log(`  ${name.padEnd(14)} FAILED  ${(e.shortMessage || e.message).slice(0, 50)}`);
    return null;
  }
}

async function benchWs(name, url) {
  try {
    const ws = new WebSocketProvider(url, 4663, { staticNetwork: true });
    await Promise.race([ws.getBlockNumber(),
      new Promise((_, r) => setTimeout(() => r(new Error('connect timeout')), 12000))]);
    let n = 0;
    const t0 = Date.now();
    await new Promise((res) => {
      ws.on({ address: REGISTRY, topics: [CREATE] }, () => { if (++n >= 3) res(); });
      setTimeout(res, 30000);
    });
    const secs = (Date.now() - t0) / 1000;
    console.log(`  ${name.padEnd(14)} push OK — ${n} creations in ${secs.toFixed(0)}s ` +
      `${n ? '(detection costs ZERO round trips)' : '(no events seen; try again)'}`);
    await ws.destroy();
  } catch (e) {
    console.log(`  ${name.padEnd(14)} FAILED  ${(e.shortMessage || e.message).slice(0, 50)}`);
  }
}

(async () => {
  console.log('\nHTTP send-path latency (this is what a buy costs to broadcast)\n');
  const rs = (await Promise.all(HTTP.map(([n, u]) => bench(n, u)))).filter(Boolean);
  console.log('\nWebSocket detection (removes the poll + one round trip)\n');
  for (const [n, u] of WS) await benchWs(n, u);

  const best = rs.sort((a, b) => a.med - b.med)[0];
  if (!best) return;
  const blocks = Math.round(best.med / 100);
  console.log(`\nVERDICT: best endpoint here is ${best.name} at ${best.med.toFixed(0)}ms (${blocks} blocks).`);
  if (blocks === 0) console.log('  This box is good. Expect fills at +1 block — the top ROI band.');
  else if (blocks <= 1) console.log('  Usable. Expect ~+2 blocks. A closer region would still help.');
  else console.log(`  TOO SLOW. Expect ~+${blocks + 1} blocks. Try a US (us-east) box — the sequencer is there.`);
  console.log('');
})();
