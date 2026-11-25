// Sharpe Sprint — launch-sniper paper bot for the pump.fun replay.
// Entrypoint: speaks agent-fun/replay/v2 on stdin/stdout via the vendored SDK
// shim. The strategy lives in strategy.ts; see its header comment for the full
// description of the entry signal, the rug screen, the exits, and the pacing
// guard. No dependencies to install, no network, no secrets.

import { runBot } from './vendor/makefun-bot.ts';
import { createBot } from './strategy.ts';

await runBot(createBot());
