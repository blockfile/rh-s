'use strict';

// Watch the factory, act on each launch.
//
//   npm run watch     price every launch, broadcast nothing
//   npm start         live (requires DRY_RUN=false in .env)

const { Contract, formatEther } = require('ethers');
const config = require('./src/config');
const { validateFactory } = require('./src/validate');
const { provider, wallet, weth } = require('./src/chain');
const { FACTORY_ABI } = require('./src/abi');
const { handleLaunch } = require('./src/sniper');

const factory = new Contract(config.factory, FACTORY_ABI, provider);

async function main() {
  if (!config.dryRun && !wallet) {
    console.error('PRIVATE_KEY is required for a live run. Set it, or use `npm run watch`.');
    process.exit(1);
  }

  console.log(`factory  ${config.factory}`);
  console.log(`router   ${config.router}`);
  console.log(`bid      ${config.buyEth} WETH per launch`);
  console.log(`skip if  dev buy >= ${config.maxDevBuyEth} ETH`);
  console.log(`floor    ${(100 - config.slippageBps / 100).toFixed(1)}% of expected output`);
  console.log(`mode     ${config.dryRun ? 'DRY RUN — nothing will be broadcast' : 'LIVE'}`);

  if (wallet) {
    const [bal, allowance] = await Promise.all([
      weth.balanceOf(wallet.address),
      weth.allowance(wallet.address, config.router),
    ]);
    console.log(`wallet   ${wallet.address}`);
    console.log(`WETH     ${formatEther(bal)} | approved to router: ${formatEther(allowance)}`);
    if (!config.dryRun && allowance === 0n) {
      console.error('\nrouter has no WETH allowance — run `npm run setup` first.');
      process.exit(1);
    }
  }

  // The launch config is read once. It is the same for every launch on this
  // factory — there is exactly one config and every launch uses it — so
  // fetching it per launch would only add a round trip to the hot path.
  //
  // Do not be tempted to use the event's `cfgId` here. On V2 it is a launch
  // sequence number (observed 881291…895966), not an index into
  // getLaunchConfig — every one of those ids reverts. Config 0 is the real
  // one; `restrictionsEndBlock - config0.restrictionBlocks` was checked
  // against the true launch block.number on 4 consecutive V2 launches, 4/4.
  // Refuse to run against a dormant or wrong factory. Silence is this bot's
  // worst failure mode: it looks identical to a quiet market.
  await validateFactory();

  const launchConfig = await factory.getLaunchConfig(0);
  console.log(
    `\nconfig   supply ${launchConfig.supply} | tick ${launchConfig.initialTick} | ` +
      `maxWallet ${launchConfig.maxWalletBps}bps | restrictionBlocks ${launchConfig.restrictionBlocks}`
  );
  console.log('\nwatching for launches…');

  factory.on(
    factory.filters.TokenLaunched(),
    async (token, deployer, dexFactory, pairToken, pool, dexId, cfgId, positionId, restrictionsEndBlock, initialBuyAmount) => {
      try {
        await handleLaunch({
          token,
          devBuyWei: initialBuyAmount,
          restrictionsEndBlock,
          launchConfig,
        });
      } catch (err) {
        console.error(`   handler error: ${err.message}`);
      }
    }
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
