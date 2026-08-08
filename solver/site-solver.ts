// Restart-based constructive + hill-climbing solver, modelled on the approach
// the gerrymandle site itself uses (its solverWorker runs random constructive
// partitions, then greedily improves them with single-tile transfers between
// adjacent districts, mutates, and restarts thousands of times).
//
// Why this complements the ReCom SA: ReCom's balanced cuts confine the search
// to a dev=0 manifold that is disconnected — the 2-win configurations of some
// puzzles sit in basins unreachable from random starts.  Single-tile transfers
// do NOT preserve district sizes, so the climb can cross between basins; the
// dev-aware score then pulls it back to a balanced, valid partition.
//
// `seedDistricts` is an optional array of seed specs: each spec is either a
// single district (a Set of tile indices) or an array of districts; the
// construct places them as regions 0..n-1 and grows the rest randomly.
//
// Returns a full partition (every tile assigned to a district id 0..K-1) or
// null if nothing usable was found in the time budget.

import type { Puzzle } from './hex-utils.ts';

import { buildAdjacency, isHouse, makeRng, shuffle } from './hex-utils.ts';
/** State of a districting partition during search. */
interface SolverState {
  partition: number[];
  regionTiles: number[][];
  tallies: Map<number, number>[];
  housesIn: number[];
  winners: (number | null)[];
  margins: number[];
  dev: number;
  wins: number;
  oppWins: Map<number, number>;
  oppMaxWins: number;
  totalMargin: number;
  oppTotalMargin: number;
}

// Score comparison: election won > more wins > fewer opponent wins >
// balanced (dev) > bigger player margins > smaller opponent margins.
// Validity (dev = 0) is deliberately NOT first: the search must be able
// to record unbalanced winning states and rebalance them later.
function better(a: SolverState, b: SolverState): boolean {
  const ea = a.wins > a.oppMaxWins ? 1 : 0;
  const eb = b.wins > b.oppMaxWins ? 1 : 0;
  if (ea !== eb) {
    return ea > eb;
  }
  if (a.wins !== b.wins) {
    return a.wins > b.wins;
  }
  if (a.oppMaxWins !== b.oppMaxWins) {
    return a.oppMaxWins < b.oppMaxWins;
  }
  if (a.dev !== b.dev) {
    return a.dev < b.dev;
  }
  if (a.totalMargin !== b.totalMargin) {
    return a.totalMargin > b.totalMargin;
  }
  return a.oppTotalMargin < b.oppTotalMargin;
}

function winnerOf(tally: Map<number, number>): { winner: number | null; margin: number; } {
  let best = -1;
  let winner = null;
  let tie = false;
  let second = 0;
  for (const [ party, c ] of tally) {
    if (c > best) {
      second = best;
      best = c;
      winner = party;
      tie = false;
    } else if (c === best) {
      tie = true;
    } else if (c > second) {
      second = c;
    }
  }
  if (tie || best <= 0) {
    return { winner: null, margin: 0 };
  }
  return { winner, margin: best - second };
}

// The rebalance works best from the most BALANCED won state: prefer low
// dev first (unbalanced high-win states like 4 wins at dev 4 often cannot
// be rebalanced while staying won), then more wins, then fewer opponent
// wins.
function betterWon(a: SolverState, b: SolverState): boolean {
  if (a.dev !== b.dev) {
    return a.dev < b.dev;
  }
  if (a.wins !== b.wins) {
    return a.wins > b.wins;
  }
  return a.oppMaxWins < b.oppMaxWins;
}
/**
 * Restart-based constructive + hill-climbing solver.
 *
 * @param puzzle - The puzzle object with regionCount, housesPerDistrict,
 *                 playerParty, and tiles Map.
 * @param timeBudgetMs - Solver budget in milliseconds (default 20000).
 * @param targetWins - Target player wins (default 2).
 * @param seedDistricts - Optional array of seed specs: each spec is a Set
 *                        of tile indices or an array of Sets.
 * @returns A full partition ({assign, wins, maxOpp, dev, restarts}) or null
 *          if nothing usable was found in the time budget.
 */
