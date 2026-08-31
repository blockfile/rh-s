'use strict';

// Sub-second curve sniper.
//
// The edge here is entry latency and nothing else. Measured ROI by how long
// after creation the buy lands:
//
//     <=150ms  +94.6%      750-1500ms   +2.8%
//   150-350ms  +52.4%        1.5-3s     -5.0%
//   350-750ms  +32.8%         later     negative
//
// Graduation prediction is NOT the edge — wallets that picked graduating
// curves with 30-100% precision were profitable only 2.9% of the time, and one
// that hit 29 of 29 (p=4.5e-57) still lost money. So this bot does not try to
// pick winners. It tries to be early and to leave quickly.
//
// Run `npm run curve:watch` first. It broadcasts nothing and reports where
// your fills would actually land. If your latency histogram sits past ~6
// blocks, the expectancy is negative and going live will lose money.

const { formatEther, parseEther } = require('ethers');
const cfg = require('./src/curve/config');
const { provider, wallet, primeNonce, resyncNonce } = require('./src/curve/chain');
const { watch } = require('./src/curve/watcher');
const { buy, holdAndExit } = require('./src/curve/trader');
const { expectedTokens } = require('./src/curve/pricing');

const BANDS = [
  { max: 1,  label: '<=1 blk  (<=150ms)', roi: '+94.6%' },
  { max: 3,  label: '2-3 blk  (~350ms) ', roi: '+52.4%' },
  { max: 7,  label: '4-7 blk  (~750ms) ', roi: '+32.8%' },
  { max: 15, label: '8-15 blk (~1.5s)  ', roi: ' +2.8%' },
  { max: 30, label: '16-30blk (~3s)    ', roi: ' -5.0%' },
  { max: Infinity, label: '>30 blk           ', roi: 'NEGATIVE' },
];
const bandOf = (n) => BANDS.find((b) => n <= b.max);

const state = {
  seen: 0, acted: 0, skippedLate: 0, open: 0,
  spentToday: 0, lossStreak: 0, wins: 0, losses: 0, pnl: 0,
  lat: new Map(),
};

function recordLatency(blocks) {
  const b = bandOf(blocks);
  state.lat.set(b.label, (state.lat.get(b.label) || 0) + 1);
}

function printSummary() {
  const total = [...state.lat.values()].reduce((a, b) => a + b, 0);
  if (!total) return;
  console.log(`\n── fill latency over ${total} launches ` + '─'.repeat(34));
  for (const b of BANDS) {
    const n = state.lat.get(b.label) || 0;
    if (!n) continue;
    const pct = (n / total) * 100;
    console.log(`   ${b.label}  ${String(n).padStart(4)}  ${pct.toFixed(1).padStart(5)}%  ` +
      `${'█'.repeat(Math.round(pct / 2.5))} historical ROI ${b.roi}`);
  }
  console.log(`   seen ${state.seen} | acted ${state.acted} | skipped late ${state.skippedLate}` +
    (cfg.dryRun ? '' : ` | W${state.wins}/L${state.losses} | pnl ${state.pnl.toFixed(5)} ETH`));
  console.log('─'.repeat(72));
}

function capsBlock() {
  if (state.open >= cfg.maxConcurrent) return 'max concurrent positions';
  if (state.spentToday + Number(cfg.buyEth) > cfg.maxDailySpendEth) return 'daily spend cap';
  if (state.lossStreak >= cfg.maxConsecutiveLosses) return `loss streak ${state.lossStreak}`;
  return null;
}

async function handle(ev) {
  state.seen++;
  const lag = ev.headAtDetect - ev.createdBlock;   // RPC blocks, 100ms each
  const landing = lag + 1;                          // earliest block we could be in
  recordLatency(landing);

  const tag = `${new Date().toISOString().slice(11, 23)} ${ev.token.slice(0, 10)}`;
  if (landing > cfg.maxEntryBlocks) {
    state.skippedLate++;
    console.log(`${tag}  SKIP late — would land +${landing} blk (cap ${cfg.maxEntryBlocks}), expectancy negative`);
    return;
  }

  const blocked = capsBlock();
  if (blocked) { console.log(`${tag}  SKIP — ${blocked}`); return; }

  const amountIn = parseEther(cfg.buyEth);
  const tokens = expectedTokens(amountIn);
  console.log(`${tag}  BUY  +${landing} blk | ${cfg.buyEth} ETH -> ~${formatEther(tokens)} tok ` +
    `(${(Number(formatEther(tokens)) / 1e9 * 100).toFixed(2)}% of supply)`);

  if (cfg.dryRun) {
    console.log(`   [dry] would buy on curve ${ev.curve}`);
    return;
  }

  state.acted++; state.open++; state.spentToday += Number(cfg.buyEth);
  try {
    const tx = await buy(ev.curve);
    const rec = await tx.wait(1);
    const landed = rec.blockNumber - ev.createdBlock;
    if (rec.status !== 1) throw new Error('buy reverted');
    console.log(`   filled in block +${landed} — ${tx.hash}`);

    const before = await provider.getBalance(wallet.address);
    await holdAndExit({
      curve: ev.curve, token: ev.token, tokensHeld: tokens,
      spentWei: amountIn, onLog: (m) => console.log(m),
    });
    const after = await provider.getBalance(wallet.address);
    const delta = Number(formatEther(after - before)) - Number(cfg.buyEth);
    state.pnl += delta;
    if (delta > 0) { state.wins++; state.lossStreak = 0; } else { state.losses++; state.lossStreak++; }
    console.log(`   closed ${delta >= 0 ? '+' : ''}${delta.toFixed(6)} ETH (streak ${state.lossStreak})`);
  } catch (err) {
    // A revert is the designed outcome when someone landed first: the floor
    // did its job. It is information, not a fault.
    console.log(`   no fill: ${(err.shortMessage || err.message).slice(0, 90)}`);
    await resyncNonce();
  } finally {
    state.open--;
  }
}

async function main() {
  console.log(`curve sniper — ${cfg.dryRun ? 'DRY RUN (broadcasts nothing)' : 'LIVE'}`);
  console.log(`wallet   ${wallet ? wallet.address : '(no PRIVATE_KEY — watch only)'}`);
  console.log(`ticket   ${cfg.buyEth} ETH | floor ${cfg.slippageBps}bps | hold ${cfg.holdMs}ms`);
  console.log(`entry    reject past +${cfg.maxEntryBlocks} blocks | poll ${cfg.pollMs}ms`);
  console.log(`caps     ${cfg.maxConcurrent} concurrent | ${cfg.maxDailySpendEth} ETH/day | ` +
    `stop after ${cfg.maxConsecutiveLosses} losses`);
  if (wallet && !cfg.dryRun) {
    await primeNonce();
    const bal = await provider.getBalance(wallet.address);
    console.log(`balance  ${formatEther(bal)} ETH`);
    if (bal < parseEther(cfg.buyEth)) throw new Error('balance below one ticket');
  }
  console.log('\nwatching for curve creations…\n');
  setInterval(printSummary, 60_000);
  await watch((ev) => { handle(ev).catch((e) => console.error('handler', e.message)); });
}

main().catch((e) => { console.error(e); process.exit(1); });
