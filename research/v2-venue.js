'use strict';
// What actually happens to buyers on the Pons V2 factory venue (V3/WETH pools).
// No assumptions: read the launches, read the pool tape, measure entry cost and
// what the price did afterwards.

const { JsonRpcProvider, getAddress, formatEther } = require('ethers');
const p = new JsonRpcProvider(process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
  4663, { staticNetwork: true, batchMaxCount: 1 });

const V2 = '0xf4fc0cd27fc8ecf17e55ee4c3f7201897df3eb75';
const LAUNCH = '0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a';
const SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';

const w = (d, i) => BigInt('0x' + d.slice(2).slice(64 * i, 64 * (i + 1)));
const S = (v) => (v >= (1n << 255n) ? v - (1n << 256n) : v);
const un = (t) => getAddress('0x' + t.slice(26));

async function scan(f, from, to, chunk = 90000) {
  const out = [];
  for (let s = from; s <= to; s += chunk) {
    const e = Math.min(s + chunk - 1, to);
    for (let t = 0; t < 4; t++) {
      try { out.push(...await p.send('eth_getLogs', [{ ...f, fromBlock: '0x' + s.toString(16), toBlock: '0x' + e.toString(16) }])); break; }
      catch { await new Promise(r => setTimeout(r, 400)); }
    }
  }
  return out;
}

(async () => {
  const head = await p.getBlockNumber();
  const DAYS = Number(process.env.DAYS || 1);
  const from = head - Math.round(DAYS * 864000);
  const launches = (await scan({ address: V2, topics: [LAUNCH] }, from, head)).slice(-12);
  console.log(`V2 launches over ${DAYS}d: ${launches.length}\n`);

  const rows = [];
  for (const l of launches) {
    const d = l.data.slice(2);
    const token = un(l.topics[1]);
    const pool = getAddress('0x' + d.slice(64 + 24, 128));
    const restrEnd = BigInt('0x' + d.slice(64 * 5, 64 * 6));
    const devBuy = BigInt('0x' + d.slice(64 * 6, 64 * 7));
    const launchRpc = parseInt(l.blockNumber, 16);
    const lb = restrEnd - 366n;                       // EVM launch block

    // pool tape for the first ~600 RPC blocks (~5 EVM blocks)
    const swaps = await scan({ address: pool, topics: [SWAP] }, launchRpc, launchRpc + 600, 600);
    if (!swaps.length) { rows.push({ token, devBuy, n: 0 }); continue; }

    // token0/token1 ordering: WETH is one side
    const t0 = await p.call({ to: pool, data: '0x0dfe1681' }).then(r => '0x' + r.slice(26).toLowerCase()).catch(() => null);
    const wethIs0 = t0 === WETH;

    // Anchor once on the launch block and derive EVM offsets from the RPC
    // delta. One EVM block spans ~120 RPC blocks on this chain, and a
    // getBlockByNumber per swap is what made this unrunnable.
    const anchor = await p.send('eth_getBlockByNumber', ['0x' + launchRpc.toString(16), false]).catch(() => null);
    const l1Launch = anchor ? BigInt(parseInt(anchor.l1BlockNumber, 16)) : lb;
    const first = [];
    for (const s of swaps.slice(0, 6)) {
      const blk = parseInt(s.blockNumber, 16);
      const l1 = l1Launch + BigInt(Math.floor((blk - launchRpc) / 120));
      const a0 = S(w(s.data, 0)), a1 = S(w(s.data, 1));
      const ethAmt = wethIs0 ? a0 : a1;
      const tokAmt = wethIs0 ? a1 : a0;
      if (ethAmt <= 0n) continue;                     // only buys (ETH into pool)
      first.push({ off: Number(l1 - lb), rpcOff: blk - launchRpc, eth: ethAmt, tok: -tokAmt, who: un(s.topics[2]) });
    }
    rows.push({ token, devBuy, n: swaps.length, first });
  }

  console.log('launch                    devBuy      swaps  first buys (EVM offset / ETH in / px vs first)');
  let atPlus1 = 0, total = 0;
  for (const r of rows.slice(-18)) {
    let s = `  ${r.token.slice(0, 10)}  ${formatEther(r.devBuy).padStart(8)} ETH  ${String(r.n).padStart(4)}  `;
    if (r.first && r.first.length) {
      const base = Number(r.first[0].eth) / Number(r.first[0].tok);
      s += r.first.slice(0, 4).map(f => {
        const px = Number(f.eth) / Number(f.tok);
        if (f.off === 1) atPlus1++;
        total++;
        return `+${f.off}blk ${formatEther(f.eth).slice(0, 7)} ${(px / base).toFixed(2)}x`;
      }).join('  ');
    } else s += '(no buys)';
    console.log(s);
  }
  console.log(`\nbuys landing at exactly launchBlock+1: ${atPlus1} of ${total} early buys sampled`);
  const withBuys = rows.filter(r => r.first && r.first.length).length;
  console.log(`launches with ANY buy in the first ~5 EVM blocks: ${withBuys} of ${rows.length}`);
})();
