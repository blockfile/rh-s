'use strict';

// Momentum entry — a reproduction of what seven measured wallets actually do.
//
// Those wallets made +0.86 to +3.09 ETH. They are NOT snipers. Measured:
//
//   entry delay        53-87 s after creation   (not +1 block)
//   trades already on  32-42
//   funding already    10-30% of threshold
//   creator tax        0 of 114 tokens carried the 1000bps maximum
//   exit               hold through graduation, then dump in 20-50 slices
//   selection result   17 of 45 curves graduated = 37.8% vs a 1.14% base rate
//
// Waiting a minute is not a compromise, it is the strategy. It also keeps the
// buy outside the +2..+10 block window where a 99% snipe tax fires — the
// window an earlier version of this repo aimed at, and lost money in.
//
// READ BEFORE RUNNING LIVE: those wallets made 42-75% of their profit from ONE
// token that did 15x. Strip the top 3 names and three of them are
// statistically indistinguishable from zero, and several LOSE their median
// trade. Expect a long string of small losses punctuated by rare large wins.

const { formatEther, parseEther, Contract } = require('ethers');
const cfg = require('./src/curve/config');
const { provider, wallet, curveIface, FEES, primeNonce, takeNonce, resyncNonce } = require('./src/curve/chain');
const { ERC20_ABI } = require('./src/curve/abi');
const { Tracker, run } = require('./src/curve/tracker');
const { PaperBook } = require('./src/curve/paper');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tracker = new Tracker();
const paper = new PaperBook();

const state = {
  seen: 0, evaluated: 0, qualified: 0, open: 0,
  wins: 0, losses: 0, pnl: 0, lossStreak: 0, spent: 0,
};

function capsBlock() {
  if (state.open >= cfg.maxConcurrent) return 'max concurrent';
  if (state.spent + Number(cfg.buyEth) > cfg.maxDailySpendEth) return 'daily spend cap';
  if (state.lossStreak >= cfg.maxConsecutiveLosses) return 'loss streak ' + state.lossStreak;
  return null;
}

// Does this curve look like the ones they buy?
function evaluate(c) {
  const trades = c.buys + c.sells;
  const funded = tracker.fundingPct(c);
  const cost = tracker.costBps(c);
  if (trades < cfg.minTrades) return { ok: false };
  if (funded < cfg.minFundingPct) return { ok: false };
  if (cost === null) return { ok: false };
  // Skip punitive curves. Read from the curve's own trades rather than launch
  // calldata: the modelled wallets bought 0 of 114 max-creator-tax tokens.
  if (cost > cfg.maxCostBps) return { ok: false };
  return { ok: true, trades, funded, cost };
}

async function sendBuy(c) {
  const amountIn = parseEther(cfg.buyEth);
  const data = curveIface.encodeFunctionData('buy', [amountIn, 0n, wallet.address]);
  return wallet.sendTransaction({
    to: c.curve, data, value: amountIn,
    gasLimit: cfg.gasLimit, nonce: takeNonce(), chainId: cfg.chainId, type: 2, ...FEES,
  });
}

// Their exit: hold through graduation, then sell in slices rather than one
// block-moving dump.
async function exitPosition(c, tokenBal) {
  const erc = new Contract(c.token, ERC20_ABI, wallet);
  const allowance = await erc.allowance(wallet.address, c.curve);
  if (allowance < tokenBal) {
    const a = await erc.approve(c.curve, (1n << 256n) - 1n, {
      gasLimit: 120000, nonce: takeNonce(), ...FEES,
    });
    await a.wait(1);
  }
  const slices = Math.max(1, cfg.exitSlices);
  const per = tokenBal / BigInt(slices);
  let sold = 0n;
  for (let i = 0; i < slices; i++) {
    const amt = i === slices - 1 ? tokenBal - sold : per;
    if (amt === 0n) break;
    try {
      const data = curveIface.encodeFunctionData('sell', [amt, 0n, wallet.address]);
      const tx = await wallet.sendTransaction({
        to: c.curve, data, value: 0n,
        gasLimit: cfg.gasLimit, nonce: takeNonce(), chainId: cfg.chainId, type: 2, ...FEES,
      });
      await tx.wait(1);
      sold += amt;
    } catch (err) {
      console.log('     slice ' + (i + 1) + '/' + slices + ' failed: ' +
        (err.shortMessage || err.message).slice(0, 60));
      await resyncNonce();
      break;
    }
    if (i < slices - 1) await sleep(cfg.exitSliceGapMs);
  }
  return sold;
}

