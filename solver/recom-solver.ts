import type { Puzzle } from './hex-utils.ts';

import { collectSeedDistricts } from './constructive-solver.ts';
import {
  analyzePlayerClusters,
  buildAdjacency,
  buildPartArray,
  countWins,
  districtStats,
  greedySolve,
  isHouse,
  makeRng,

  shuffle,
} from './hex-utils.ts';
import { siteStyleSolve } from './site-solver.ts';

/** Return type of siteStyleSolve, used internally. */
interface ConstructiveResult {
  assign: Map<number, number>;
  wins: number;
  maxOpp: number;
  dev: number;
  restarts: number;
}

// ---------------------------------------------------------------------------
// Districts don't need equal size in this game — connectivity is the only
// constraint.  The SA just maximizes player wins and minimizes opponent max.
/**
 * Score a partition: lower is better.  Penalises non-strict wins and rewards
 * player wins while discouraging opponent wins.
 * @param {number} dev - total size deviation
 * @param {Record<number, number>} partyWins - wins per party
 * @param {number} playerWasted - player wasted votes
 * @param {number} opponentWasted - opponent wasted votes
 * @param {number} playerParty - player party index
 * @returns {number} score (lower = better)
 */
function calculateScore(dev: number, partyWins: Record<number, number>, playerWasted: number, opponentWasted: number, playerParty: number): number {
  const playerWins: number = partyWins[ playerParty ] || 0;
  let maxOppWins: number = 0;
  for (const p in partyWins) {
    const pi = Number(p);
    if (pi === playerParty) {
      continue;
    }
    const w: number = partyWins[ Number(p) ] || 0;
    if (w > maxOppWins) {
      maxOppWins = w;
    }
  }
  const margin: number = playerWins - maxOppWins;
  const electionWon: number = margin > 0 ? 1 : 0;
  const electionPenalty: number = electionWon ? 0 : (1 - margin) * 3000;

  return (dev * dev) * 2000
    + electionPenalty
    - playerWins * 10000
    + maxOppWins * 2000
    + playerWasted * 200
    - opponentWasted * 200;
}

// ---------------------------------------------------------------------------
// Initial Partition & Spanning Tree Operations
// ---------------------------------------------------------------------------

/**
 * Build an initial district partition via wavefront BFS from seeds.
 * @param {Puzzle} puzzle - the puzzle
 * @param {() => number} rand - RNG function
 * @param {number[][] | null} seedHints - optional preferred seed clusters
 * @returns {Map<number, number>} tile-to-district assignment
 */
function initialPartition(puzzle: Puzzle, rand: () => number, seedHints: number[][] | null = null): Map<number, number> {
  const K = puzzle.regionCount;
  const adj = buildAdjacency(puzzle);
  const assign: Map<number, number> = new Map();

  if (K === 1) {
    for (const idx of puzzle.tiles.keys()) {
      assign.set(idx, 0);
    }
    return assign;
  }

  const houses: number[] = [];
  for (const [ idx, tile ] of puzzle.tiles) {
    if (isHouse(tile)) {
      houses.push(idx);
    }
  }
  shuffle(houses, rand);

  const seeds: number[] = [];

  // Prefer seed hints (viable player clusters) first
  if (seedHints && seedHints.length > 0) {
    for (const hint of seedHints) {
      if (seeds.length >= K) {
        break;
      }
      for (const idx of hint) {
        const t = puzzle.tiles.get(idx);
        if (t && t.party === puzzle.playerParty && !seeds.includes(idx)) {
          seeds.push(idx);
          break;
        }
      }
    }
  }

  // Fill remaining with random houses
  for (const h of houses) {
    if (seeds.length >= K) {
      break;
    }
    if (!seeds.includes(h)) {
      seeds.push(h);
    }
  }
  while (seeds.length < K) {
    const idx = [ ...puzzle.tiles.keys() ][ Math.floor(rand() * puzzle.tiles.size) ];
    if (!seeds.includes(idx)) {
      seeds.push(idx);
    }
  }

  const frontiers: number[][] = Array.from({ length: K }, () => []);

  for (let d = 0; d < K; d++) {
    assign.set(seeds[ d ], d);
    frontiers[ d ].push(seeds[ d ]);
  }

  let anyProgress = true;
  while (anyProgress) {
    anyProgress = false;
    for (let d = 0; d < K; d++) {
      const candidates: { idx: number; isH: number; }[] = [];
      const seen: Set<number> = new Set();
      for (const cur of frontiers[ d ]) {
        for (const n of (adj.get(cur) || [])) {
          if (!assign.has(n) && !seen.has(n)) {
            seen.add(n);
            candidates.push({ idx: n, isH: isHouse(puzzle.tiles.get(n)) ? 0 : 1 });
          }
        }
      }
      if (candidates.length === 0) {
        continue;
      }
      candidates.sort((a, b) => a.isH - b.isH);
      const chosen = candidates[ 0 ].idx;
      assign.set(chosen, d);
      frontiers[ d ].push(chosen);
      anyProgress = true;
    }
  }

  let unassigned = true;
  while (unassigned) {
    unassigned = false;
    for (const [ idx ] of puzzle.tiles) {
      if (assign.has(idx)) {
        continue;
      }
      for (const n of (adj.get(idx) || [])) {
        if (assign.has(n)) {
          assign.set(idx, assign.get(n)!);
          unassigned = true;
          break;
        }
      }
    }
  }
  for (const [ idx ] of puzzle.tiles) {
    if (!assign.has(idx)) {
      assign.set(idx, 0);
    }
  }

  return assign;
}

