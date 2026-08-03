// Anchored district enumeration for small gerrymandle boards.
//
// For W >= 2 winning districts the balanced ReCom chain is often disconnected
// from any W-win configuration, and fully random constructions rarely land in
// the right basin.  This module enumerates *candidate winning districts*:
// player houses are split into W anchor groups, and each group is grown into
// connected `housesPerDistrict`-house districts where the player strictly
// wins.  The resulting districts are used as SEEDS for the site-style
// transfer-climb solver (site-solver.js), which reshapes the rest of the
// partition into the full solution.
//
// Enumeration details:
//  - while the set has >= 2 components only tiles touching the SMALLEST
//    component (or bridging several) are allowed — forces the bridges to be
//    built instead of burning the budget on disconnected house combos;
//  - tiles are ordered by BFS distance to the other anchor houses — grows
//    thin connecting snakes instead of blobs;
//  - connectivity is verified at emission (the anchor may be disconnected);
//  - candidates are ordered by ascending empty-tile count (compact first).
//
// Best-effort: bounded by a time budget and per-group node caps.  Returns a
// deduplicated array of candidate district tile sets (single-district seeds
// for the site-style climb), or [].

import type { Puzzle } from './hex-utils.ts';

import { buildAdjacency, isHouse } from './hex-utils.ts';

function* combos(arr: number[], k: number, start: number, cur: number[]): Generator<number[], void, void> {
  if (cur.length === k) {
    yield [ ...cur ];
    return;
  }
  for (let i = start; i <= arr.length - (k - cur.length); i++) {
    cur.push(arr[ i ]);
    yield* combos(arr, k, i + 1, cur);
    cur.pop();
  }
}
const DEFAULT_TIME_BUDGET_MS = 4000;

/**
 * Enumerate anchored candidate winning districts for the site-style transfer solver.
 *
 * @param {Puzzle} puzzle - puzzle shape (tiles as Map, dimensions, party info)
 * @param {number} targetWins - desired number of player-winning districts (>= 2)
 * @param {number} [timeBudgetMs] - solver budget in milliseconds (default 4000)
 * @returns {Set<number>[]} deduplicated array of candidate district tile sets, or []
 */
