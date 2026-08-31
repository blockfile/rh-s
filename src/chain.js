'use strict';

// Provider, signer, and the one chain reading that is not obvious.

const { JsonRpcProvider, Wallet, Contract } = require('ethers');
const config = require('./config');
const { GET_BLOCK_NUMBER, ERC20_ABI } = require('./abi');

// staticNetwork skips the chain-id probe on every call. Small, but this sits on
// the path being optimised.
const provider = new JsonRpcProvider(config.rpcUrl, config.chainId, {
  staticNetwork: true,
});

const wallet = config.privateKey ? new Wallet(config.privateKey, provider) : null;

/**
 * block.number as a contract executing right now would see it.
 *
 * THIS IS NOT THE RPC BLOCK HEIGHT. Robinhood Chain produces an RPC block about
 * every 100ms, but block.number — which is what `block.number <= restrictionEnd`
 * and the launch-block check are written against — advances roughly every 12
 * seconds, derived from a parent chain. Reading eth_blockNumber here instead
 * would make the bot think the restriction lifted ~120 blocks early and every
 * buy would revert.
 */
async function evmBlockNumber() {
  const hex = await provider.call({ to: config.multicall3, data: GET_BLOCK_NUMBER });
  if (!hex || hex === '0x') throw new Error(`multicall3 at ${config.multicall3} returned nothing`);
  return BigInt(hex);
}

/** WETH, as a contract. The bot spends WETH, never native ETH. */
const weth = new Contract(config.weth, ERC20_ABI, wallet || provider);

module.exports = { provider, wallet, weth, evmBlockNumber };
