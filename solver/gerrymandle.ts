#!/usr/bin/env node
import type { Puzzle, SolveResult } from './hex-utils.ts';

import fs from 'node:fs';
import { cpus } from 'node:os';
import { join as pathJoin } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import {
  addDays,
  DAY_ONE,
  dayDiff,
  deriveOrigin,
  extract,
  fetchPuzzle,
  fileStem,
  partyName,
  renderSVG,
  scorePartition,
  todayLocal,
} from './puzzle-utils.ts';

const DEFAULT_TIME_LIMIT_MS = 2 * 60 * 1000; // minutes per puzzle
const SEEDS_PER_PUZZLE = 4;

// Solution SVGs live next to the solver (repo root/solutions), not the CWD.
const SOLUTIONS_DIR = fileURLToPath(new URL('../solutions/', import.meta.url));

// ---------------------------------------------------------------------------
// Solver wrapper
// ---------------------------------------------------------------------------
async function solve(puzzle: Puzzle, timeLimitMs: number = DEFAULT_TIME_LIMIT_MS, bestMode = true, debugMode = true): Promise<SolveResult> {
  let playerHouses = 0;
  for (const tile of puzzle.tiles.values()) {
    if (tile.party === puzzle.playerParty) {
      playerHouses++;
    }
  }
  const minWinVotes = Math.floor(puzzle.housesPerDistrict / puzzle.partyCount) + 1;
  const theoreticalMax = Math.min(puzzle.regionCount, Math.floor(playerHouses / minWinVotes));

  // Goal: win the election.  A strict win needs playerWins > every opponent,
  // which can be as little as 1 district when all others are tied — so in
  // normal mode the target is simply "any strict win".  The site's stated
  // optimum is deliberately NOT the target: it can be a non-win (ties), or
  // simply wrong (e.g. day 26, whose API optimum of 1 is below the real
  // answer of 2).  In --best mode chase the theoretical maximum and keep the
  // best win found.  The inner solver's constructive phase still runs when
  // 2+ wins are spatially plausible, covering puzzles where an opponent is
  // forced to win and a 1-win strict election is impossible.
  const target = bestMode ? theoreticalMax : 1;

  if (debugMode) {
    console.log(`\n[DEBUG] Theoretical Maximum Wins: ${ theoreticalMax } (Player Houses: ${ playerHouses }, Min Votes to Win: ${ minWinVotes })`);
    console.log(`[DEBUG] Site Optimum: ${ puzzle.optimum }. Solver targeting: ${ bestMode ? target : 'any strict win' } wins.`);
  }

  // Run seeds in batches, one batch per CPU core.  Each seed receives
  // totalBudget / totalBatches as its time slice so the overall wall-clock
  // duration stays within the requested limit.
  const cores = Math.max(2, Math.floor(cpus().length / 1.2));
  const batches = Math.ceil(SEEDS_PER_PUZZLE / cores);
  const perBatch = Math.floor(timeLimitMs / batches);
  let seed = 1;

  let bestResult: SolveResult | null = null; // in bestMode, the best sub-target win across all batches
  let bestFallback: SolveResult | null = null; // best valid partition that cannot win the election (matches site optimum)

  for (let b = 0; b < batches; b++) {
    const workers: Worker[] = [];

    const runSeed = (s: number) => new Promise<SolveResult>((resolve: (v: SolveResult) => void, reject: (e: Error) => void) => {
      let settled = false;
      const w = new Worker(new URL('./solver-worker.ts', import.meta.url), {
        workerData: { puzzle, seed: s, timeLimitMs: perBatch, target, debug: debugMode },
      });
      workers.push(w);
      w.on('message', (msg) => {
        // Handle progress messages without settling the promise
        if (msg && msg.dot !== undefined) {
          process.stdout.write('.');
          return;
        }
        if (msg && msg.log !== undefined) {
          console.log(msg.log);
          return;
        }
        // Final result message
        if (!settled) {
          const isValid = msg && msg.partArray && msg.isStrictWin;
          if (isValid && msg.wins >= target) {
            // Found target win — return immediately
            settled = true;
            resolve(msg);
          } else if (bestMode && isValid) {
            // Sub-target strict win — store best, don't settle (let other workers compete)
            if (!bestResult || msg.wins > bestResult.wins) {
              bestResult = msg;
            }
          } else if (msg && msg.partArray && !msg.isStrictWin && msg.wins > 0 && msg.wins >= puzzle.optimum) {
            // Best-effort partition for puzzles where a strict win is
            // impossible (site optimum itself is a tie).  Keep the best,
            // don't settle — a strict winner may still arrive.
            if (!bestFallback || msg.wins > bestFallback.wins) {
              bestFallback = msg;
            }
          } else {
            settled = true;
            reject(new Error('invalid solver result'));
          }
        }
      });
      w.on('error', () => {
        if (!settled) {
          settled = true;
          reject(new Error('solver worker crashed'));
        }
      });
      w.on('exit', () => {
        if (!settled) {
          settled = true;
          reject(new Error('solver worker exited early'));
        }
      });
    });

    const promises = [];
    for (let i = 0; i < cores && seed <= SEEDS_PER_PUZZLE; i++, seed++) {
      promises.push(runSeed(seed));
    }

    let winner = null;
    try {
      winner = await Promise.any(promises);
    } catch {
      // All workers rejected — no target-meeting win in this batch
    }

    if (winner && winner.partArray && winner.isStrictWin && winner.wins >= target) {
      return winner;
    }
  }

  if (bestMode && bestResult) {
    return bestResult;
  }
  if (bestFallback) {
    return bestFallback;
  }
  return { partArray: null, wins: 0, goal: target, timedOut: true, isStrictWin: false };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function solvePuzzle(url: string, { timeLimitMs = DEFAULT_TIME_LIMIT_MS, quiet = false, bestMode = false, debugMode = false }: { timeLimitMs?: number; quiet?: boolean; bestMode?: boolean; debugMode?: boolean; } = {}): Promise<{ day: number; date: string; wins: number; optimum: number; } | null> {
  const log = quiet ? () => {} : (...a: unknown[]) => console.log(...a);

  if (!fs.existsSync(SOLUTIONS_DIR)) {
    fs.mkdirSync(SOLUTIONS_DIR, { recursive: true });
  }

  let fetched;
  try {
    fetched = await fetchPuzzle(url);
  } catch (err: unknown) {
    if (err instanceof Error && /HTTP 40[04]/.test(err.message)) {
      log(`No puzzle available at ${ url } (${ err.message }).`);
      return null;
    }
    throw err;
  }
  const { api, data } = fetched;
  const puzzle = extract(data);
  const playerName = partyName(puzzle.playerParty, puzzle);
  const K = puzzle.regionCount;

  log('');
  log('='.repeat(60));
  log(`  Day ${ puzzle.day }  (${ puzzle.date })`);
  log(`  API: ${ api }`);
  log('='.repeat(60));
  log(`  Win the election for: ${ playerName.toUpperCase() } (party ${ puzzle.playerParty })`);
  log(`  Draw ${ puzzle.regionCount } districts of ${ puzzle.housesPerDistrict } populated tiles each`);
  log(`  Board: ${ puzzle.width }x${ puzzle.height }, ${ puzzle.tiles.size } tiles, ${ puzzle.houses } houses`);
  const partyBreak: Record<number, number> = {};
  for (const [ , t ] of puzzle.tiles) {
    if (t.party !== null) {
      partyBreak[ t.party ] = (partyBreak[ t.party ] || 0) + 1;
    }
  }
  log(
    `  Houses by party: ${
      Object.entries(partyBreak)
        .map(([ p, c ]) => `${ partyName(Number(p), puzzle) }=${ c }`)
        .join(', ') }`,
  );
  log(`  Site's stated optimum wins for player: ${ puzzle.optimum }`);
  log('');

  // Write the best (optimum partition) SVG before solving
  if (puzzle.optimumPartition) {
    const optScored = scorePartition(puzzle.optimumPartition, puzzle);
    const optFile = pathJoin(SOLUTIONS_DIR, `${ fileStem(puzzle.date, puzzle.day, optScored.wins, K, 'best') }.svg`);
    fs.writeFileSync(
      optFile,
      renderSVG(
        puzzle,
        puzzle.optimumPartition,
        `Day ${ puzzle.day } - best: ${ playerName } ${ optScored.wins }/${ puzzle.regionCount }`,
        optScored,
      ),
    );
    log(`  Wrote ${ optFile }`);
  }

  log('Running solver...');
  const t0 = Date.now();
  const { partArray, timedOut } = await solve(puzzle, timeLimitMs, bestMode, debugMode);
  process.stdout.write('\n');
  const elapsed = Date.now() - t0;

  if (!partArray) {
    log(`No solution found${ timedOut ? ' (timed out)' : '' } after ${ elapsed }ms.`);
    if (!puzzle.optimumPartition) {
      const gridFile = pathJoin(SOLUTIONS_DIR, `${ fileStem(puzzle.date, puzzle.day, 0, K, 'grid') }.svg`);
      fs.writeFileSync(gridFile, renderSVG(puzzle, null, `Day ${ puzzle.day } - grid: no solution`));
      log(`  Wrote ${ gridFile }`);
    }
    return { day: puzzle.day, date: puzzle.date, wins: 0, optimum: puzzle.optimum };
  }

  const scored = scorePartition(partArray, puzzle);

  log(`Solver finished in ${ elapsed }ms${ timedOut ? ' (time-limited)' : '' }.`);
  log(`  Player districts won: ${ scored.wins } / ${ puzzle.regionCount }`);
  for (const r of scored.results) {
    const w = r.winner === null ? 'TIE' : partyName(r.winner, puzzle);
    const counts = Object.entries(r.counts)
      .map(([ p, c ]) => `${ partyName(Number(p), puzzle) }:${ c }`)
      .join(' ');
    const mark = r.winner === puzzle.playerParty ? ' <-- WIN' : '';
    log(`    District ${ r.region }: winner=${ w }  [${ counts }] (${ r.tileCount } tiles)${ mark }`);
  }

  // Only a strict election win counts as solved — otherwise the batch would
  // mark the puzzle done and never retry it.  A tied/lost partition is not
  // written (the _best_ SVG above still shows the site's optimum).
  if (scored.isStrictWin) {
    const solFile = pathJoin(SOLUTIONS_DIR, `${ fileStem(puzzle.date, puzzle.day, scored.wins, K, 'solv') }.svg`);
    fs.writeFileSync(
      solFile,
      renderSVG(
        puzzle,
        partArray,
        `Day ${ puzzle.day } - solv: ${ playerName } ${ scored.wins }/${ puzzle.regionCount }`,
        scored,
      ),
    );
    log(`  Wrote ${ solFile }`);
  }

  log('');
  if (scored.isStrictWin) {
    const playerNameUpper = playerName.toUpperCase();
    log(`RESULT: ${ playerNameUpper } WINS the election (${ scored.wins } districts vs opponent max ${ scored.maxOppWins })!`);
  } else {
    log(`RESULT: Player failed to win (${ scored.wins } districts won, opponent max ${ scored.maxOppWins }${ scored.wins > 0 && scored.wins <= scored.maxOppWins ? ' — TIED OR LOST' : '' }).`);
  }

  return { day: puzzle.day, date: puzzle.date, wins: scored.wins, optimum: puzzle.optimum };
}

async function solveAll(origin: string, { timeLimitMs = DEFAULT_TIME_LIMIT_MS, bestMode = false, debugMode = false }: { timeLimitMs?: number; bestMode?: boolean; debugMode?: boolean; } = {}) {
  const today = todayLocal();
  const lastDay = dayDiff(DAY_ONE, today) + 1;
  if (lastDay < 1) {
    console.log('No puzzles published yet.');
    return;
  }

  if (!fs.existsSync(SOLUTIONS_DIR)) {
    fs.mkdirSync(SOLUTIONS_DIR, { recursive: true });
  }

  const existing = new Set(fs.readdirSync(SOLUTIONS_DIR));
  const isSolved = (date: string, day: number): boolean => {
    const pfx = `${ date.replace(/-/g, '') }_${ day }_solv`;
    for (const f of existing) {
      if (f.startsWith(pfx) && f.endsWith('.svg')) {
        return true;
      }
    }
    return false;
  };

  const pending = [];
  for (let day = 1; day <= lastDay; day++) {
    const date = addDays(DAY_ONE, day - 1);
    if (!isSolved(date, day)) {
      pending.push({ day, date });
    }
  }

  console.log(`Days 1..${ lastDay } (${ DAY_ONE } .. ${ today }).`);
  console.log(`Already solved: ${ lastDay - pending.length }. To solve: ${ pending.length }.`);

  for (const { day, date } of pending) {
    const url = `${ origin }/?date=${ date }`;
    try {
      const r = await solvePuzzle(url, { timeLimitMs, bestMode, debugMode });
      if (!r) {
        console.log(`Day ${ day } (${ date }): not available yet, stopping.`);
        break;
      }
    } catch (err: unknown) {
      console.error(`Day ${ day } (${ date }): error - ${ err instanceof Error ? err.message : String(err) }`);
    }
  }
  console.log('\nBatch complete.');
}

function printUsage() {
  console.log(`
Gerrymandle Hex-Districting Solver

Usage:
  node gerrymandle-solver.js [options] [target_url / target_origin]

Options:
  -h, --help    Show this scannable usage manual.
  -all, --all   Execute historical batch solver from Day 1 to today.
                Accepts an optional local/custom origin URL as an extension.
  --best        Try to reach the maximum possible win count (by default
                the solver stops as soon as any winning partition is found).
  --time N      Total time budget in minutes (default 5).
  --debug       Print detailed solver progress (default: dots only).

Examples:
  node gerrymandle-solver.js
  node gerrymandle-solver.js --best --time 10
  node gerrymandle-solver.js https://gerrymandle.com/?date=2026-07-24
  node gerrymandle-solver.js --all --time 15
  node gerrymandle-solver.js --all http://localhost:3000
`);
}

async function main() {
  const args = process.argv.slice(2);

  // Parse --time N (minutes → ms)
  const timeIdx = args.indexOf('--time');
  const timeMinutes = timeIdx !== -1 ? Number(args[ timeIdx + 1 ]) || 0 : 0;
  const timeLimitMs = timeMinutes > 0 ? timeMinutes * 60 * 1000 : DEFAULT_TIME_LIMIT_MS;

  const bestMode = args.includes('--best');
  const debugMode = args.includes('--debug');
  const isAll = args.includes('--all') || args.includes('all');

  // Pick the first argument that looks like a URL or origin
  const targetUrl = args.find((a) => a.startsWith('http') || a.startsWith('/')) || 'https://gerrymandle.com/';

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  if (isAll) {
    const customOrigin = args.find((a) => a.startsWith('http'));
    const origin = deriveOrigin(customOrigin || 'https://gerrymandle.com/');
    await solveAll(origin, { timeLimitMs, bestMode, debugMode });
    return;
  }

  await solvePuzzle(targetUrl, { timeLimitMs, bestMode, debugMode });
}

if (process.argv[ 1 ] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
