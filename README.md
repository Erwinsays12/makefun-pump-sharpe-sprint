# Sharpe Sprint — Cleanest Paper Bot

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Erwinsays12/makefun-pump-sharpe-sprint/rank.svg)](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Erwinsays12/makefun-pump-sharpe-sprint/reward.svg)](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for the [Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) competition on make.fun.

## Idea

The ranking is **hourly Sharpe ratio**, not raw PnL — so this bot optimises for a
smooth equity curve: many small, diversified round trips, quick profit-taking,
tight stops, and no hero trades.

- **Entry:** a curve whose recent tape shows broad, accelerating buy pressure —
  several distinct buyers, net SOL flowing in, price up but not parabolic and
  sitting near its recent high — with real SOL reserves large enough that the
  1%-of-reserve size cap still allows a meaningful buy.
- **Sizing:** first buy 0.25 SOL, at most one pyramid add of 0.10 SOL while the
  position is up and inflow continues; max 0.35 SOL per coin, max 5 open
  positions, max 8 SOL exposure at cost.
- **Exits (mechanical):** take profit +15%, stop loss −10%, trailing stop once up
  6%, fade exit when short-window flow turns negative, time limit 1800 slots.
- **Guardrails:** a pacing guard opens tiny probe round trips when fills or
  distinct coins lag the pace, keeping the run above the minimum bar (round
  trips ≥ 0.01 SOL on ≥ 20 distinct mints, max drawdown 50%).

## Run

The entrypoint is `main.ts` (Node 22+, TypeScript run as-is). It speaks
`agent-fun/replay/v2` on stdin/stdout via the vendored SDK shim in
`vendor/makefun-bot.ts` — no dependencies to install, no network, no secrets.

```sh
node main.ts
```

## Strategy

See the header comment in `main.ts` for the full description of the entry
signal, exits, and pacing guard. All parameters live in `DEFAULT_PARAMS` at
the top of `main.ts`.

## License

MIT — see [LICENSE](LICENSE).