/**
 * Build a random spanning tree over a tile set using Kruskal's algorithm.
 * @param {Set<number>} tileSet - tiles to span
 * @param {Puzzle} _puzzle - puzzle (unused but kept for signature compatibility)
 * @param {Map<number, number[]>} adj - adjacency map
 * @param {() => number} rand - RNG function
 * @returns {Map<number, number[]>} adjacency list of the spanning tree
 */
function randomSpanningTree(tileSet: Set<number>, _puzzle: Puzzle, adj: Map<number, number[]>, rand: () => number): Map<number, number[]> {
  const nodes = [ ...tileSet ];
  const nodeSet = new Set(nodes);
  const edges: { u: number; v: number; w: number; }[] = [];

  for (const u of nodes) {
    for (const v of (adj.get(u) || [])) {
      if (u < v && nodeSet.has(v)) {
        // Pure uniform random weights - Allows "tentacles" through empty tiles
        edges.push({ u, v, w: rand() });
      }
    }
  }
  edges.sort((a, b) => a.w - b.w);

  const ufParent: Map<number, number> = new Map();
  const find = (x: number): number => {
    if (!ufParent.has(x)) {
      ufParent.set(x, x);
    }
    if (ufParent.get(x)! !== x) {
      ufParent.set(x, find(ufParent.get(x)!));
    }
    return ufParent.get(x)!;
  };
  const union = (x: number, y: number): boolean => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) {
      ufParent.set(rx, ry);
      return true;
    }
    return false;
  };

  const tree: Map<number, number[]> = new Map();
  for (const { u, v } of edges) {
    if (union(u, v)) {
      if (!tree.has(u)) {
        tree.set(u, []);
      }
      if (!tree.has(v)) {
        tree.set(v, []);
      }
      tree.get(u)!.push(v);
      tree.get(v)!.push(u);
    }
  }
  return tree;
}

/**
 * DFS on a spanning tree: compute parent pointers and subtree house counts.
 * @param {Map<number, number[]>} tree - tree adjacency
 * @param {number} root - root node
 * @param {Puzzle} puzzle - the puzzle
 * @returns {{ parent: Map<number, number | null>; subtreeHouseCount: Map<number, number> }} DFS result: parent pointers and subtree house counts per node
 */
function dfsTree(tree: Map<number, number[]>, root: number, puzzle: Puzzle): { parent: Map<number, number | null>; subtreeHouseCount: Map<number, number>; } {
  const parent: Map<number, number | null> = new Map();
  const order: number[] = [];
  const stack: number[] = [ root ];
  parent.set(root, null);

  while (stack.length) {
    const u = stack.pop()!;
    order.push(u);
    for (const v of (tree.get(u) || [])) {
      if (parent.has(v)) {
        continue;
      }
      parent.set(v, u);
      stack.push(v);
    }
  }

  const sub: Map<number, number> = new Map();
  for (const u of order.reverse()) {
    let cnt = isHouse(puzzle.tiles.get(u)) ? 1 : 0;
    for (const v of (tree.get(u) || [])) {
      if (v === parent.get(u)) {
        continue;
      }
      cnt += sub.get(v) || 0;
    }
    sub.set(u, cnt);
  }
  return { parent, subtreeHouseCount: sub };
}

/**
 * Collect all nodes in the subtree rooted at `root` (inclusive).
 * @param {number} root - subtree root
 * @param {Map<number, number[]>} tree - tree adjacency
 * @param {Map<number, number | null>} parent - parent map from dfsTree
 * @returns {Set<number>} nodes in the subtree
 */