export function collectSeedDistricts(
  puzzle: Puzzle,
  targetWins: number,
  timeBudgetMs: number = DEFAULT_TIME_BUDGET_MS,
): Set<number>[] {
  const deadline = Date.now() + timeBudgetMs;
  const adj = buildAdjacency(puzzle);
  const size = puzzle.housesPerDistrict;
  const K = puzzle.regionCount;
  const PP = puzzle.playerParty;
  const PC = puzzle.partyCount;
  const minWin = Math.floor(size / PC) + 1;

  const W = targetWins;
  if (W < 2 || W > K || W * minWin > puzzle.houses) {
    return [];
  }

  const playerHouses: number[] = [];
  for (const [ idx, tile ] of puzzle.tiles) {
    if (tile.party === PP) {
      playerHouses.push(idx);
    }
  }
  if (W > playerHouses.length) {
    return [];
  }

  const budget = { nodes: 0, cap: 4000000 };

  function isConnectedSet(set: Set<number>): boolean {
    const start = [ ...set ][ 0 ];
    const seen: Set<number> = new Set([ start ]);
    const stack: number[] = [ start ];
    while (stack.length) {
      const u: number = stack.pop()!;
      for (const v of (adj.get(u) || [])) {
        if (set.has(v) && !seen.has(v)) {
          seen.add(v);
          stack.push(v);
        }
      }
    }
    return seen.size === set.size;
  }

  function enumerateDistricts(group: number[], cap: number): Set<number>[] {
    const g = group.length;
    const outByEmpties: Set<number>[][] = [];
    if (size - g < 0 || size - g > (g - 1) * (PC - 1)) {
      return [];
    }

    const set = new Set<number>(group);
    const counts: Map<number, number> = new Map();
    for (let _tile = 0; _tile < g; _tile++) {
      counts.set(PP, g);
    }
    let houseCount: number = g;
    let emptyCount: number = 0;
    const frontier: number[] = [];
    const inFrontier: Set<number> = new Set();
    const pushFrontier = (t: number): void => {
      for (const n of (adj.get(t) || [])) {
        if (!set.has(n) && !inFrontier.has(n)) {
          inFrontier.add(n);
          frontier.push(n);
        }
      }
    };
    for (const t of group) {
      pushFrontier(t);
    }

    // BFS distances from each anchor house, used to grow toward the others.
    const distFrom: Map<number, Map<number, number>> = new Map();
    for (const h of group) {
      const dd: Map<number, number> = new Map([ [ h, 0 ] ]);
      const q: number[] = [ h ];
      let head = 0;
      while (head < q.length) {
        const u: number = q[ head++ ];
        for (const v of (adj.get(u) || [])) {
          if (!dd.has(v)) {
            dd.set(v, dd.get(u)! + 1);
            q.push(v);
          }
        }
      }
      distFrom.set(h, dd);
    }

    const MAX_EMPTIES = 10;
    let localNodes = 0;
    const LOCAL_NODE_CAP = 60000;
    const seen: Set<string> = new Set();
    function dfs(): void {
      if (++budget.nodes > budget.cap) {
        throw new Error('cap');
      }
      if (++localNodes > LOCAL_NODE_CAP) {
        throw new Error('cap');
      }
      if (Date.now() > deadline) {
        throw new Error('time');
      }
      if (houseCount === size) {
        if (!isConnectedSet(set)) {
          return;
        }
        const sig = [ ...set ].sort((a, b) => a - b).join(',');
        if (!seen.has(sig)) {
          seen.add(sig);
          if (!outByEmpties[ emptyCount ]) {
            outByEmpties[ emptyCount ] = [];
          }
          outByEmpties[ emptyCount ].push(new Set(set));
        }
        return;
      }
      const comps: number[][] = [];
      {
        const compSeen: Set<number> = new Set();
        for (const start of set) {
          if (compSeen.has(start)) {
            continue;
          }
          const comp: number[] = [];
          const stack: number[] = [ start ];
          compSeen.add(start);
          while (stack.length) {
            const u: number = stack.pop()!;
            comp.push(u);
            for (const v of (adj.get(u) || [])) {
              if (set.has(v) && !compSeen.has(v)) {
                compSeen.add(v);
                stack.push(v);
              }
            }
          }
          comps.push(comp);
        }
      }
      const compIdOf: Map<number, number> = new Map();
      comps.forEach((comp: number[], ci: number) => comp.forEach((t: number) => compIdOf.set(t, ci)));
      const smallestSize = comps.reduce((m: number, c: number[]) => Math.min(m, c.length), Infinity);
      const frontierTiles: number[] = frontier.filter((t: number) => {
        if (comps.length < 2) {
          return true;
        }
        let touchesSmallest = false;
        let touched = 0;
        for (const n of (adj.get(t) || [])) {
          const ci = compIdOf.get(n);
          if (ci === undefined) {
            continue;
          }
          touched++;
          if (comps[ ci ].length === smallestSize) {
            touchesSmallest = true;
          }
        }
        return touched >= 2 || touchesSmallest;
      });
      const distScore = (t: number): number => {
        let ci: number = -1;
        for (const n of (adj.get(t) || [])) {
          const c2 = compIdOf.get(n);
          if (c2 !== undefined) {
            ci = c2;
            break;
          }
        }
        let s = 0;
        for (const h of group) {
          if (ci >= 0 && comps[ ci ].includes(h)) {
            continue;
          }
          s += distFrom.get(h)!.get(t) ?? 50;
        }
        return s;
      };
      const order: number[] = [ ...frontierTiles ].sort(
        (a: number, b: number) =>
          distScore(a) - distScore(b)
          || (isHouse(puzzle.tiles.get(a)) ? 0 : 1) - (isHouse(puzzle.tiles.get(b)) ? 0 : 1),
      );
      for (const t of order) {
        if (!inFrontier.has(t)) {
          continue;
        }
        const tile = puzzle.tiles.get(t);
        const isH = isHouse(tile);
        if (isH) {
          if (houseCount + 1 > size) {
            continue;
          }
          const pt: number = tile!.party as number;
          if (pt !== PP && (counts.get(pt) || 0) + 1 > g - 1) {
            continue;
          }
        } else if (emptyCount + 1 > MAX_EMPTIES) {
          continue;
        }
        set.add(t);
        inFrontier.delete(t);
        frontier.splice(frontier.indexOf(t), 1);
        if (isH) {
          houseCount++;
          counts.set(tile!.party as number, (counts.get(tile!.party as number) || 0) + 1);
        } else {
          emptyCount++;
        }
        pushFrontier(t);
        dfs();
        if (isH) {
          houseCount--;
          const c = counts.get(tile!.party as number);
          if (c === 1) {
            counts.delete(tile!.party as number);
          } else { counts.set(tile!.party as number, c! - 1); }
        } else {
          emptyCount--;
        }
        set.delete(t);
        for (const n of (adj.get(t) || [])) {
          if (inFrontier.has(n) && ![ ...set ].some((x: number) => (adj.get(x) || []).includes(n))) {
            inFrontier.delete(n);
            const ix = frontier.indexOf(n);
            if (ix >= 0) {
              frontier.splice(ix, 1);
            }
          }
        }
        inFrontier.add(t);
        frontier.push(t);
        if (seen.size >= cap) {
          return;
        }
      }
    }
    try {
      dfs();
    } catch {
      /* node / time cap */
    }
    const out: Set<number>[] = [];
    for (let i = 0; i < outByEmpties.length; i++) {
      const bucket = outByEmpties[ i ];
      if (!bucket) {
        continue;
      }
      for (const c of bucket) {
        out.push(c);
        if (out.length >= cap) {
          return out;
        }
      }
      if (out.length >= cap) {
        return out;
      }
    }
    return out;
  }

  function* compositions(w: number, minG: number, maxG: number, sumLeft: number, prefix: number[]): Generator<number[], void, void> {
    if (w === 0) {
      if (sumLeft >= 0) {
        yield prefix;
      }
      return;
    }
    for (let g = minG; g <= Math.min(maxG, sumLeft - (w - 1) * minG); g++) {
      yield* compositions(w - 1, minG, maxG, sumLeft - g, [ ...prefix, g ]);
    }
  }

  const spanCache: Map<string, number> = new Map();
  function groupSpan(group: number[]): number {
    const key = [ ...group ].sort((a, b) => a - b).join(',');
    if (spanCache.has(key)) {
      return spanCache.get(key)!;
    }
    let span = 0;
    for (let i = 0; i < group.length; i++) {
      const dist: Map<number, number> = new Map([ [ group[ i ], 0 ] ]);
      const frontier: number[] = [ group[ i ] ];
      let head = 0;
      while (head < frontier.length) {
        const u: number = frontier[ head++ ];
        for (const v of (adj.get(u) || [])) {
          if (!dist.has(v)) {
            dist.set(v, dist.get(u)! + 1);
            frontier.push(v);
          }
        }
      }
      for (let j = i + 1; j < group.length; j++) {
        span += dist.get(group[ j ]) ?? 99;
      }
    }
    spanCache.set(key, span);
    return span;
  }

  const comps = [ ...compositions(W, minWin, size, playerHouses.length, []) ]
    .sort((a: number[], b: number[]) => a.reduce((x: number, y: number) => x + y, 0) - b.reduce((x: number, y: number) => x + y, 0));

  const seeds: Set<number>[] = [];
  const seenSeeds: Set<string> = new Set();
  const MAX_SEEDS = 48;
  const MAX_GROUPINGS = 200;

  for (const comp of comps) {
    if (Date.now() > deadline || seeds.length >= MAX_SEEDS) {
      break;
    }
    const groupings: number[][][] = [];
    const pick = (idx: number, remaining: number[], acc: number[][]): void => {
      if (groupings.length >= MAX_GROUPINGS) {
        return;
      }
      if (Date.now() > deadline) {
        return;
      }
      if (idx === comp.length) {
        groupings.push(acc);
        return;
      }
      for (const sub of combos(remaining, comp[ idx ], 0, [])) {
        const nextRem = remaining.filter((x: number) => !sub.includes(x));
        pick(idx + 1, nextRem, [ ...acc, sub ]);
      }
    };
    pick(0, playerHouses, []);
    groupings.sort(
      (x: number[][], y: number[][]) =>
        x.reduce((s: number, g: number[]) => s + groupSpan(g), 0) - y.reduce((s: number, g: number[]) => s + groupSpan(g), 0),
    );

    for (const grouping of groupings) {
      if (Date.now() > deadline || seeds.length >= MAX_SEEDS) {
        break;
      }
      for (const grp of grouping) {
        const cands = enumerateDistricts(grp, 6);
        for (const cand of cands) {
          if (seeds.length >= MAX_SEEDS) {
            break;
          }
          const sig = [ ...cand ].sort((x: number, y: number) => x - y).join(',');
          if (seenSeeds.has(sig)) {
            continue;
          }
          seenSeeds.add(sig);
          seeds.push(cand);
        }
        if (Date.now() > deadline || seeds.length >= MAX_SEEDS) {
          break;
        }
      }
    }
  }
  return seeds;
}
