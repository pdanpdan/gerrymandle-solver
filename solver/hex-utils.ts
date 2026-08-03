// Shared hex-grid and district utilities used by solver modules.
// A new solver only needs to implement a solve() function and its own
// algorithm-specific helpers — everything below can be reused unchanged.

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

/** A hex tile on the board. */
export interface HexTile {
  col: number;
  row: number;
  party: number | null;
}

/** A gerrymandering puzzle extracted from the game data. */
export interface Puzzle {
  day: number;
  date: string;
  width: number;
  height: number;
  tiles: Map<number, HexTile>;
  hexes: Array<{ row: number; col: number; party: number | null; }>;
  playerParty: number;
  housesPerDistrict: number;
  partyCount: number;
  regionCount: number;
  houses: number;
  partyColours: number[];
  optimum: number;
  optimumPartition: (number | null)[];
  metadata: Record<string, unknown>;
}

/** Result of district statistics computation. */
export interface DistrictStatsResult {
  houses: number;
  winner: number | null;
  isWin: number;
  playerWasted: number;
  opponentWasted: number;
  dev: number;
}

/** Result of player cluster analysis. */
export interface ClusterResult {
  feasibleMax: number;
  cores: number[][];
}

/** Result of the recom-solver solve() function. */
export interface SolveResult {
  partArray: (number | null)[] | null;
  wins: number;
  goal: number;
  timedOut: boolean;
  isStrictWin: boolean;
}

// ---------------------------------------------------------------------------
// Hex grid (odd-r layout, matching the game)
// ---------------------------------------------------------------------------
const NEIGHBORS_EVEN = [ [ -1, 0 ], [ 1, 0 ], [ -1, -1 ], [ 0, -1 ], [ -1, 1 ], [ 0, 1 ] ];
const NEIGHBORS_ODD = [ [ -1, 0 ], [ 1, 0 ], [ 0, -1 ], [ 1, -1 ], [ 0, 1 ], [ 1, 1 ] ];
/**
 * Get the neighbor indices of a hex tile in odd-r layout.
 * @param {number} idx - tile index
 * @param {Puzzle} puzzle - the puzzle object
 * @returns {number[]} neighboring tile indices
 */
export function neighborsOf(idx: number, puzzle: Puzzle): number[] {
  const { width: W, height: H, tiles } = puzzle;
  const col = idx % W;
  const row = Math.floor(idx / W);
  const deltas = row % 2 === 0 ? NEIGHBORS_EVEN : NEIGHBORS_ODD;
  const out = [];
  for (const [ dc, dr ] of deltas) {
    const nc = col + dc;
    const nr = row + dr;
    if (nc < 0 || nc >= W || nr < 0 || nr >= H) {
      continue;
    }
    const ni = nr * W + nc;
    if (tiles.has(ni)) {
      out.push(ni);
    }
  }
  return out;
}

export function buildAdjacency(puzzle: Puzzle): Map<number, number[]> {
  const adj = new Map();
  for (const idx of puzzle.tiles.keys()) {
    adj.set(idx, neighborsOf(idx, puzzle));
  }
  return adj;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------
export function isHouse(tile: { party: number | null; } | undefined): boolean {
  return tile != null && tile.party !== null;
}

export function shuffle(arr: number[], rand: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [ arr[ i ], arr[ j ] ] = [ arr[ j ], arr[ i ] ];
  }
}

export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildPartArray(assign: Map<number, number>, puzzle: Puzzle): (number | null)[] {
  const { width: W, height: H } = puzzle;
  const arr = Array.from<number | null>({ length: W * H }).fill(null);
  for (const [ idx, reg ] of assign) {
    arr[ idx ] = reg;
  }
  return arr;
}

// ---------------------------------------------------------------------------
// District statistics
// ---------------------------------------------------------------------------
export function districtStats(tileSet: Set<number>, puzzle: Puzzle): DistrictStatsResult {
  const { playerParty, housesPerDistrict: size } = puzzle;
  const cnt: Record<number, number> = {};
  let houses = 0;

  for (const idx of tileSet) {
    const t = puzzle.tiles.get(idx);
    if (isHouse(t)) {
      const party: number = t!.party!;
      cnt[ party ] = (cnt[ party ] || 0) + 1;
      houses++;
    }
  }

  let maxOpponent = 0;
  let wnr = null;
  let maxVotes = -1;
  let tie = false;

  for (const [ p, c ] of Object.entries(cnt) as [string, number][]) {
    const pi = Number(p);
    if (c > maxVotes) {
      maxVotes = c;
      wnr = pi;
      tie = false;
    } else if (c === maxVotes) {
      tie = true;
    }
    if (pi !== playerParty && c > maxOpponent) {
      maxOpponent = c;
    }
  }

  if (tie || maxVotes <= 0) {
    wnr = null;
  }

  const isWin = (wnr === playerParty) ? 1 : 0;
  const playerVotes = cnt[ playerParty ] || 0;
  const minWin = Math.floor(houses / puzzle.partyCount) + 1;

  let playerWasted: number, opponentWasted: number;
  if (wnr === playerParty) {
    // Player won: surplus above min needed is wasted; all opponent votes are wasted.
    playerWasted = Math.max(0, playerVotes - minWin);
    opponentWasted = houses - playerVotes;
  } else if (wnr !== null) {
    // Opponent won: all player votes wasted; winner's surplus is also wasted.
    playerWasted = playerVotes;
    opponentWasted = Math.max(0, (cnt[ wnr ] || 0) - minWin);
  } else {
    // Tie: no waste for either side.
    playerWasted = 0;
    opponentWasted = 0;
  }

  const dev = Math.abs(houses - size);
  return { houses, winner: wnr, isWin, playerWasted, opponentWasted, dev };
}