function collectSubtree(root: number, tree: Map<number, number[]>, parent: Map<number, number | null>): Set<number> {
  const set: Set<number> = new Set();
  const stack: number[] = [ root ];
  while (stack.length) {
    const u = stack.pop()!;
    set.add(u);
    for (const v of (tree.get(u) || [])) {
      if (v !== parent.get(u) && !set.has(v)) {
        stack.push(v);
      }
    }
  }
  return set;
}

/**
 * Build district-level adjacency from tile-level assignment.
 * @param {Map<number, Set<number>>} distSets - district id → tile set
 * @param {Map<number, number>} assign - tile → district id
 * @param {Map<number, number[]>} adj - tile adjacency
 * @returns {Map<number, Set<number>>} district id → neighbouring district ids
 */
function buildDistAdj(distSets: Map<number, Set<number>>, assign: Map<number, number>, adj: Map<number, number[]>): Map<number, Set<number>> {
  const dAdj: Map<number, Set<number>> = new Map();
  for (const [ d, tiles ] of distSets) {
    const nb: Set<number> = new Set();
    for (const idx of tiles) {
      for (const n of (adj.get(idx) || [])) {
        const nd = assign.get(n);
        if (nd != null && nd !== d) {
          nb.add(nd);
        }
      }
    }
    dAdj.set(d, nb);
  }
  return dAdj;
}

// ---------------------------------------------------------------------------
// solve – main entry point
// ---------------------------------------------------------------------------
/**
 * Solve a puzzle for the player party: find a partition where the player
 * wins at least `maxGoalHint` districts (default 1 = any strict win), or
 * as many as feasible if the opponent can force a no-win state.
 *
 * @param {Puzzle} puzzle - puzzle from `extract()` (tiles as Map)
 * @param {number} timeLimitMs - solver budget in milliseconds
 * @param {number|null} maxGoalHint - target player wins; null/1 = any strict win
 * @param {number|null} seed - RNG seed for reproducible runs
 * @param {boolean} debug - emit debug console output
 * @param {((msg: string | { dot: number }) => void)|null} reporter - progress callback
 * @returns {{ partArray: (number|null)[]|null; wins: number; goal: number; timedOut: boolean; isStrictWin: boolean }} solver outcome
 */
