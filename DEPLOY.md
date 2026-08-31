# Deploying the curve sniper

The edge is entry latency and nothing else. Everything here exists to get a
buy onto the chain within ~1 block (100ms) of a curve being created.

**Do not skip step 4.** If the box is too slow the expectancy is negative and
the bot will lose money exactly as designed.

## 1. Box

A US VPS — the sequencer is in the US and that leg is irreducible. New York,
Ashburn, Chicago are all inside one block of each other. Cheapest tier is
fine; this idles between launches.

Ubuntu 22.04+ assumed.

```bash
sudo apt update && sudo apt install -y git curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v            # must be >= 20
```

## 2. Code

```bash
git clone https://github.com/blockfile/rh-s.git
cd rh-s
npm install
```

## 3. Wallet

Use a **fresh** wallet funded with only what you intend to risk. This is a hot
key sitting on a server: anything it can spend, it can lose.

```bash
cp .env.example .env
nano .env
```

Set `PRIVATE_KEY`, leave `DRY_RUN=true` for now. Fund the address with your
ticket plus gas — 0.1 ETH is enough for one 0.08 slot.

## 4. Prove the latency BEFORE risking anything

```bash
npm run latency
```

Want: `= 0 blk` and `This box is good`. Anything at 2+ blocks means the region
is wrong — try another datacenter rather than trading through it.

Then watch real launches for an hour:

```bash
npm run curve:watch          # broadcasts nothing
```

Want the histogram concentrated in `<=1 blk` / `2-3 blk` with few `SKIP late`
lines. That is the go/no-go. The ROI bands printed beside each bucket are
measured, not modelled.

## 5. Go live

Only once step 4 looks right:

```bash
sed -i 's/^DRY_RUN=true/DRY_RUN=false/' .env
npm run curve
```

Watch the first few round trips by hand before leaving it running.

## 6. Keep it up

```bash
sudo tee /etc/systemd/system/curve.service >/dev/null <<'UNIT'
[Unit]
Description=curve sniper
After=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/rh-s
ExecStart=/usr/bin/node curve.js
Restart=always
RestartSec=5
StandardOutput=append:/var/log/curve.log
StandardError=append:/var/log/curve.log

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now curve
journalctl -u curve -f
```

## Stopping

```bash
sudo systemctl stop curve
```

The bot also stops itself after `CURVE_MAX_LOSS_STREAK` consecutive losses or
`CURVE_MAX_DAILY_ETH` of spend. Those caps are the point — do not raise them
to "let it recover".

## Not yet exercised against real money

- `sell()` needs a token approval. The code handles it after the buy, but it
  has never run against a real balance.
- The 300bps assumed cost may be low on curves with a creator tax: 34% of buys
  pay one, up to 1000bps. Those buys should revert on the floor rather than
  fill badly, but that path is untested live.

Watch the first handful of trades before walking away.
