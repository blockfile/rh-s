'use strict';

// The bonding-curve venue. Separate from the V3/WETH factory in src/abi.js —
// different contracts, different event, different anti-snipe mechanism.

// PonsV2 curve registry. Announces every new curve.
const REGISTRY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';

// Verified by keccak match against the live contracts, not guessed.
const TOPIC = {
  // TokenLaunched(address indexed token, address indexed curve,
  //               address indexed deployer, address pairToken,
  //               uint256 launchConfigId, uint256 graduationThreshold)
  CREATE:     '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607',
  GRADUATE:   '0xcdb72f157fd3666758a6ce201387ffb52038c7562e4fff352828da1096c4b6b4',
  CURVE_BUY:  '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455',
  CURVE_SELL: '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df',
};

// Buying and selling happen ON THE CURVE ITSELF. There is no router in the
// path and no wrapper fee: a direct EOA call was measured at 80,583 gas with
// `tx.value - quoteIn == 0`, against the 1% the aggregator at 0x65050A9b
// skims. Both selectors match keccak exactly.
//
// The second argument is the profitability guard. A curve that has already
// been bought up returns fewer tokens; a floor makes that revert instead of
// filling. Reverts are the cheap outcome here — losing the race costs gas,
// losing the price costs the position.
const CURVE_ABI = [
  'function buy(uint256 amountIn, uint256 minTokensOut, address recipient) payable',
  'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient)',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function symbol() view returns (string)',
];

// Curves quoted in native ETH have pairToken == address(0). That is 50.4% of
// creations; the rest are quoted in USDG or Robinhood's tokenised equities and
// would each need their own price series to size a trade in ETH.
const ETH_QUOTE = '0x0000000000000000000000000000000000000000';

module.exports = { REGISTRY, TOPIC, CURVE_ABI, ERC20_ABI, ETH_QUOTE };