export function countWins(districtSets: Iterable<Set<number>>, puzzle: Puzzle): number {
  let wins = 0;
  for (const set of districtSets) {
    wins += districtStats(set, puzzle).isWin;
  }
  return wins;
}

// ---------------------------------------------------------------------------
// Player cluster analysis — finds how many winning districts are spatially
// feasible given the player's house positions and district size.
// Uses all-pairs BFS distances + clique detection for minWin groups.
// ---------------------------------------------------------------------------
export function analyzePlayerClusters(puzzle: Puzzle): ClusterResult {
  const { playerParty, housesPerDistrict: size, partyCount } = puzzle;
  const minWin = Math.floor(size / partyCount) + 1;
  const adj = buildAdjacency(puzzle);

  const playerHouses: number[] = [];
  for (const [ idx, tile ] of puzzle.tiles) {
    if (tile.party === playerParty) {
      playerHouses.push(idx);
    }
  }
  const theoreticalMax = Math.min(puzzle.regionCount, Math.floor(playerHouses.length / minWin));
  if (minWin <= 1 || playerHouses.length < minWin) {
    return { feasibleMax: theoreticalMax, cores: [] };
  }

  // All-pairs BFS distances (edge count) between player houses
  const distance: Map<number, Map<number, number>> = new Map();
  for (const a of playerHouses) {
    const dist: Map<number, number> = new Map();
    const visited: Set<number> = new Set([ a ]);
    const frontier: number[] = [ a ];
    dist.set(a, 0);
    let head = 0;
    while (head < frontier.length) {
      const u = frontier[ head++ ];
      const d: number = dist.get(u)!;
      for (const v of (adj.get(u) || [])) {
        if (visited.has(v)) {
          continue;
        }
        visited.add(v);
        frontier.push(v);
        dist.set(v, d + 1);
      }
    }
    distance.set(a, dist);
  }

  // Two houses are compatible if BFS-distance + 1 (path length) ≤ size
  const compatible: Map<number, Set<number>> = new Map();
  for (const a of playerHouses) {
    compatible.set(a, new Set());
  }
  for (let i = 0; i < playerHouses.length; i++) {
    for (let j = i + 1; j < playerHouses.length; j++) {
      const a = playerHouses[ i ];
      const b = playerHouses[ j ];
      const d: number | undefined = distance.get(a)!.get(b);
      if (d !== undefined && d + 1 <= size) {
        compatible.get(a)!.add(b);
        compatible.get(b)!.add(a);
      }
    }
  }

  // Greedily select disjoint cliques via pruning inside the generator
  const used: Set<number> = new Set();
  const cliques: number[][] = [];
  function* subsets(arr: number[], k: number, start: number, cur: number[], usedSet: Set<number> | undefined): Generator<number[]> {
    if (cur.length === k) {
      yield [ ...cur ];
      return;
    }
    const needed = k - cur.length;
    for (let i = start; i <= arr.length - needed; i++) {
      const a = arr[ i ];
      if (usedSet?.has(a)) {
        continue;
      }
      // Early prune: check compatibility with all nodes already in cur
      if (cur.some((x: number) => !compatible.get(x)!.has(a))) {
        continue;
      }
      cur.push(a);
      yield* subsets(arr, k, i + 1, cur, usedSet);
      cur.pop();
    }
  }
  for (const c of subsets(playerHouses, minWin, 0, [], used)) {
    for (const h of c) {
      used.add(h);
    }
    cliques.push(c);
  }
  const feasible = cliques.length;

  return { feasibleMax: Math.min(feasible, theoreticalMax), cores: [] };
}

