'use strict';

const { JsonRpcProvider, Wallet, Interface } = require('ethers');
const cfg = require('./config');
const { CURVE_ABI, ERC20_ABI } = require('./abi');

const provider = new JsonRpcProvider(cfg.rpcUrl, cfg.chainId, { staticNetwork: true });
const wallet = cfg.privateKey ? new Wallet(cfg.privateKey, provider) : null;

const curveIface = new Interface(CURVE_ABI);
const erc20Iface = new Interface(ERC20_ABI);

// Static fee params. No getFeeData on the hot path: priority is 0 because this
// chain orders by arrival, and the generous maxFee only stops a base-fee spike
// stranding the transaction.
const FEES = {
  maxFeePerGas: BigInt(Math.round(Number(cfg.maxFeeGwei) * 1e9)),
  maxPriorityFeePerGas: BigInt(Math.round(Number(cfg.priorityFeeGwei) * 1e9)),
};

// The nonce is tracked locally and incremented optimistically. Fetching it per
// transaction would add a round trip to the one path where round trips are the
// product being sold.
let nonce = null;
async function primeNonce() {
  if (!wallet) return null;
  nonce = await provider.getTransactionCount(wallet.address, 'pending');
  return nonce;
}
const takeNonce = () => (nonce === null ? null : nonce++);
async function resyncNonce() {
  if (!wallet) return;
  nonce = await provider.getTransactionCount(wallet.address, 'pending');
}

module.exports = { provider, wallet, curveIface, erc20Iface, FEES, primeNonce, takeNonce, resyncNonce };
