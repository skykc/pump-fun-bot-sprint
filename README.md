# pump-fun-bot-sprint

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/skykc/pump-fun-bot-sprint/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/skykc/pump-fun-bot-sprint/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

Slow-Starter Sniper: a paper-money pump.fun replay bot for make.fun's "Pump.fun Bot Sprint: Make Bot And Win" bounty. It trades the 6-hour replay of Solana pump.fun bonding-curve events and is ranked on net PnL.

## Run it

```sh
node main.ts
```

The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout: it reads the harness `hello`, answers every `batch` (with its `seq`) with a `reply` carrying its `orders`, and exits on `done`. No network, no secrets, no clock, no randomness — two runs produce byte-identical action logs.

## Strategy

Measured on the kit's dev replay (24h, 1,222 mints), the first trade of a coin lands in the same slot as its creation 98.8% of the time, and the fill 2 slots later already costs +18% median. Chasing the first pump buys the top: fast pumpers lose. So the bot only buys **slow starters**:

- **Entry:** a coin still young (≤15 trades, ≤1,800 slots since first sight) whose price is only +1% to +8% above its first price, with buy-dominated early flow (≥60% buy volume) and a clean creator (no creator sell in the early trades).
- **Pyramid:** at the 5th trade, if the creator is still clean, at least 4 distinct buyers have bought, and the price is at or above the probe entry, it adds the same size once.
- **Sizing:** 0.05 SOL per buy, capped at the harness max order (bps of real reserve) and by cash — well above the 0.01 SOL round-trip bar. At most 5 open positions, one trade per coin, never a re-entry after an exit.
- **Exits (wide on purpose):** take profit +25% vs average entry, a 20% trail from the peak since entry, a hard stop −12% vs average entry, a time-stop at 3,000 slots swept on every batch (a dead coin stops sending events, so its slot must still be freed), and an immediate sell on CompleteEvent.
- **Fills are authoritative:** the harness account snapshot and fills array decide what the bot holds and its average entry; a rejected fill leaves the state untouched so the next batch can retry it.

## Local validation (kit `grade-local`, process driver, dev replay)

| Entry cap | Net PnL | Round trips | Win rate | Max DD |
|---|---:|---:|---:|---:|
| +12% | −0.173 SOL | 190 | 18.4% | 2.0% |
| +10% | −0.106 SOL | 134 | 17.2% | 1.3% |
| +9% | −0.121 SOL | 120 | 15.0% | 1.4% |
| **+8% (shipped)** | **−0.067 SOL** | **97** | **16.5%** | **0.9%** |

Guardrails met on the shipped config: 97 coins hold a round trip of at least 0.01 SOL (bar: 20), max drawdown 0.9% (bar: 50%). Dev PnL is still slightly negative — the tape is hard: 125 bps of curve fees per trade plus a fixed tx fee, and a 2-slot latency that eats the first pump. The final window is fresh data recorded after entries close, so the dev number is a calibration, not a forecast.

---

<sub>Built by my AI agent on [make.fun](https://make.fun/?ref=6en97dxm) · AI agents build software for cash rewards</sub>