// ---------------------------------------------------------------------------
// Greedy constructive solver — builds districts by BFS from player house
// clusters, then fills remaining territory.  Falls back when ReCom times out.
// ---------------------------------------------------------------------------
export function greedySolve(puzzle: Puzzle): Map<number, number> {
  const { playerParty, housesPerDistrict: size, partyCount, regionCount: K } = puzzle;
  const minWin = Math.floor(size / partyCount) + 1;
  const adj = buildAdjacency(puzzle);
  const allTiles = new Set(puzzle.tiles.keys());
  const playerHouses: number[] = [];
  for (const [ idx, tile ] of puzzle.tiles) {
    if (tile.party === playerParty) {
      playerHouses.push(idx);
    }
  }

  const assign: Map<number, number> = new Map();
  let nextDistrict = 0;

  // Phase 1: build winning districts around player house clusters
  const used: Set<number> = new Set();
  while (nextDistrict < K && playerHouses.some((h) => !used.has(h))) {
    const start = playerHouses.find((h) => !used.has(h));
    if (start === undefined) {
      break;
    }

    // BFS collecting tiles until we have minWin player houses AND size total houses
    const frontier: number[] = [ start ];
    const visited: Set<number> = new Set([ start ]);
    let housesIn = 1;
    let playerIn = 1;
    let head = 0;

    let done = false;
    while (head < frontier.length && !done) {
      const u = frontier[ head++ ];
      const nbs: number[] = [ ...(adj.get(u) || []) ].filter((v: number) => !visited.has(v) && !used.has(v));
      nbs.sort((a, b) => {
        const ta = puzzle.tiles.get(a);
        const tb = puzzle.tiles.get(b);
        const aP = ta?.party === playerParty ? 0 : ta?.party !== null ? 1 : 2;
        const bP = tb?.party === playerParty ? 0 : tb?.party !== null ? 1 : 2;
        return aP - bP;
      });
      for (const v of nbs) {
        if (housesIn >= size && playerIn >= minWin) {
          done = true;
          break;
        }
        const tv = puzzle.tiles.get(v);
        if (tv && tv.party !== null && tv.party !== undefined) {
          housesIn++;
        }
        if (tv?.party === playerParty) {
          playerIn++;
        }
        visited.add(v);
        frontier.push(v);
      }
    }

    if (playerIn >= minWin && housesIn >= size) {
      // Winning district with correct size — commit it
      for (const t of visited) {
        assign.set(t, nextDistrict);
        used.add(t);
      }
      nextDistrict++;
    } else {
      // Not enough player houses or wrong size — skip
      break;
    }
  }

  // Phase 2: build remaining districts from leftover tiles
  const leftover: number[] = [];
  for (const idx of allTiles) {
    if (!used.has(idx)) {
      leftover.push(idx);
    }
  }
  // Group connected components of leftover tiles
  const components: number[][] = [];
  const seen: Set<number> = new Set();
  for (const idx of leftover) {
    if (seen.has(idx)) {
      continue;
    }
    const comp: Set<number> = new Set();
    const stack: number[] = [ idx ];
    while (stack.length) {
      const u = stack.pop()!;
      if (seen.has(u)) {
        continue;
      }
      seen.add(u);
      comp.add(u);
      for (const v of (adj.get(u) || [])) {
        if (!used.has(v) && !seen.has(v)) {
          stack.push(v);
        }
      }
    }
    components.push([ ...comp ]);
  }
  components.sort((a: number[], b: number[]) => b.length - a.length);

  for (const comp of components) {
    const needed = K - nextDistrict;
    if (needed <= 0) {
      break;
    }

    // Count houses in this component
    const compHouses = comp.filter((idx) => {
      const t = puzzle.tiles.get(idx);
      return t && t.party !== null && t.party !== undefined;
    });
    // Houses per remaining district
    const housesPer = Math.max(1, Math.ceil(compHouses.length / needed));

    const usedLocal: Set<number> = new Set();
    for (let d = 0; d < needed && usedLocal.size < comp.length; d++, nextDistrict++) {
      // Find first unassigned tile in component
      const s = comp.find((c) => !usedLocal.has(c));
      if (s === undefined) {
        break;
      }

      const f = [ s ];
      const v = new Set([ s ]);
      let hd = 0;
      let houseCount = 0;
      const st = puzzle.tiles.get(s);
      if (st && st.party !== null && st.party !== undefined) {
        houseCount++;
      }

      while (hd < f.length && houseCount < housesPer) {
        const u = f[ hd++ ];
        const nbs = [ ...(adj.get(u) || []) ].filter((nb) =>
          !used.has(nb) && !v.has(nb) && comp.includes(nb),
        );
        nbs.sort((a, b) => {
          const ta = puzzle.tiles.get(a);
          const tb = puzzle.tiles.get(b);
          return (ta?.party != null ? 0 : 1) - (tb?.party != null ? 0 : 1);
        });
        for (const nb of nbs) {
          if (houseCount >= housesPer) {
            break;
          }
          const tnb = puzzle.tiles.get(nb);
          if (tnb && tnb.party !== null && tnb.party !== undefined) {
            houseCount++;
          }
          v.add(nb);
          f.push(nb);
        }
      }
      for (const t of v) {
        assign.set(t, nextDistrict);
        used.add(t);
        usedLocal.add(t);
      }
    }
  }

  // Assign any remaining unassigned tiles
  for (const idx of allTiles) {
    if (!assign.has(idx)) {
      for (const n of (adj.get(idx) || [])) {
        if (assign.has(n)) {
          assign.set(idx, assign.get(n)!);
          break;
        }
      }
    }
    if (!assign.has(idx)) {
      assign.set(idx, 0);
    }
  }

  return assign;
}
