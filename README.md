# rh-sniper

A launch buyer for `PonsLaunchFactory` on Robinhood Chain (chainId 4663).

It watches the factory's `TokenLaunched` event, prices the launch, waits for the
buy restriction to lift, and sends one `exactInputSingle` to the Uniswap router.
That is the whole program.

Every address, gas parameter and trade shape in here was read off the chain or
decoded from a working bot's transaction, not guessed. Where a number came from
observation rather than from the factory's own config, the comment says so.

## Setup

```bash
npm install
cp .env.example .env        # fill in PRIVATE_KEY
node scripts/setup.js                    # show balances and allowance
node scripts/setup.js --wrap 0.5 --approve
```

The wrap and the approval are **not optional**. The bot spends WETH with
`value: 0`, because the window between the restriction lifting and the price
moving is under a second — an approval or a wrap inside it costs the fill it was
meant to enable.

## Running

```bash
npm run watch     # prices every launch, broadcasts nothing
npm start         # live (needs DRY_RUN=false)
```

Watch it price real launches before going live. It prints what it would have
bid and what share that would have taken, which is the cheapest way to find out
whether your settings are sane.

## How it decides

One filter: **the size of the dev's atomic buy**, read straight out of the launch
event as `initialBuyAmount`.

The dev buy is the only trade that precedes everyone. It executes inside the
launch transaction, exempt from every cap, and it sets the price the entire field
enters at. Past a point, a small fixed ticket cannot clear its own gas.

Measured across 45 consecutive launches, the bot this models took essentially
every launch below ~1.0 ETH of dev buy and skipped **10 of 10** above it.

`MAX_DEV_BUY_ETH` encodes that. **It is calibrated for a small ticket.** Larger
operators on this chain bid ~0.07 ETH per wallet and profitably take launches
this bot would skip — if you raise `BUY_ETH`, raise the threshold with it.

## Why it does not race

Three things were measured on this chain, and each rules out an obvious idea:

- **Gas does not buy position.** Blocks are not sorted by price. A 0.00001 gwei
  transaction was observed landing ahead of a 0.067 gwei one in the same block.
  The ordering is by arrival. `PRIORITY_FEE_GWEI=0` is deliberate.
- **The window cannot be timed.** `block.number` — which is what the restriction
  is written against, and is *not* the RPC block height — advances about every
  12s with several seconds of jitter. So it is polled, not predicted.
- **Reacting is late by ~300–400ms.** That is the measured broadcast-to-inclusion
  lag. Bots that land at the very front got there by having transactions already
  in flight, and roughly 82% of their transactions revert as a result. This bot
  does not do that: it submits once, after the restriction lifts.

The consequence is honest and worth stating plainly: **this will usually not be
first.** The first legal block is ~123 RPC blocks wide, so getting *in* is easy;
being at the *front* of it is what sets the price, and that is contested by
operators willing to burn most of their gas on failures.

## The floor

`SLIPPAGE_BPS` sets `amountOutMinimum` as a haircut off the modelled output. It
is the profitability guard, not ordinary slippage tolerance: if someone landed
first and moved the price, the buy **reverts** instead of filling at whatever the
pool now asks.

Setting it to 0 would buy at any price. Don't.

The pricing model behind it was validated against twelve real launches with dev
buys from 0.05 to 3.5 ETH. It reads between +0.2% and +1.7% of what those buys
actually took, and every error is positive — it predicts slightly more tokens
than arrive, which keeps the floor conservative rather than too tight.

## Economics, before you fund it

The bot this models clears roughly **0.013 ETH per launch** on a 0.004 ETH
ticket. That works because it is early, disciplined, and unopposed on most
launches.

There are at least four separate operations already doing this on this factory,
one of which runs multiple wallets and bids ~17× larger. Adding another
participant means everyone takes smaller fills at worse prices. Fund it with an
amount you are willing to lose while you find out whether the edge survives
contact.

## Exit

Not implemented. The bots this models flip within minutes, but selling well is a
different problem from buying fast, and a half-considered auto-seller loses more
than it saves. Positions are left for you to manage.
