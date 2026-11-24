// Late-curve breakout rider for the pump.fun replay (agent-fun/replay/v2).
// The grader runs `node /bot/main.ts`. Strategy lives in strategy.ts; the
// protocol shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
  onDone: (state, done) => {
    // Diagnostics only; stdout carries replies, so stderr is safe here.
    const cashSol = Number(state.cash) / 1e9;
    console.error(
      `late-curve breakout rider done: final cash ${cashSol.toFixed(3)} SOL, ` +
        `open positions ${done.account.positions.length}`,
    );
  },
});