export function solve(
  puzzle: Puzzle,
  timeLimitMs: number = 300000,
  maxGoalHint: number | null = null,
  seed: number | null = null,
  debug: boolean = true,
  reporter: ((msg: string | { dot: number; }) => void) | null = null,
): { partArray: (number | null)[] | null; wins: number; goal: number; timedOut: boolean; isStrictWin: boolean; } {
  const startTime = Date.now();
  const deadline = startTime + timeLimitMs;

  // Spatial feasibility: how many winning districts can player houses physically form?
  const { feasibleMax, cores: seedCores } = analyzePlayerClusters(puzzle);

  // Cap the target at what's spatially achievable (plus theoretical max as ceiling)
  let playerHouses = 0;
  for (const tile of puzzle.tiles.values()) {
    if (tile.party === puzzle.playerParty) {
      playerHouses++;
    }
  }
  const minWin = Math.floor(puzzle.housesPerDistrict / puzzle.partyCount) + 1;
  const theoreticalMax = Math.min(puzzle.regionCount, Math.floor(playerHouses / minWin));

  const spatialMax = Math.min(feasibleMax, theoreticalMax);
  const rawTarget = maxGoalHint !== null ? maxGoalHint : puzzle.regionCount;
  // Never drive target to 0: spatial analysis is a lower bound, not exact
  const targetWins = spatialMax > 0 ? Math.min(rawTarget, spatialMax) : Math.max(rawTarget, 1);

  if (debug && seed === 1) {
    const msg = `[DEBUG] Spatial feasibility: at most ${ spatialMax } winning districts (theoretical ${ theoreticalMax }, feasible ${ feasibleMax })`;
    (reporter || console.log)(msg);
  }

  const adj = buildAdjacency(puzzle);
  const size = puzzle.housesPerDistrict;
  const rand = seed !== null ? makeRng(seed) : Math.random;

  let assign: Map<number, number> = initialPartition(puzzle, rand, seedCores);

  // ---------------------------------------------------------------------
  // Constructive restart phase (site-style + anchored seeds): for W >= 2 the
  // balanced ReCom chain is frequently disconnected from any W-win partition
  // (the dev=0 manifold splits into basins), and fully random constructions
  // rarely land in the right basin.  First enumerate anchored candidate
  // winning districts (player-house groups grown into winning snakes), then
  // run the site-style transfer-climb solver seeded with those districts —
  // transfers cross basins because they do not preserve district sizes, and
  // the dev-aware score pulls the result back to a balanced, valid state.
  // Bounded by a time budget; its result seeds the SA below.
  // ---------------------------------------------------------------------
  let constructiveBest: ConstructiveResult | null = null;
  // A strict election win needs playerWins > every opponent; when an
  // opponent is forced to win (house majority that cannot all be wasted),
  // even targetWins = 1 may be unreachable while 2 wins exist.  Run the
  // constructive phase whenever 2+ wins are spatially plausible.
  const constructiveW = Math.max(2, targetWins);
  if (constructiveW <= puzzle.regionCount && constructiveW * minWin <= playerHouses) {
    const constructiveBudgetMs = Math.min(15000, Math.max(3000, Math.floor(timeLimitMs * 0.25)));
    const constructiveStart = Date.now();
    try {
      const seedBudgetMs = Math.min(6000, Math.max(2000, Math.floor(constructiveBudgetMs * 0.35)));
      // Two-anchor seeds are the most reliable starting points for the climb
      // regardless of the target (the search builds further wins itself);
      // the W=3+ seed pools are measurably worse.
      const seeds = collectSeedDistricts(puzzle, Math.min(2, constructiveW), seedBudgetMs);
      if (debug && seed === 1) {
        const msg = `[DEBUG] Anchored seeds: ${ seeds.length } candidate district(s) in ${ Date.now() - constructiveStart }ms`;
        (reporter || console.log)(msg);
      }
      const cRes = siteStyleSolve(puzzle, Math.max(2000, constructiveBudgetMs - (Date.now() - constructiveStart)), constructiveW, seeds.length > 0 ? seeds.map((s) => [ ...s ]) : null);
      if (cRes && cRes.wins > 0) {
        constructiveBest = cRes;
        if (debug && seed === 1) {
          const msg = `[DEBUG] Constructive solver: ${ cRes.wins } win(s) in ${ Date.now() - constructiveStart }ms (dev ${ cRes.dev })${ cRes.wins > cRes.maxOpp ? ' (strict)' : ' (not strict)' }`;
          (reporter || console.log)(msg);
        }
        // A strict win at or above target finishes immediately.
        if (cRes.wins >= targetWins && cRes.wins > cRes.maxOpp) {
          return {
            partArray: buildPartArray(cRes.assign, puzzle),
            wins: cRes.wins,
            goal: targetWins,
            timedOut: false,
            isStrictWin: true,
          };
        }
        // Otherwise seed the SA from this partition (a strict win with fewer
        // districts, or a non-strict best-effort baseline to keep improving).
        assign = new Map(cRes.assign);
      }
    } catch {
      /* constructive is best-effort */
    }
  }

  let bestGlobalAssign: Map<number, number> | null = null;
  let bestGlobalWins = -1;
  let bestGlobalMaxOppWins = Infinity;
  let bestGlobalDev = Infinity;
  let bestGlobalPlayerWasted = Infinity;
  let bestGlobalOpponentWasted = -1;

  // Best valid (dev = 0) partition that does NOT win the election — used as a
  // fallback for puzzles where a strict win is spatially impossible (e.g. the
  // player's district ceiling is below the leading opponent's forced floor).
  let bestNonStrictAssign: Map<number, number> | null = null;
  let bestNonStrictWins = 0;
  let bestNonStrictMaxOppWins = Infinity;
  let bestNonStrictPlayerWasted = Infinity;
  let bestNonStrictOpponentWasted = -1;

  // A non-strict constructive result is a valid optimum-level baseline.
  if (constructiveBest && constructiveBest.wins <= constructiveBest.maxOpp) {
    bestNonStrictAssign = new Map(constructiveBest.assign);
    bestNonStrictWins = constructiveBest.wins;
    bestNonStrictMaxOppWins = constructiveBest.maxOpp;
    bestNonStrictPlayerWasted = Infinity;
    bestNonStrictOpponentWasted = -1;
  }

  if (targetWins > 0) {
    try {
      const greedyAssign = greedySolve(puzzle);
      const greedySets: Map<number, Set<number>> = new Map();
      let greedyTotalDev = 0;
      let greedyPlayerWasted = 0;
      let greedyOpponentWasted = 0;
      for (const [ idx, d ] of greedyAssign) {
        if (!greedySets.has(d)) {
          greedySets.set(d, new Set());
        }
        greedySets.get(d)!.add(idx);
      }
      for (const set of greedySets.values()) {
        const s = districtStats(set, puzzle);
        greedyTotalDev += s.dev;
        greedyPlayerWasted += s.playerWasted;
        greedyOpponentWasted += s.opponentWasted;
      }
      const greedyWins = countWins(greedySets.values(), puzzle);
      let greedyMaxOpp = 0;
      const greedyPartyWins: Record<number, number> = {};
      for (const set of greedySets.values()) {
        const s = districtStats(set, puzzle);
        if (s.winner !== null) {
          greedyPartyWins[ s.winner ] = (greedyPartyWins[ s.winner ] || 0) + 1;
        }
      }
      for (const p in greedyPartyWins) {
        if (Number(p) !== puzzle.playerParty && greedyPartyWins[ Number(p) ] > greedyMaxOpp) {
          greedyMaxOpp = greedyPartyWins[ Number(p) ];
        }
      }
      const greedyIsStrict = greedyTotalDev === 0 && greedyWins > 0 && greedyWins > greedyMaxOpp;

      if (greedyIsStrict) {
        assign = greedyAssign;
        bestGlobalAssign = new Map(greedyAssign);
        bestGlobalWins = greedyWins;
        bestGlobalMaxOppWins = greedyMaxOpp;
        bestGlobalDev = 0;
        bestGlobalPlayerWasted = greedyPlayerWasted;
        bestGlobalOpponentWasted = greedyOpponentWasted;

        if (greedyWins >= targetWins) {
          return { partArray: buildPartArray(greedyAssign, puzzle), wins: greedyWins, goal: targetWins, timedOut: false, isStrictWin: true };
        }
      }
    } catch { /* fall through to random */ }
  }

  const distSets: Map<number, Set<number>> = new Map();
  for (const [ idx, d ] of assign) {
    if (!distSets.has(d)) {
      distSets.set(d, new Set());
    }
    distSets.get(d)!.add(idx);
  }

  let currentDev = 0;
  let currentPlayerWasted = 0;
  let currentOpponentWasted = 0;
  let currentPartyWins: Record<number, number> = {};

  for (const set of distSets.values()) {
    const s = districtStats(set, puzzle);
    currentDev += s.dev;
    currentPlayerWasted += s.playerWasted;
    currentOpponentWasted += s.opponentWasted;
    if (s.winner !== null) {
      currentPartyWins[ s.winner ] = (currentPartyWins[ s.winner ] || 0) + 1;
    }
  }

  if (bestGlobalAssign === null) {
    bestGlobalAssign = new Map(assign);

    const initWins = currentPartyWins[ puzzle.playerParty ] || 0;
    let initMaxOpp = 0;
    for (const p in currentPartyWins) {
      if (Number(p) !== puzzle.playerParty && currentPartyWins[ Number(p) ] > initMaxOpp) {
        initMaxOpp = currentPartyWins[ Number(p) ];
      }
    }
    if (initWins > initMaxOpp && currentDev === 0) {
      bestGlobalWins = initWins;
      bestGlobalMaxOppWins = initMaxOpp;
      bestGlobalDev = 0;
      bestGlobalPlayerWasted = currentPlayerWasted;
      bestGlobalOpponentWasted = currentOpponentWasted;
      if (initWins >= targetWins) {
        return { partArray: buildPartArray(bestGlobalAssign, puzzle), wins: initWins, goal: targetWins, timedOut: false, isStrictWin: true };
      }
    } else if (currentDev === 0 && initWins > 0
      && (initWins > bestNonStrictWins
        || (initWins === bestNonStrictWins && initMaxOpp < bestNonStrictMaxOppWins)
        || (initWins === bestNonStrictWins && initMaxOpp === bestNonStrictMaxOppWins
          && currentPlayerWasted < bestNonStrictPlayerWasted)
        || (initWins === bestNonStrictWins && initMaxOpp === bestNonStrictMaxOppWins
          && currentPlayerWasted === bestNonStrictPlayerWasted
          && currentOpponentWasted > bestNonStrictOpponentWasted))) {
      bestNonStrictAssign = new Map(assign);
      bestNonStrictWins = initWins;
      bestNonStrictMaxOppWins = initMaxOpp;
      bestNonStrictPlayerWasted = currentPlayerWasted;
      bestNonStrictOpponentWasted = currentOpponentWasted;
    }
  }

  let distAdj = buildDistAdj(distSets, assign, adj);

  const T0 = 500.0; // Scaled specifically for the new amoeba energy penalties
  const Tf = 1.0;
  let consecutiveNoCuts = 0;
  let iterationCounter = 0;
  let lastLogTime = 0;

  // Soft restart mechanism: if no election-winning state for many iterations, start fresh
  let restartCounter = 0;
  const RESTART_THRESHOLD = 300000;
  let timeCache = Date.now();

  while (true) {
    iterationCounter++;
    // Batch system calls: update time only every 100 iterations
    if (iterationCounter % 100 === 0) {
      timeCache = Date.now();
    }
    if (timeCache >= deadline) {
      break;
    }

    const progress = (timeCache - startTime) / timeLimitMs;
    const T = T0 * (1 - progress) + Tf * progress;

    if (iterationCounter % 100000 === 0 && reporter) {
      if (debug) {
        const msg = `[DEBUG] Active ReCom: iteration ${ iterationCounter } | Temp: ${ T.toFixed(1) } | Best Strict Wins: ${ bestGlobalWins === -1 ? 0 : bestGlobalWins }/${ targetWins }`;
        reporter(msg);
      } else {
        reporter({ dot: 1 });
      }
    }

    // Hard reset if completely trapped by connectivity
    if (consecutiveNoCuts > 1000) {
      assign = initialPartition(puzzle, rand, seedCores);
      distSets.clear();
      for (const [ idx, d ] of assign) {
        if (!distSets.has(d)) {
          distSets.set(d, new Set());
        }
        distSets.get(d)!.add(idx);
      }
      currentDev = 0;
      currentPlayerWasted = 0;
      currentOpponentWasted = 0;
      currentPartyWins = {};
      for (const set of distSets.values()) {
        const s = districtStats(set, puzzle);
        currentDev += s.dev;
        currentPlayerWasted += s.playerWasted;
        currentOpponentWasted += s.opponentWasted;
        if (s.winner !== null) {
          currentPartyWins[ s.winner ] = (currentPartyWins[ s.winner ] || 0) + 1;
        }
      }
      distAdj = buildDistAdj(distSets, assign, adj);
      consecutiveNoCuts = 0;
      restartCounter = 0;
      continue;
    }

    // Evaluate current election status (needed for restart check)
    let playerWins = currentPartyWins[ puzzle.playerParty ] || 0;
    let maxOppWins = 0;
    for (const p in currentPartyWins) {
      if (Number(p) !== puzzle.playerParty && currentPartyWins[ Number(p) ] > maxOppWins) {
        maxOppWins = currentPartyWins[ Number(p) ];
      }
    }
    const electionWon = playerWins > maxOppWins;

    // ---- Soft restart when stuck in non-winning states ----
    if (!electionWon && restartCounter++ > RESTART_THRESHOLD) {
      assign = initialPartition(puzzle, rand, seedCores);
      distSets.clear();
      for (const [ idx, d ] of assign) {
        if (!distSets.has(d)) {
          distSets.set(d, new Set());
        }
        distSets.get(d)!.add(idx);
      }
      currentDev = 0;
      currentPlayerWasted = 0;
      currentOpponentWasted = 0;
      currentPartyWins = {};
      for (const set of distSets.values()) {
        const s = districtStats(set, puzzle);
        currentDev += s.dev;
        currentPlayerWasted += s.playerWasted;
        currentOpponentWasted += s.opponentWasted;
        if (s.winner !== null) {
          currentPartyWins[ s.winner ] = (currentPartyWins[ s.winner ] || 0) + 1;
        }
      }
      distAdj = buildDistAdj(distSets, assign, adj);
      restartCounter = 0;
      consecutiveNoCuts = 0;
      // (best solution remains stored)
      continue;
    }

    const ids = [ ...distSets.keys() ];

    // Biased merge: with ~40% probability, target a district where the player
    // wastes votes (inefficient win) or an opponent has a big-but-thin win.
    let a: number;
    if (rand() < 0.4 && ids.length >= 2) {
      const scored = ids.map((id) => {
        const set = distSets.get(id)!;
        const st = districtStats(set, puzzle);
        const wastedScore = st.winner === puzzle.playerParty
          ? st.playerWasted // want to fix player-inefficient districts
          : (st.winner !== null ? -st.opponentWasted : 0); // want to pack opponent districts
        return { id, wastedScore };
      });
      scored.sort((x, y) => y.wastedScore - x.wastedScore);
      // Pick from the top 50% most "interesting" districts
      const topN = Math.max(2, Math.ceil(ids.length / 2));
      a = scored[ Math.floor(rand() * topN) ].id;
    } else {
      a = ids[ Math.floor(rand() * ids.length) ];
    }
    const nb = [ ...(distAdj.get(a) || []) ];
    if (nb.length === 0) {
      consecutiveNoCuts++;
      continue;
    }
    const b = nb[ Math.floor(rand() * nb.length) ];

    const setA = distSets.get(a)!;
    const setB = distSets.get(b)!;
    const merged = new Set([ ...setA, ...setB ]);

    const tree = randomSpanningTree(merged, puzzle, adj, rand);
    if (tree.size === 0) {
      consecutiveNoCuts++;
      continue;
    }

    const root = [ ...merged ][ 0 ];
    const { parent, subtreeHouseCount } = dfsTree(tree, root, puzzle);

    const oldA = districtStats(setA, puzzle);
    const oldB = districtStats(setB, puzzle);
    const oldPairDev = oldA.dev + oldB.dev;

    // Select only minimum-devacy cuts (classic ReCom)
    const cuts: { u: number; }[] = [];
    let minDev = Infinity;

    for (const [ u, p ] of parent) {
      if (p === null) {
        continue;
      }
      const sub = subtreeHouseCount.get(u)!;
      const rest = (oldA.houses + oldB.houses) - sub;
      const dev = Math.abs(sub - size) + Math.abs(rest - size);
      if (dev < minDev) {
        minDev = dev;
        cuts.length = 0;
      }
      if (dev === minDev) {
        cuts.push({ u });
      }
    }

    if (cuts.length === 0) {
      consecutiveNoCuts++;
      continue;
    }

    // Valid cuts found, reset the trap counter
    consecutiveNoCuts = 0;

    const cut = cuts[ Math.floor(rand() * cuts.length) ];
    const childSet = collectSubtree(cut.u, tree, parent);
    const restSet = new Set([ ...merged ].filter((t) => !childSet.has(t)));

    const newA = districtStats(childSet, puzzle);
    const newB = districtStats(restSet, puzzle);

    const newPartyWins: Record<number, number> = { ...currentPartyWins };
    if (oldA.winner !== null) {
      newPartyWins[ oldA.winner ]--;
    }
    if (oldB.winner !== null) {
      newPartyWins[ oldB.winner ]--;
    }
    if (newA.winner !== null) {
      newPartyWins[ newA.winner ] = (newPartyWins[ newA.winner ] || 0) + 1;
    }
    if (newB.winner !== null) {
      newPartyWins[ newB.winner ] = (newPartyWins[ newB.winner ] || 0) + 1;
    }

    const newDev = currentDev - oldPairDev + newA.dev + newB.dev;
    const newPlayerWasted = currentPlayerWasted - oldA.playerWasted - oldB.playerWasted + newA.playerWasted + newB.playerWasted;
    const newOpponentWasted = currentOpponentWasted - oldA.opponentWasted - oldB.opponentWasted + newA.opponentWasted + newB.opponentWasted;

    const oldScore = calculateScore(currentDev, currentPartyWins, currentPlayerWasted, currentOpponentWasted, puzzle.playerParty);
    const newScore = calculateScore(newDev, newPartyWins, newPlayerWasted, newOpponentWasted, puzzle.playerParty);
    const delta = newScore - oldScore;

    // Forced acceptance every few thousand moves to escape plateaus
    const forceAccept = (iterationCounter % 5000 === 0);

    if (delta <= 0 || rand() < Math.exp(-delta / T) || forceAccept) {
      distSets.set(a, childSet);
      distSets.set(b, restSet);
      for (const t of childSet) {
        assign.set(t, a);
      }
      for (const t of restSet) {
        assign.set(t, b);
      }

      currentDev = newDev;
      currentPartyWins = newPartyWins;
      currentPlayerWasted = newPlayerWasted;
      currentOpponentWasted = newOpponentWasted;

      // Update election-won status using new wins
      playerWins = currentPartyWins[ puzzle.playerParty ] || 0;
      maxOppWins = 0;
      for (const p in currentPartyWins) {
        if (Number(p) !== puzzle.playerParty && currentPartyWins[ Number(p) ] > maxOppWins) {
          maxOppWins = currentPartyWins[ Number(p) ];
        }
      }
      const newElectionWon = playerWins > maxOppWins;

      if (currentDev === 0 && newElectionWon) {
        if (bestGlobalDev > 0
          || playerWins > bestGlobalWins
          || (playerWins === bestGlobalWins && maxOppWins < bestGlobalMaxOppWins)
          || (playerWins === bestGlobalWins && maxOppWins === bestGlobalMaxOppWins
            && currentPlayerWasted < bestGlobalPlayerWasted)
          || (playerWins === bestGlobalWins && maxOppWins === bestGlobalMaxOppWins
            && currentPlayerWasted === bestGlobalPlayerWasted
            && currentOpponentWasted > bestGlobalOpponentWasted)
          || bestGlobalWins === -1) {
          bestGlobalWins = playerWins;
          bestGlobalMaxOppWins = maxOppWins;
          bestGlobalPlayerWasted = currentPlayerWasted;
          bestGlobalOpponentWasted = currentOpponentWasted;
          bestGlobalDev = 0;
          bestGlobalAssign = new Map(assign);

          const now = timeCache;
          if (debug && reporter && now - lastLogTime > 250) {
            const msg = `[DEBUG] Iteration: ${ iterationCounter } | Temp: ${ T.toFixed(2) } | Best Strict Wins: ${ bestGlobalWins }/${ targetWins } | PlayerWaste: ${ currentPlayerWasted } | OppWaste: ${ currentOpponentWasted }`;
            reporter(msg);
            lastLogTime = now;
          }

          if (playerWins >= targetWins && newElectionWon) {
            if (debug && reporter) {
              reporter('[DEBUG] Target Strict Win Reached!');
            }
            break;
          }
        }
      } else if (bestGlobalDev !== 0 && currentDev < bestGlobalDev) {
        bestGlobalDev = currentDev;
        bestGlobalAssign = new Map(assign);
        if (currentDev === 0 && playerWins > 0 && !newElectionWon
          && (playerWins > bestNonStrictWins
            || (playerWins === bestNonStrictWins && maxOppWins < bestNonStrictMaxOppWins)
            || (playerWins === bestNonStrictWins && maxOppWins === bestNonStrictMaxOppWins
              && currentPlayerWasted < bestNonStrictPlayerWasted)
            || (playerWins === bestNonStrictWins && maxOppWins === bestNonStrictMaxOppWins
              && currentPlayerWasted === bestNonStrictPlayerWasted
              && currentOpponentWasted > bestNonStrictOpponentWasted))) {
          bestNonStrictAssign = new Map(assign);
          bestNonStrictWins = playerWins;
          bestNonStrictMaxOppWins = maxOppWins;
          bestNonStrictPlayerWasted = currentPlayerWasted;
          bestNonStrictOpponentWasted = currentOpponentWasted;
        }
      } else if (currentDev === 0 && playerWins > 0
        && (playerWins > bestNonStrictWins
          || (playerWins === bestNonStrictWins && maxOppWins < bestNonStrictMaxOppWins)
          || (playerWins === bestNonStrictWins && maxOppWins === bestNonStrictMaxOppWins
            && currentPlayerWasted < bestNonStrictPlayerWasted)
          || (playerWins === bestNonStrictWins && maxOppWins === bestNonStrictMaxOppWins
            && currentPlayerWasted === bestNonStrictPlayerWasted
            && currentOpponentWasted > bestNonStrictOpponentWasted))) {
        bestNonStrictAssign = new Map(assign);
        bestNonStrictWins = playerWins;
        bestNonStrictMaxOppWins = maxOppWins;
        bestNonStrictPlayerWasted = currentPlayerWasted;
        bestNonStrictOpponentWasted = currentOpponentWasted;
      }

      distAdj = buildDistAdj(distSets, assign, adj);
      // Reset restart counter only when we actually found a winning state
      if (newElectionWon) {
        restartCounter = 0;
      }
    }
  }

  // Final answer: prefer a strict election win; otherwise return the best
  // valid (dev = 0) partition found — needed for puzzles where a strict win
  // is spatially impossible (the player's ceiling is at or below the leading
  // opponent's forced floor; the site optimum itself is then a tie).
  if (bestGlobalWins === -1 || bestGlobalDev > 0) {
    if (bestNonStrictAssign && bestNonStrictWins > 0) {
      return {
        partArray: buildPartArray(bestNonStrictAssign, puzzle),
        wins: bestNonStrictWins,
        goal: targetWins,
        timedOut: true,
        isStrictWin: false,
      };
    }
    return { partArray: null, wins: 0, goal: targetWins, timedOut: true, isStrictWin: false };
  }

  const finalAssign = bestGlobalAssign!;
  const partArray = buildPartArray(finalAssign, puzzle);

  const finalDistSets: Map<number, Set<number>> = new Map();
  for (const [ idx, d ] of finalAssign) {
    if (!finalDistSets.has(d)) {
      finalDistSets.set(d, new Set());
    }
    finalDistSets.get(d)!.add(idx);
  }

  const finalWins = countWins(finalDistSets.values(), puzzle);
  const isStrictWin = finalWins > 0 && bestGlobalWins > bestGlobalMaxOppWins;
  return { partArray, wins: finalWins, goal: targetWins, timedOut: Date.now() >= deadline && finalWins < targetWins, isStrictWin };
}
