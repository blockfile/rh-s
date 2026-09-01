'use strict';

// Boot validation for the factory.
//
// A wrong or dormant factory address does not throw: the bot prints
// "watching for launches…" and waits forever. Two of the three known Pons
// deployments are dormant right now, and one of them is still the default in
// many .env files, so this is checked rather than assumed.
//
// Validates the same way the operator would by hand: read launchFee, read the
// config list, and confirm the thing has actually launched something recently.

const { Contract } = require('ethers');
const config = require('./config');
const { provider } = require('./chain');
const { FACTORY_ABI } = require('./abi');

const LAUNCH_TOPIC = '0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a';
const FEE_ABI = ['function launchFee() view returns (uint256)'];

async function validateFactory() {
  const { formatEther } = require('ethers');
  const code = await provider.getCode(config.factory);
  if (code === '0x') throw new Error(`no contract at FACTORY_ADDRESS ${config.factory}`);

  const fee = await new Contract(config.factory, FEE_ABI, provider).launchFee()
    .catch(() => { throw new Error(`${config.factory} has no launchFee() — not a Pons factory`); });

  const cfg = await new Contract(config.factory, FACTORY_ABI, provider).getLaunchConfig(0)
    .catch(() => { throw new Error(`${config.factory} has no getLaunchConfig(0) — not a Pons factory`); });
  if (!cfg.enabled) throw new Error('launchConfig 0 is disabled on this factory');

  // Liveness: a dormant factory is the failure mode that costs a day of
  // watching an empty screen.
  const head = await provider.getBlockNumber();
  let launches = 0;
  for (let s = head - 864_000; s <= head; s += 90_000) {
    const e = Math.min(s + 89_999, head);
    const logs = await provider.send('eth_getLogs', [{
      address: config.factory, topics: [LAUNCH_TOPIC],
      fromBlock: '0x' + s.toString(16), toBlock: '0x' + e.toString(16),
    }]).catch(() => []);
    launches += logs.length;
  }

  console.log(`factory  ${config.factory}`);
  console.log(`         launchFee ${formatEther(fee)} ETH | pair ${cfg.pairToken} | ` +
    `maxWallet ${cfg.maxWalletBps}bps | restrictionBlocks ${cfg.restrictionBlocks}`);
  console.log(`         ${launches} launches in the last 24h`);

  if (launches < config.minLaunchesPerDay) {
    throw new Error(
      `factory is DORMANT (${launches} launches/24h). This address will never fire.\n` +
      `  The live V2 factory is 0xf4fc0cd27fc8ecf17e55ee4c3f7201897df3eb75.\n` +
      `  Set FACTORY_ADDRESS, or MIN_LAUNCHES_PER_DAY=0 to watch anyway.`);
  }
  return { fee, cfg, launches };
}

module.exports = { validateFactory };
