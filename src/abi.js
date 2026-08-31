'use strict';

// Only the fragments actually used, taken from the factory's verified ABI on
// robinhoodchain.blockscout.com and from Uniswap's SwapRouter02.

// The event that announces a launch. Everything needed to decide and to act
// arrives in this one log:
//   token                 what to buy
//   initialBuyAmount      the dev's atomic buy — the profitability filter
//   restrictionsEndBlock  launchBlock + restrictionBlocks, so the launch block
//                         is recoverable, and that is what gates buying
const FACTORY_ABI = [
  'event TokenLaunched(address indexed token, address indexed deployer, address indexed dexFactory, address pairToken, address pool, uint256 dexId, uint256 launchConfigId, uint256 positionId, uint256 restrictionsEndBlock, uint256 initialBuyAmount)',
  'function getLaunchConfig(uint256 id) view returns (tuple(address pairToken, uint256 graduationThreshold, int24 initialTick, uint256 supply, uint16 maxWalletBps, uint16 maxTxBps, uint32 restrictionBlocks, uint24 reservedFee, bool enabled, bool routerRequiresDeadline))',
];

// exactInputSingle is the single call the observed bot makes. It is payable,
// but that bot sends value 0 and spends WETH it already holds — one approval up
// front instead of a wrap on the hot path, which is the right trade when the
// hot path is the whole point.
const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function deposit() payable',
  'function withdraw(uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

// Multicall3.getBlockNumber() — block.number as a CONTRACT sees it, which on
// this chain is not the RPC height and is what every launch restriction is
// written against.
const GET_BLOCK_NUMBER = '0x42cbb15c';

module.exports = { FACTORY_ABI, ROUTER_ABI, ERC20_ABI, GET_BLOCK_NUMBER };