async function trade(c, v) {
  const tag = new Date().toISOString().slice(11, 19) + ' ' + c.token.slice(0, 10);
  console.log(tag + '  BUY  ' + v.trades + ' trades, ' + v.funded.toFixed(1) +
    '% funded, cost ' + v.cost + 'bps');

  if (cfg.dryRun) {
    // Score it rather than just announce it. A dry run that only prints
    // "would buy" proves the trigger fires; it says nothing about whether
    // firing was a good idea, which is the only open question.
    c.fundedPct = v.funded;
    const pos = await paper.enter(c, Number(cfg.buyEth));
    if (!pos) { console.log('   [paper] could not price this curve, skipping'); return; }
    console.log('   [paper] opened ' + cfg.buyEth + ' ETH -> ' +
      (pos.tokens / 1e24).toFixed(2) + 'M tokens at ' + pos.costBps + 'bps');
    state.open++;
    trackPaper(c, pos).catch((e) => console.error('paper', e.message));
    return;
  }

  const before = await provider.getBalance(wallet.address);
  state.open++;
  state.spent += Number(cfg.buyEth);
  try {
    const tx = await sendBuy(c);
    const rec = await tx.wait(1);
    if (rec.status !== 1) throw new Error('buy reverted');
    console.log('   filled — ' + tx.hash);

    const erc = new Contract(c.token, ERC20_ABI, provider);
    const bal = await erc.balanceOf(wallet.address);
    if (bal === 0n) throw new Error('filled but received zero tokens');
    console.log('   holding ' + (Number(formatEther(bal)) / 1e6).toFixed(2) +
      'M tokens, waiting for graduation');

    const deadline = Date.now() + cfg.graduationWaitMs;
    while (Date.now() < deadline && !c.graduated) await sleep(2000);
    console.log(c.graduated
      ? '   GRADUATED — exiting in slices'
      : '   timeout — selling back into the curve');

    await exitPosition(c, bal);
    const after = await provider.getBalance(wallet.address);
    const delta = Number(formatEther(after - before));
    state.pnl += delta;
    if (delta > 0) { state.wins++; state.lossStreak = 0; }
    else { state.losses++; state.lossStreak++; }
    console.log('   closed ' + (delta >= 0 ? '+' : '') + delta.toFixed(6) +
      ' ETH | total ' + state.pnl.toFixed(5) + ' | W' + state.wins + '/L' + state.losses);
  } catch (err) {
    console.log('   no fill: ' + (err.shortMessage || err.message).slice(0, 80));
    await resyncNonce();
  } finally {
    state.open--;
  }
}

// Follow a paper position on the real curve until it graduates or times out.
async function trackPaper(c, pos) {
  const deadline = Date.now() + cfg.graduationWaitMs;
  try {
    while (Date.now() < deadline && !c.graduated) {
      await sleep(20000);
      const m = await paper.mark(pos).catch(() => null);
      if (m && m.outEth <= pos.sizeEth * 0.35) {   // same stop the live path uses
        const rec = await paper.close(pos, 'stop');
        return report(rec);
      }
    }
    const rec = await paper.close(pos, c.graduated ? 'graduated' : 'timeout');
    report(rec);
  } finally {
    state.open--;
  }
}

function report(rec) {
  if (!rec) return;
  state.pnl += rec.pnl;
  if (rec.pnl > 0) { state.wins++; state.lossStreak = 0; }
  else { state.losses++; state.lossStreak++; }
  console.log('   [paper] ' + rec.token.slice(0, 10) + ' ' + rec.reason +
    ' after ' + rec.heldSec + 's -> ' + (rec.pnl >= 0 ? '+' : '') + rec.pnl.toFixed(6) + ' ETH');
  const st = paper.stats();
  if (st) {
    console.log('   [paper] ' + st.n + ' closed | win ' + st.winPct.toFixed(0) + '% | ' +
      'total ' + st.total.toFixed(5) + ' | mean ' + st.mean.toFixed(6) +
      ' | MEDIAN ' + st.median.toFixed(6) +
      ' | best ' + st.best.toFixed(4) + ' (' + st.topShare.toFixed(0) + '% of total)');
  }
}

async function main() {
  console.log('momentum bot — ' + (cfg.dryRun ? 'DRY RUN (broadcasts nothing)' : 'LIVE'));
  console.log('wallet   ' + (wallet ? wallet.address : '(no PRIVATE_KEY — watch only)'));
  console.log('entry    wait ' + (cfg.entryDelayMs / 1000) + 's, need >=' + cfg.minTrades +
    ' trades and >=' + cfg.minFundingPct + '% funded, cost <=' + cfg.maxCostBps + 'bps');
  console.log('exit     hold to graduation (max ' + (cfg.graduationWaitMs / 60000) +
    'm), then ' + cfg.exitSlices + ' slices');
  console.log('ticket   ' + cfg.buyEth + ' ETH | caps ' + cfg.maxConcurrent + ' concurrent, ' +
    cfg.maxDailySpendEth + ' ETH/day, stop after ' + cfg.maxConsecutiveLosses + ' losses');

  if (!cfg.wsUrl) throw new Error('set WS_URL — this strategy tracks every live curve and needs push');
  if (wallet && !cfg.dryRun) {
    await primeNonce();
    const bal = await provider.getBalance(wallet.address);
    console.log('balance  ' + formatEther(bal) + ' ETH');
    if (bal < parseEther(cfg.buyEth)) throw new Error('balance below one ticket');
  }
  console.log('');

  await run(tracker, {
    onCreate: () => { state.seen++; },
    onGraduate: () => {},
  });

  setInterval(async () => {
    const now = Date.now();
    for (const c of tracker.ready(now)) {
      c.decided = true;
      state.evaluated++;
      try { await tracker.load(c); } catch { continue; }
      const v = evaluate(c);
      if (!v.ok) continue;
      const blocked = capsBlock();
      if (blocked) {
        console.log(new Date().toISOString().slice(11, 19) + ' ' + c.token.slice(0, 10) +
          '  SKIP — ' + blocked);
        continue;
      }
      state.qualified++;
      trade(c, v).catch((e) => console.error('trade', e.message));
    }
    tracker.sweep(now);
  }, 1000);

  setInterval(() => {
    const rate = state.evaluated ? (state.qualified / state.evaluated * 100).toFixed(2) : '0';
    console.log('\n── seen ' + state.seen + ' | evaluated ' + state.evaluated +
      ' | qualified ' + state.qualified + ' (' + rate + '%) | tracking ' + tracker.curves.size +
      (cfg.dryRun ? '' : ' | W' + state.wins + '/L' + state.losses + ' pnl ' + state.pnl.toFixed(5)) + '\n');
  }, 60000);
}

main().catch((e) => { console.error(e); process.exit(1); });
