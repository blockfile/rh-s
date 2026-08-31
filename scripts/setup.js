'use strict';

// One-time preparation: wrap ETH into WETH and approve the router.
//
// Both have to exist BEFORE a launch is seen. The window between the
// restriction lifting and the price moving is under a second, and an approval
// or a wrap inside it is a transaction that costs the fill it was meant to
// enable — which is why the bot spends WETH with value 0 rather than sending
// native ETH.
//
//   node scripts/setup.js                 show current state
//   node scripts/setup.js --wrap 0.5      wrap 0.5 ETH into WETH
//   node scripts/setup.js --approve       approve the router for max

const { formatEther, parseEther, MaxUint256 } = require('ethers');
const config = require('../src/config');
const { provider, wallet, weth } = require('../src/chain');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1] ?? true;
}

(async () => {
  if (!wallet) {
    console.error('PRIVATE_KEY is required.');
    process.exit(1);
  }

  const [eth, w, allowance] = await Promise.all([
    provider.getBalance(wallet.address),
    weth.balanceOf(wallet.address),
    weth.allowance(wallet.address, config.router),
  ]);

  console.log(`wallet     ${wallet.address}`);
  console.log(`native ETH ${formatEther(eth)}`);
  console.log(`WETH       ${formatEther(w)}`);
  console.log(`allowance  ${allowance === MaxUint256 ? 'unlimited' : formatEther(allowance)}`);
  console.log(`\nat ${config.buyEth} ETH per launch that is ${w / parseEther(config.buyEth)} buys of WETH runway`);

  const wrap = arg('wrap');
  if (wrap && wrap !== true) {
    console.log(`\nwrapping ${wrap} ETH…`);
    const tx = await weth.deposit({ value: parseEther(String(wrap)) });
    await tx.wait(1);
    console.log(`  done ${tx.hash}`);
  }

  if (arg('approve')) {
    console.log(`\napproving ${config.router} for unlimited WETH…`);
    const tx = await weth.approve(config.router, MaxUint256);
    await tx.wait(1);
    console.log(`  done ${tx.hash}`);
  }

  if (!wrap && !arg('approve')) {
    console.log('\nnothing changed. Pass --wrap <eth> and/or --approve to act.');
  }
})();
