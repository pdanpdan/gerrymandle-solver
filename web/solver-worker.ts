// Browser solver worker: runs one puzzle's solve() off the main thread.
// The solver modules are pure JS (no node builtins), so they run in a
// Web Worker as-is.

/// <reference lib="webworker" />

import type { PuzzlePayload } from '../solver/puzzle-utils.ts';

import { extract } from '../solver/puzzle-utils.ts';
import { solve } from '../solver/recom-solver.ts';

export interface SolveRequest {
  payload: PuzzlePayload;
  timeLimitMs: number;
  seed: number;
}

export interface SolveResult {
  partArray: Array<number | null> | null;
  wins: number;
  goal: number;
  timedOut: boolean;
  isStrictWin: boolean;
}

export type WorkerMessage = { type: 'dot'; } | { type: 'result'; result: SolveResult; };

const ctx = globalThis as unknown as {
  onmessage: ((e: MessageEvent<SolveRequest>) => void) | null;
  postMessage: (msg: WorkerMessage) => void;
};

ctx.onmessage = (e: MessageEvent<SolveRequest>) => {
  const { payload, timeLimitMs, seed } = e.data;
  const puzzle = extract({ payload });
  const result = solve(puzzle, timeLimitMs, 1, seed, false, () => {
    ctx.postMessage({ type: 'dot' });
  });
  ctx.postMessage({
    type: 'result',
    result: {
      partArray: result.partArray,
      wins: result.wins,
      goal: result.goal,
      timedOut: result.timedOut,
      isStrictWin: result.isStrictWin,
    },
  });
};