export function siteStyleSolve(
  puzzle: Puzzle,
  timeBudgetMs = 20000,
  targetWins = 2,
  seedDistricts: number[][] | null = null,
): { assign: Map<number, number>; wins: number; maxOpp: number; dev: number; restarts: number; } | null {
  const deadline = Date.now() + timeBudgetMs;
  const adj = buildAdjacency(puzzle);
  const K = puzzle.regionCount;
  const size = puzzle.housesPerDistrict;
  const PP = puzzle.playerParty;
  const tiles = [ ...puzzle.tiles.keys() ];
  const houses = tiles.filter((i) => isHouse(puzzle.tiles.get(i)));
  const rand = makeRng((Math.random() * 0x7FFFFFFF) | 0);
  const partLen = Math.max(...tiles) + 1;

  function makeState(partition: number[], regionTiles: number[][]): SolverState {
    const tallies: Map<number, number>[] = Array.from({ length: K }, () => new Map());
    const housesIn: number[] = Array.from<number>({ length: K }).fill(0);
    const winners: (number | null)[] = Array.from<number | null>({ length: K }).fill(null);
    const margins: number[] = Array.from<number>({ length: K }).fill(0);
    let dev = 0;
    for (let r = 0; r < K; r++) {
      const tally = tallies[ r ];
      for (const i of regionTiles[ r ]) {
        const t = puzzle.tiles.get(i);
        if (t && isHouse(t)) {
          housesIn[ r ]++;
          tally.set(t.party!, (tally.get(t.party!) || 0) + 1);
        }
      }
      dev += Math.abs(housesIn[ r ] - size);
      const w = winnerOf(tally);
      winners[ r ] = w.winner;
      margins[ r ] = w.margin;
    }
    return recomputeAggregates({ partition, regionTiles, tallies, housesIn, winners, margins, dev } as SolverState);
  }

  function recomputeAggregates(st: SolverState): SolverState {
    const oppWins = new Map<number, number>();
    let wins = 0;
    let totalMargin = 0;
    let oppTotalMargin = 0;
    for (let r = 0; r < K; r++) {
      const w = st.winners[ r ];
      if (w === null) {
        continue;
      }
      if (w === PP) {
        wins++;
        totalMargin += st.margins[ r ];
      } else {
        oppWins.set(w, (oppWins.get(w) || 0) + 1);
        oppTotalMargin += st.margins[ r ];
      }
    }
    let oppMaxWins = 0;
    for (const c of oppWins.values()) {
      if (c > oppMaxWins) {
        oppMaxWins = c;
      }
    }
    st.wins = wins;
    st.oppWins = oppWins;
    st.oppMaxWins = oppMaxWins;
    st.totalMargin = totalMargin;
    st.oppTotalMargin = oppTotalMargin;
    return st;
  }

  // Transfer t from region o to region s (o stays connected — checked by the
  // caller).  Returns a NEW state with the move applied incrementally.
  function applyTransfer(st: SolverState, t: number, o: number, s: number): SolverState {
    const tile = puzzle.tiles.get(t)!;
    const isH = isHouse(tile);
    const oHousesOld = st.housesIn[ o ];
    const sHousesOld = st.housesIn[ s ];
    const dev = st.dev - (Math.abs(oHousesOld - size) + Math.abs(sHousesOld - size));

    const partition = st.partition.slice();
    partition[ t ] = s;
    const regionTiles = st.regionTiles.slice();
    regionTiles[ o ] = regionTiles[ o ].filter((x) => x !== t);
    regionTiles[ s ] = [ ...regionTiles[ s ], t ];
    const housesIn = st.housesIn.slice();
    housesIn[ o ] = oHousesOld - (isH ? 1 : 0);
    housesIn[ s ] = sHousesOld + (isH ? 1 : 0);

    const tallies = st.tallies.slice();
    const winners = st.winners.slice();
    const margins = st.margins.slice();

    const oTally = new Map(tallies[ o ]);
    tallies[ o ] = oTally;
    if (isH) {
      const p = tile.party!;
      const c = oTally.get(p)! - 1;
      if (c <= 0) {
        oTally.delete(p);
      } else { oTally.set(p, c); }
    }
    const sTally = new Map(tallies[ s ]);
    tallies[ s ] = sTally;
    if (isH) {
      const p = tile.party!;
      sTally.set(p, (sTally.get(p) || 0) + 1);
    }

    let w = winnerOf(oTally);
    winners[ o ] = w.winner;
    margins[ o ] = w.margin;
    w = winnerOf(sTally);
    winners[ s ] = w.winner;
    margins[ s ] = w.margin;

    const st2 = {
      partition,
      regionTiles,
      tallies,
      housesIn,
      winners,
      margins,
      dev: dev + Math.abs(housesIn[ o ] - size) + Math.abs(housesIn[ s ] - size),
      wins: st.wins,
      oppWins: new Map(st.oppWins),
      oppMaxWins: st.oppMaxWins,
      totalMargin: st.totalMargin,
      oppTotalMargin: st.oppTotalMargin,
    };
    for (const r of [ o, s ]) {
      const oldW = st.winners[ r ];
      const newW = winners[ r ];
      if (oldW === newW) {
        continue;
      }
      if (oldW !== null) {
        if (oldW === PP) {
          st2.wins--;
          st2.totalMargin -= st.margins[ r ];
        } else {
          const c = (st2.oppWins.get(oldW) || 0) - 1;
          if (c <= 0) {
            st2.oppWins.delete(oldW);
          } else { st2.oppWins.set(oldW, c); }
          st2.oppTotalMargin -= st.margins[ r ];
        }
      }
      if (newW !== null) {
        if (newW === PP) {
          st2.wins++;
          st2.totalMargin += margins[ r ];
        } else {
          st2.oppWins.set(newW, (st2.oppWins.get(newW) || 0) + 1);
          st2.oppTotalMargin += margins[ r ];
        }
      }
    }
    let oppMax = 0;
    for (const c of st2.oppWins.values()) {
      if (c > oppMax) {
        oppMax = c;
      }
    }
    st2.oppMaxWins = oppMax;
    return st2;
  }

  // ---------------------------------------------------------------------
  // Random constructive partition: seeds + round-robin growth preferring
  // houses (fewer empty tiles absorbed).  Returns a valid (balanced +
  // connected) state or null.
  // ---------------------------------------------------------------------
  function constructRandom(seedDistrict: number[] | number[][] | null): SolverState | null {
    for (let attempt = 0; attempt < 200; attempt++) {
      const partition: number[] = Array.from<number>({ length: partLen }).fill(-1);
      const regionTiles: number[][] = Array.from({ length: K }, (): number[] => []);
      const assigned = new Set<number>();
      let seedStart = 0;
      if (seedDistrict) {
        // A seed spec is one or more anchored districts (e.g. two player-
        // winning snakes); the remaining regions are seeded from houses
        // outside them.
        const specs: number[][] = Array.isArray(seedDistrict[ 0 ]) ? (seedDistrict as number[][]) : [ seedDistrict as number[] ];
        for (let si = 0; si < specs.length; si++) {
          for (const t of specs[ si ]) {
            partition[ t ] = si;
            regionTiles[ si ].push(t);
            assigned.add(t);
          }
        }
        seedStart = specs.length;
      }
      const pool = houses.filter((h) => !assigned.has(h));
      shuffle(pool, rand);
      for (let r = seedStart; r < K; r++) {
        if (pool.length === 0) {
          break;
        }
        const seed = pool.pop()!;
        partition[ seed ] = r;
        regionTiles[ r ].push(seed);
        assigned.add(seed);
      }
      const regionOrder = Array.from({ length: K }, (_, i) => i);
      let progress = true;
      while (progress && assigned.size < tiles.length) {
        progress = false;
        shuffle(regionOrder, rand);
        for (const r of regionOrder) {
          const candidates: number[] = [];
          for (const i of regionTiles[ r ]) {
            for (const n of (adj.get(i) || [])) {
              if (partition[ n ] < 0) {
                candidates.push(n);
              }
            }
          }
          if (candidates.length === 0) {
            continue;
          }
          const houseCands = candidates.filter((i) => isHouse(puzzle.tiles.get(i)));
          const pool2 = houseCands.length > 0 ? houseCands : candidates;
          const chosen = pool2[ Math.floor(rand() * pool2.length) ];
          partition[ chosen ] = r;
          regionTiles[ r ].push(chosen);
          assigned.add(chosen);
          progress = true;
        }
      }
      if (assigned.size !== tiles.length) {
        continue;
      }
      if (regionTiles.some((rt) => rt.length === 0)) {
        continue;
      }
      const st = makeState(partition, regionTiles);
      // Unseeded constructs must be valid starting points; seeded ones may
      // be unbalanced — the climb rebalances them.
      if (!seedDistrict && st.dev !== 0) {
        continue;
      }
      let ok = true;
      for (let r = 0; r < K; r++) {
        const list = regionTiles[ r ];
        const seen = new Set([ list[ 0 ] ]);
        const stack = [ list[ 0 ] ];
        while (stack.length) {
          const u = stack.pop()!;
          for (const v of adj.get(u) || []) {
            if (partition[ v ] === r && !seen.has(v)) {
              seen.add(v);
              stack.push(v);
            }
          }
        }
        if (seen.size !== list.length) {
          ok = false;
          break;
        }
      }
      if (ok) {
        return st;
      }
    }
    return null;
  }

  function canTransfer(st: SolverState, t: number, o: number, _s: number): boolean {
    const list = st.regionTiles[ o ];
    if (list.length <= 1) {
      return false;
    }
    const start = list[ 0 ] === t ? list[ 1 ] : list[ 0 ];
    const seen = new Set([ start ]);
    const stack = [ start ];
    while (stack.length) {
      const u = stack.pop()!;
      for (const v of adj.get(u) || []) {
        if (v !== t && st.partition[ v ] === o && !seen.has(v)) {
          seen.add(v);
          stack.push(v);
        }
      }
    }
    return seen.size === list.length - 1;
  }

  // Swap two boundary houses of different parties between adjacent regions.
  // Transfers change district sizes, so turning an opponent-won district into
  // a tie needs a detour through an unbalanced state that the greedy climb
  // refuses.  An atomic exchange keeps both sizes fixed while changing the
  // compositions — the missing move for "one player win, everything else
  // tied" puzzles (e.g. day 91).  Returns a new state or null if either
  // region would be disconnected.
  function trySwap(st: SolverState, t1: number, o: number, s: number, t2: number): SolverState | null {
    if (!canTransfer(st, t1, o, s)) {
      return null;
    }
    const mid = applyTransfer(st, t1, o, s);
    if (!canTransfer(mid, t2, s, o)) {
      return null;
    }
    // t2 must still touch o after t1 left it, otherwise o would be split.
    if (!(adj.get(t2) || []).some((v) => mid.partition[ v ] === o)) {
      return null;
    }
    return applyTransfer(mid, t2, s, o);
  }

  // Greedy hill climb: repeatedly apply the best improving transfer or swap.
  function climb(st: SolverState): SolverState {
    let improved = true;
    while (improved) {
      improved = false;
      let bestSt = null;
      for (const t of tiles) {
        const o = st.partition[ t ];
        const seenS = new Set();
        for (const n of (adj.get(t) || [])) {
          const s = st.partition[ n ];
          if (s >= 0 && s !== o && !seenS.has(s)) {
            seenS.add(s);
            if (!canTransfer(st, t, o, s)) {
              continue;
            }
            const cand = applyTransfer(st, t, o, s);
            if (better(cand, st) && (!bestSt || better(cand, bestSt))) {
              bestSt = cand;
            }
          }
        }
        // Swaps: exchange t with an opposite-party boundary house of the
        // neighbouring region.  Only houses matter — empty-tile exchanges
        // change sizes and are already covered by plain transfers.
        const tt = puzzle.tiles.get(t);
        if (tt && tt.party !== null) {
          for (const n of (adj.get(t) || [])) {
            const s = st.partition[ n ];
            if (s < 0 || s === o) {
              continue;
            }
            for (const u of st.regionTiles[ s ]) {
              const tu = puzzle.tiles.get(u);
              if (!tu || tu.party === null || tu.party === tt.party) {
                continue;
              }
              let onBoundary = false;
              for (const v of (adj.get(u) || [])) {
                if (st.partition[ v ] === o) {
                  onBoundary = true;
                  break;
                }
              }
              if (!onBoundary) {
                continue;
              }
              const cand = trySwap(st, t, o, s, u);
              if (cand && better(cand, st) && (!bestSt || better(cand, bestSt))) {
                bestSt = cand;
              }
            }
          }
        }
      }
      if (bestSt) {
        st = bestSt;
        improved = true;
      }
    }
    return st;
  }

  // ---------------------------------------------------------------------
  // Rebalancing.  The election-aware climb finds won states (wins > oppMax)
  // at any dev, but its greedy comparator refuses moves that temporarily
  // worsen the election, so it cannot always descend to a balanced (dev 0)
  // won state.  These helpers fix that:
  //  - greedyRebalance: accept transfers that reduce dev while keeping the
  //    win (wins >= starting wins, election still won) — e.g. turning an
  //    overfull player district into a tie district for an opponent.
  //  - softRebalance: a short soft-score SA (dev-heavy, election-aware)
  //    that may temporarily lose the election to cross between basins.

  function greedyRebalance(st: SolverState): SolverState {
    let cur = st;
    let improved = true;
    while (improved) {
      improved = false;
      let bestCand = null;
      for (const t of tiles) {
        const o = cur.partition[ t ];
        if (o < 0) {
          continue;
        }
        const seenS = new Set();
        for (const n of (adj.get(t) || [])) {
          const s = cur.partition[ n ];
          if (s >= 0 && s !== o && !seenS.has(s)) {
            seenS.add(s);
            if (!canTransfer(cur, t, o, s)) {
              continue;
            }
            const cand = applyTransfer(cur, t, o, s);
            // Reduce dev while keeping the ELECTION won (any margin) — the
            // win count may drop (e.g. 4 unbalanced wins -> 3 balanced wins).
            if (cand.dev < cur.dev && cand.wins > cand.oppMaxWins) {
              if (!bestCand || cand.dev < bestCand.dev || (cand.dev === bestCand.dev && better(cand, bestCand))) {
                bestCand = cand;
              }
            }
          }
        }
      }
      if (bestCand) {
        cur = bestCand;
        improved = true;
      }
    }
    return cur;
  }

  function softRebalance(st: SolverState, timeMs: number, rng: () => number): SolverState {
    const softDeadline = Date.now() + timeMs;
    let cur = st;
    let curDev = cur.dev;
    let bestWonState = cur;
    let T = 2500;
    let iter = 0;
    // Tied districts are valuable: they balance the opponents' wins (e.g. a
    // 2v2 tie caps an opponent's district count), so the soft walk gets a
    // bonus per tie.  (States track per-district winners; null = tie.)
    const tieCount = (state: SolverState): number => state.winners.filter((w) => w === null).length;
    const softScore = (dev: number, wins: number, oppMax: number, ties: number): number =>
      dev * 3000 + (wins <= oppMax ? 12000 : 0) + oppMax * 400 - wins * 1500 - ties * 1500;
    let curTies = tieCount(cur);
    while (Date.now() < softDeadline) {
      iter++;
      let cand: SolverState | null = null;
      // Swap moves rebalance compositions without touching sizes — the walk
      // can trade houses between adjacent districts (e.g. breaking an
      // opponent's thin win into a tie) without paying the dev penalty that
      // blocks single transfers.
      if (rng() < 0.35) {
        const t = tiles[ Math.floor(rng() * tiles.length) ];
        const o = cur.partition[ t ];
        const tt = puzzle.tiles.get(t);
        if (o >= 0 && tt && tt.party !== null) {
          const sRegs = [ ...new Set((adj.get(t) || []).map((n) => cur.partition[ n ]).filter((r) => r >= 0 && r !== o)) ];
          if (sRegs.length > 0) {
            const s = sRegs[ Math.floor(rng() * sRegs.length) ];
            const candidates = cur.regionTiles[ s ].filter((u) => {
              const tu = puzzle.tiles.get(u);
              if (!tu || tu.party === null || tu.party === tt.party) {
                return false;
              }
              return (adj.get(u) || []).some((v) => cur.partition[ v ] === o);
            });
            if (candidates.length > 0) {
              cand = trySwap(cur, t, o, s, candidates[ Math.floor(rng() * candidates.length) ]);
            }
          }
        }
      }
      if (cand === null) {
        const t = tiles[ Math.floor(rng() * tiles.length) ];
        const o = cur.partition[ t ];
        if (o < 0) {
          continue;
        }
        const nbs = (adj.get(t) || []).filter((n) => cur.partition[ n ] >= 0 && cur.partition[ n ] !== o);
        if (nbs.length === 0) {
          continue;
        }
        const s = cur.partition[ nbs[ Math.floor(rng() * nbs.length) ] ];
        if (!canTransfer(cur, t, o, s)) {
          continue;
        }
        cand = applyTransfer(cur, t, o, s);
      }
      const candTies = tieCount(cand);
      const oldS = softScore(curDev, cur.wins, cur.oppMaxWins, curTies);
      const newS = softScore(cand.dev, cand.wins, cand.oppMaxWins, candTies);
      T = 2500 * Math.max(0.01, 1 - iter / 500000);
      if (newS <= oldS || rng() < Math.exp(-(newS - oldS) / T)) {
        cur = cand;
        curDev = cand.dev;
        curTies = candTies;
        if (cand.wins > cand.oppMaxWins && betterWon(cand, bestWonState)) {
          bestWonState = cand;
        }
      }
    }
    return bestWonState;
  }

  // Random mutations: `count` random valid transfers or swaps, score-agnostic.
  function mutate(st: SolverState, count: number): SolverState {
    let out = st;
    for (let m = 0; m < count; m++) {
      let tries = 0;
      while (tries++ < 200) {
        const t = tiles[ Math.floor(rand() * tiles.length) ];
        const o = out.partition[ t ];
        const neighbors = (adj.get(t) || []).filter((n) => out.partition[ n ] >= 0 && out.partition[ n ] !== o);
        if (neighbors.length === 0) {
          continue;
        }
        const s = out.partition[ neighbors[ Math.floor(rand() * neighbors.length) ] ];
        if (rand() < 0.4) {
          const tt = puzzle.tiles.get(t);
          const candidates: number[] = [];
          if (tt && tt.party !== null) {
            for (const u of out.regionTiles[ s ]) {
              const tu = puzzle.tiles.get(u);
              if (tu && tu.party !== null && tu.party !== tt.party && (adj.get(u) || []).some((v) => out.partition[ v ] === o)) {
                candidates.push(u);
              }
            }
          }
          if (candidates.length === 0) {
            continue;
          }
          const cand = trySwap(out, t, o, s, candidates[ Math.floor(rand() * candidates.length) ]);
          if (!cand) {
            continue;
          }
          out = cand;
        } else {
          if (!canTransfer(out, t, o, s)) {
            continue;
          }
          out = applyTransfer(out, t, o, s);
        }
        break;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // Main loop: construct -> climb -> mutate (x30) -> restart.
  // `best` tracks the best state by score (may be unbalanced); `bestValid`
  // tracks the best dev = 0 state, which is the only submittable one.
  // ---------------------------------------------------------------------
  let best: SolverState | null = null;
  let bestValid: SolverState | null = null;
  let bestWon: SolverState | null = null;
  let restarts = 0;

  // Adaptive seed focus: track, per seed, the best (wins >= 2) state's dev.
  // Once a seed produces a 2-win state at low dev, most constructs use that
  // seed — the promising basins get the time instead of being diluted by
  // dozens of dead seeds.
  let focusIdx = -1;
  let focusStalls = 0;
  const excludedSeeds = new Set();
  const seedLowDev: number[] | null = seedDistricts ? Array.from<number>({ length: seedDistricts.length }).fill(Infinity) : null;

  while (Date.now() < deadline) {
    restarts++;
    let seedIdx = -1;
    if (seedDistricts) {
      seedIdx = Math.floor(rand() * seedDistricts.length);
      if (focusIdx >= 0 && rand() < 0.85) {
        seedIdx = focusIdx;
      }
    }
    const st0 = seedDistricts ? constructRandom(seedDistricts[ seedIdx ]) : constructRandom(null);
    if (!st0) {
      continue;
    }
    let st = st0;
    let noProgress = 0;
    for (let round = 0; round < 30 && Date.now() < deadline; round++) {
      const before = st;
      st = climb(st);
      if (better(st, before)) {
        noProgress = 0;
      } else { noProgress++; }
      if (!best || better(st, best)) {
        best = st;
      }
      if (st.dev === 0 && (!bestValid || better(st, bestValid))) {
        bestValid = st;
      }
      // Rebalance won states greedily: reduce dev while keeping the win.
      if (st.wins > st.oppMaxWins) {
        if (!bestWon || betterWon(st, bestWon)) {
          bestWon = st;
        }
        const rb = greedyRebalance(st);
        if (rb.dev === 0 && (!bestValid || better(rb, bestValid))) {
          bestValid = rb;
        }
        if (rb.dev === 0 && rb.wins >= targetWins && rb.wins > rb.oppMaxWins) {
          bestWon = rb;
          st = rb;
        } else if (betterWon(rb, bestWon)) {
          bestWon = rb;
        }
      }
      if (seedIdx >= 0 && st.wins >= 2 && st.dev < seedLowDev![ seedIdx ]) {
        seedLowDev![ seedIdx ] = st.dev;
      }
      if (noProgress >= 6) {
        break;
      }
      st = mutate(st, 4);
    }
    if (!best || better(st, best)) {
      best = st;
    }
    if (st.dev === 0 && (!bestValid || better(st, bestValid))) {
      bestValid = st;
    }

    // Soft-search burst: the balance-aware random walk finds won states the
    // greedy climb cannot reach (e.g. a tie district that balances the
    // opponents' wins).  Start from the most balanced won state so far.
    if (!(bestValid && bestValid.wins >= targetWins && bestValid.wins > bestValid.oppMaxWins)) {
      const burst = Math.min(500, Math.max(150, Math.floor((deadline - Date.now()) / 30)));
      const softStart = bestWon || st;
      const softRes = softRebalance(softStart, burst, rand);
      if (softRes.wins > softRes.oppMaxWins) {
        if (softRes.dev === 0 && (!bestValid || better(softRes, bestValid))) {
          bestValid = softRes;
        }
        if (!bestWon || betterWon(softRes, bestWon)) {
          bestWon = softRes;
        }
        if (bestValid && bestValid.wins >= targetWins && bestValid.wins > bestValid.oppMaxWins) {
          break;
        }
      }
    }

    // Update the focus from the per-seed records.
    if (seedDistricts) {
      let bestSeed = -1;
      let bestScore = Infinity;
      for (let i = 0; i < seedLowDev!.length; i++) {
        if (excludedSeeds.has(i)) {
          continue;
        }
        const d = seedLowDev![ i ];
        if (d < bestScore) {
          bestScore = d;
          bestSeed = i;
        }
      }
      if (bestScore < Infinity) {
        if (focusIdx !== bestSeed) {
          focusIdx = bestSeed;
          focusStalls = 0;
        }
      } else if (focusIdx >= 0) {
        focusStalls++;
        if (focusStalls > 60 && !(bestValid && bestValid.wins >= targetWins)) {
          // The focused seed is not converging — blacklist it and try others.
          excludedSeeds.add(focusIdx);
          focusIdx = -1;
          focusStalls = 0;
          if (excludedSeeds.size >= seedLowDev!.length - 1) {
            excludedSeeds.clear();
          }
        }
      }
    }

    if (bestValid && bestValid.wins >= targetWins && bestValid.wins > bestValid.oppMaxWins) {
      break; // good enough
    }
    if (restarts > 500000) {
      break;
    }
  }

  // Final polish: if a won state exists but is unbalanced, alternate greedy
  // rebalancing with soft-score escapes until balanced or time runs out.
  if (
    bestWon
    && !(bestValid && bestValid.wins >= targetWins && bestValid.wins > bestValid.oppMaxWins)
  ) {
    let rb = bestWon;
    for (let phase = 0; phase < 8 && Date.now() < deadline; phase++) {
      rb = greedyRebalance(rb);
      if (rb.dev === 0) {
        if (!bestValid || better(rb, bestValid)) {
          bestValid = rb;
        }
        break;
      }
      if (betterWon(rb, bestWon)) {
        bestWon = rb;
      }
      const slice = Math.min(1500, Math.max(300, Math.floor((deadline - Date.now()) / 4)));
      rb = softRebalance(rb, slice, rand);
      if (rb.dev === 0 && (!bestValid || better(rb, bestValid))) {
        bestValid = rb;
      }
      if (rb.dev === 0 && rb.wins >= targetWins && rb.wins > rb.oppMaxWins) {
        break;
      }
    }
  }

  const result = bestValid || best;
  if (!result || result.wins === 0 || result.dev !== 0) {
    return null;
  }

  const assign = new Map();
  for (let r = 0; r < K; r++) {
    for (const t of result.regionTiles[ r ]) {
      assign.set(t, r);
    }
  }
  return { assign, wins: result.wins, maxOpp: result.oppMaxWins, dev: result.dev, restarts };
}
