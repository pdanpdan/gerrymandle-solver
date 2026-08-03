import type { Puzzle } from './hex-utils.ts';

import { parentPort, workerData } from 'node:worker_threads';

import { solve } from './recom-solver.ts';

interface WorkerData {
  puzzle: Puzzle;
  seed: number;
  timeLimitMs: number;
  target: number;
  debug?: boolean;
}

const { puzzle, seed, timeLimitMs, target, debug = true } = workerData as WorkerData;

const reporter = debug
  ? (msg: string | { dot: number; }) => parentPort?.postMessage({ log: msg })
  : (msg: string | { dot: number; }) => parentPort?.postMessage(msg);

const result = solve(puzzle, timeLimitMs, target, seed, debug, reporter);
parentPort?.postMessage(result);
