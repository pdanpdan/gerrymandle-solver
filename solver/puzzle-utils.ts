// Shared, browser-safe puzzle utilities: palette, date helpers, puzzle
// extraction from the API payload, scoring, and SVG rendering.
// Used by both the Node CLI (gerrymandle.js) and the web interface.

import type { HexTile, Puzzle } from './hex-utils.ts';

import { neighborsOf } from './hex-utils.ts';

export { neighborsOf };

// ---------------------------------------------------------------------------
// API types (gerrymandle.com/api/puzzle/gerry/<date>)
// ---------------------------------------------------------------------------

/** A hex tile as returned by the API. */
export interface ApiHex {
  row: number;
  col: number;
  party: number | null;
}

/** Board shape from the API payload. */
export interface ApiShape {
  width: number;
  height: number;
  hexes: ApiHex[];
}

/** The daily puzzle payload served by the API. */
export interface PuzzlePayload {
  shape: ApiShape;
  partyCount: number;
  regionCount: number;
  playerParty: number;
  optimum: number;
  optimumMargin: number;
  partyColours: number[];
  optimumPartition: (number | null)[];
  winningSample: (number | null)[];
  winningComplete: boolean;
  solvedVersion: number;
}

/** One daily puzzle as served by the API. */
export interface ApiPuzzleData {
  number: number;
  date: string;
  payload: PuzzlePayload;
  metadata?: Record<string, unknown>;
  prev?: string | null;
  next?: string | null;
}

/** Result of scoring one partition of a puzzle. */
export interface PartitionScore {
  results: Array<{ region: number; counts: Record<number, number>; winner: number | null; tileCount: number; }>;
  wins: number;
  maxOppWins: number;
  isStrictWin: boolean;
}

// ---------------------------------------------------------------------------
// Palette (first 8 entries are the default palette used by the daily puzzle).
// partyColours in the payload are indices into this list.
// Reverse-engineered from the site bundle (index-*.js).
// ---------------------------------------------------------------------------
export const PALETTE = [
  { name: 'blue', fill: '#2563eb', stroke: '#1d4ed8' },
  { name: 'orange', fill: '#f97316', stroke: '#c2410c' },
  { name: 'green', fill: '#22c55e', stroke: '#15803d' },
  { name: 'purple', fill: '#a855f7', stroke: '#7e22ce' },
  { name: 'red', fill: '#dc2626', stroke: '#991b1b' },
  { name: 'yellow', fill: '#eab308', stroke: '#a16207' },
  { name: 'teal', fill: '#14b8a6', stroke: '#0f766e' },
  { name: 'pink', fill: '#ec4899', stroke: '#be185d' },
];

// Day 1 of the puzzle series is 2026-05-11.
export const DAY_ONE = '2026-05-11';

export function todayLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${ d.getFullYear() }-${ p(d.getMonth() + 1) }-${ p(d.getDate()) }`;
}

export function dayDiff(a: string | Date, b: string | Date): number {
  const ms = Date.parse(`${ b }T00:00:00Z`) - Date.parse(`${ a }T00:00:00Z`);
  return Math.round(ms / 86400000);
}

export function addDays(date: string, n: number): string {
  const t = Date.parse(`${ date }T00:00:00Z`) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

export function fileStem(date: string, day: number, wins: number, total: number, type: string): string {
  return `${ date.replace(/-/g, '') }_${ day }_${ type }_${ wins }_${ total }`;
}

export function deriveDate(url: string): string {
  const m = url.match(/(\d{4}-\d{2}-\d{2})/);
  if (m) {
    return m[ 1 ];
  }
  return todayLocal();
}

export function deriveOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'https://gerrymandle.com';
  }
}

export function fetchPuzzle(url: string): Promise<{ date: string; api: string; data: ApiPuzzleData; }> {
  const origin = deriveOrigin(url);
  const date = deriveDate(url);
  const api = `${ origin }/api/puzzle/gerry/${ date }`;
  return fetch(api, { headers: { 'X-Dadel-User': 'solver' } }).then((res) => {
    if (!res.ok) {
      throw new Error(`API request failed: ${ api } -> HTTP ${ res.status }`);
    }
    return res.json().then((data) => ({ date, api, data }));
  });
}

export function extract(data: Pick<ApiPuzzleData, 'payload'> & Partial<Pick<ApiPuzzleData, 'number' | 'date' | 'metadata'>>): Puzzle {
  const p = data.payload;
  const shape = p.shape;
  const W = shape.width;
  const H = shape.height;

  const tiles: Map<number, HexTile> = new Map();
  for (const h of shape.hexes) {
    tiles.set(h.row * W + h.col, { col: h.col, row: h.row, party: h.party });
  }

  const houses = shape.hexes.filter((h: ApiHex) => h.party !== null).length;
  const regionCount = p.regionCount;
  const housesPerDistrict = Math.round(houses / regionCount);

  return {
    day: data.number ?? 0,
    date: data.date ?? '',
    width: W,
    height: H,
    tiles,
    hexes: shape.hexes,
    partyCount: p.partyCount,
    playerParty: p.playerParty,
    partyColours: p.partyColours,
    regionCount,
    housesPerDistrict,
    houses,
    optimum: p.optimum,
    optimumPartition: p.optimumPartition,
    metadata: data.metadata || {},
  };
}

export function partyName(partyIndex: number, puzzle: Puzzle): string {
  const palIdx = puzzle.partyColours[ partyIndex ];
  return PALETTE[ palIdx ] ? PALETTE[ palIdx ].name : `party${ partyIndex }`;
}

export function districtWinner(houseCounts: Record<number, number>): number | null {
  let best = -1;
  let bestParty = null;
  let tie = false;
  for (const [ party, cVal ] of Object.entries(houseCounts)) {
    const count = cVal;
    if (count > best) {
      best = count;
      bestParty = Number(party);
      tie = false;
    } else if (count === best) {
      tie = true;
    }
  }
  if (best <= 0 || tie) {
    return null;
  }
  return bestParty;
}

// ---------------------------------------------------------------------------
// Partition scoring
// ---------------------------------------------------------------------------
export function scorePartition(partArray: (number | null)[], puzzle: Puzzle): PartitionScore {
  const { tiles, playerParty } = puzzle;
  const regions = new Map();
  for (let idx = 0; idx < partArray.length; idx++) {
    const reg = partArray[ idx ];
    if (reg === null || reg === undefined) {
      continue;
    }
    if (!regions.has(reg)) {
      regions.set(reg, { counts: {}, tiles: [] });
    }
    const r = regions.get(reg);
    r.tiles.push(idx);
    const t = tiles.get(idx);
    if (t && t.party !== null) {
      r.counts[ t.party ] = (r.counts[ t.party ] || 0) + 1;
    }
  }
  const results: { region: number; counts: Record<number, number>; winner: number | null; tileCount: number; }[] = [];
  let wins = 0;
  const oppWins: Record<number, number> = {};
  for (const [ reg, r ] of [ ...regions.entries() ].sort((a, b) => a[ 0 ] - b[ 0 ])) {
    const winner = districtWinner(r.counts);
    if (winner !== null) {
      if (winner === playerParty) {
        wins++;
      } else {
        oppWins[ winner as number ] = (oppWins[ winner as number ] || 0) + 1;
      }
    }
    results.push({ region: reg, counts: r.counts, winner, tileCount: r.tiles.length });
  }
  let maxOppWins = 0;
  for (const v of Object.values(oppWins)) {
    if (v > maxOppWins) {
      maxOppWins = v;
    }
  }
  const isStrictWin = wins > 0 && wins > maxOppWins;
  return { results, wins, maxOppWins, isStrictWin };
}

// ---------------------------------------------------------------------------
// SVG rendering
// ---------------------------------------------------------------------------
function hexCenter(col: number, row: number, size: number): { x: number; y: number; } {
  const w = size * Math.sqrt(3);
  const x = col * w + (row % 2 === 1 ? w / 2 : 0) + w / 2;
  const y = row * 1.5 * size + size;
  return { x, y };
}

function hexPoints(cx: number, cy: number, size: number): number[][] {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 90);
    pts.push([ cx + size * Math.cos(angle), cy + size * Math.sin(angle) ]);
  }
  return pts;
}

// Convert a hex color into a pale variant for backgrounds.
function paleColor(hexColor: string): string {
  let c = hexColor.replace('#', '');
  if (c.length === 3) {
    c = c.split('').map((x: string) => x + x).join('');
  }
  const num = Number.parseInt(c, 16);
  let r = (num >> 16) & 255;
  let g = (num >> 8) & 255;
  let b = num & 255;
  r = Math.round(r * 0.3 + 255 * 0.7);
  g = Math.round(g * 0.3 + 255 * 0.7);
  b = Math.round(b * 0.3 + 255 * 0.7);
  return `#${ ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1) }`;
}

export interface RenderSvgOptions {
  /**
   * Web mode: transparent background and currentColor/opacity-based neutrals
   * so the SVG follows the page theme. CLI files keep explicit colors.
   */
  web?: boolean;
}

export function renderSVG(
  puzzle: Puzzle,
  partArray: (number | null)[] | null,
  title: string | null,
  scored: PartitionScore | null = null,
  opts: RenderSvgOptions = {},
): string {
  const web = opts.web ?? false;
  const size = 30;
  const { width: W, height: H, tiles } = puzzle;
  const w = size * Math.sqrt(3);
  const pad = 40;

  // ---- Compute title height upfront ----
  let offsetY = 40;
  if (scored) {
    // 1 main line + partyCount party lines + 1 ties line
    const nLines = 1 + puzzle.partyCount + 1;
    // A null title omits the "Day xxx" header, so the summary starts higher.
    offsetY = (title ? 28 : 2) + nLines * 22 + 10;
  } else if (title) {
    offsetY = 68;
  }

  const svgW = W * w + w + 2 * pad;
  const svgH = H * 1.5 * size + size + offsetY + pad;

  // Precompute region winners and their corresponding pale background colors
  const regionWinners = new Map();
  if (partArray) {
    const regions = new Map();
    for (let idx = 0; idx < partArray.length; idx++) {
      const reg = partArray[ idx ];
      if (reg === null || reg === undefined) {
        continue;
      }
      if (!regions.has(reg)) {
        regions.set(reg, {});
      }
      const r = regions.get(reg);
      const t = tiles.get(idx);
      if (t && t.party !== null) {
        r[ t.party ] = (r[ t.party ] || 0) + 1;
      }
    }
    for (const [ reg, counts ] of regions) {
      const winner = districtWinner(counts);
      if (winner !== null) {
        const pal = PALETTE[ puzzle.partyColours[ winner ] ];
        regionWinners.set(reg, pal ? paleColor(pal.fill) : '#ffffff');
      } else {
        regionWinners.set(reg, '#ffffff'); // white for ties
      }
    }
  }

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ svgW.toFixed(0) } ${ svgH.toFixed(0) }" font-family="sans-serif">`,
  );
  if (!web) {
    parts.push(`<rect width="100%" height="100%" fill="#f8fafc"/>`);
  }

  // ---- Title ----
  if (scored) {
    let ty = 54;
    if (title) {
      const yDay = String(puzzle.day).padStart(3, '0');
      const type = title.includes('best') ? 'best' : 'solv';
      parts.push(
        `<text x="${ pad }" y="28" font-size="18" font-weight="bold" fill="${ web ? 'currentColor' : '#111827' }">Day ${ yDay } (${ puzzle.date }) - ${ puzzle.regionCount } distr - ${ type }</text>`,
      );
    } else {
      // No header — the summary alone is enough (the web UI shows day/date
      // in the result card itself).
      ty = 28;
    }
    const results = [ ...scored.results ];

    // Build complete per-party win count map (all parties, 0 for missing)
    const allWins: Record<number, number> = {};
    let ties = 0;
    for (const r of results) {
      if (r.winner === null) {
        ties++;
      } else { allWins[ r.winner ] = (allWins[ r.winner ] || 0) + 1; }
    }
    // Ensure every known party appears
    for (let p = 0; p < puzzle.partyCount; p++) {
      if (!(p in allWins)) {
        allWins[ p ] = 0;
      }
    }

    // Order: the target (player) color first, then the other colors
    // alphabetically, then the ties line (rendered last).
    const sortedParties = [
      puzzle.playerParty,
      ...Object.keys(allWins)
        .map(Number)
        .filter((p) => p !== puzzle.playerParty)
        .sort((a, b) => partyName(a, puzzle).localeCompare(partyName(b, puzzle))),
    ];

    for (const p of sortedParties) {
      const pal = PALETTE[ puzzle.partyColours[ p ] ];
      const count = allWins[ p ];
      parts.push(
        `<rect x="${ pad }" y="${ ty - 12 }" width="16" height="16" rx="3" fill="${ paleColor(pal.fill) }" stroke="${ pal.stroke }" stroke-width="1"/>`,
      );
      parts.push(
        `<text x="${ pad + 22 }" y="${ ty }" font-size="14" fill="${ web ? 'currentColor' : '#334155' }">${ partyName(p, puzzle) }: <tspan font-weight="bold">${ count }</tspan> distr</text>`,
      );
      ty += 22;
    }

    parts.push(
      `<rect x="${ pad }" y="${ ty - 12 }" width="16" height="16" rx="3" fill="#ffffff" stroke="#94a3b8" stroke-width="1"/>`,
    );
    parts.push(
      `<text x="${ pad + 22 }" y="${ ty }" font-size="14" fill="${ web ? 'currentColor' : '#334155' }">ties: <tspan font-weight="bold">${ ties }</tspan> distr</text>`,
    );
  } else if (title) {
    parts.push(
      `<text x="${ pad }" y="28" font-size="18" font-weight="bold" fill="${ web ? 'currentColor' : '#111827' }">${ escapeXml(title) }</text>`,
    );
  }

  const regionOf = (idx: number) => (partArray ? partArray[ idx ] : null);
  const hexes = [];
  const borders = [];
  const circles = [];

  for (const [ idx, tile ] of tiles) {
    const { x, y } = hexCenter(tile.col, tile.row, size);
    const cx = x + pad;
    const cy = y + offsetY + pad;
    const pts = hexPoints(cx, cy, size);
    const ptsStr = pts.map((p) => `${ p[ 0 ].toFixed(1) },${ p[ 1 ].toFixed(1) }`).join(' ');

    const reg = regionOf(idx);
    let fill;
    if (reg != null && regionWinners.has(reg)) {
      fill = regionWinners.get(reg);
    } else if (tile.party !== null) {
      const pal = PALETTE[ puzzle.partyColours[ tile.party ] ];
      fill = pal ? pal.fill : '#999';
    } else {
      fill = '#f1f5f9';
    }

    hexes.push(`<polygon points="${ ptsStr }" fill="${ fill }" stroke="none"/>`);

    if (tile.party !== null) {
      const pal = PALETTE[ puzzle.partyColours[ tile.party ] ];
      const circleFill = pal ? pal.fill : '#999';
      const circleStroke = pal ? pal.stroke : '#666';
      circles.push(
        `<circle cx="${ cx.toFixed(1) }" cy="${ cy.toFixed(1) }" r="10" fill="${ circleFill }" stroke="${ circleStroke }" stroke-width="1.5"/>`,
      );
      circles.push(
        `<text x="${ cx.toFixed(1) }" y="${ (cy + 5).toFixed(1) }" font-size="14" text-anchor="middle" fill="#ffffff" font-weight="bold">${ tile.party }</text>`,
      );
    } else {
      circles.push(
        `<circle cx="${ cx.toFixed(1) }" cy="${ cy.toFixed(1) }" r="7" fill="#cbd5e1" stroke="#94a3b8" stroke-width="1"/>`,
      );
    }

    const nbs = neighborsOf(idx, puzzle);

    for (let e = 0; e < 6; e++) {
      const a = pts[ e ];
      const b = pts[ (e + 1) % 6 ];
      const mx = (a[ 0 ] + b[ 0 ]) / 2;
      const my = (a[ 1 ] + b[ 1 ]) / 2;
      let nbReg = null;
      let nbExists = false;
      for (const nb of nbs) {
        const nt = tiles.get(nb);
        if (!nt) {
          continue;
        }
        const nc = hexCenter(nt.col, nt.row, size);
        const ncx = nc.x + pad;
        const ncy = nc.y + offsetY + pad;
        const dist = Math.hypot(ncx - (cx + 2 * (mx - cx)), ncy - (cy + 2 * (my - cy)));
        if (dist < size * 0.9) {
          nbExists = true;
          nbReg = regionOf(nb);
          break;
        }
      }

      let edgeColor, edgeWidth, edgeOpacity;
      if (!nbExists) {
        edgeColor = '#000000';
        edgeWidth = 4.0;
        edgeOpacity = 0.7;
      } else if (reg !== null && nbReg === reg) {
        // Same-district tile borders: barely visible separators.
        edgeColor = web ? 'currentColor' : '#cbd5e1';
        edgeWidth = 0.5;
        edgeOpacity = 0.15;
      } else if (reg !== nbReg && (reg !== null || nbReg !== null)) {
        edgeColor = '#000000';
        edgeWidth = 4.0;
        edgeOpacity = 0.7;
      } else {
        edgeColor = web ? 'currentColor' : '#94a3b8';
        edgeWidth = 1.0;
        edgeOpacity = 0.25;
      }

      borders.push(
        `<line x1="${ a[ 0 ].toFixed(1) }" y1="${ a[ 1 ].toFixed(1) }" x2="${ b[ 0 ].toFixed(1) }" y2="${ b[ 1 ].toFixed(1) }" stroke="${ edgeColor }" stroke-width="${ edgeWidth }" stroke-linecap="round"${ web ? ` stroke-opacity="${ edgeOpacity }"` : '' }/>`,
      );

      // Extra white rim just outside the board outline for contrast.
      if (!nbExists) {
        const len = Math.hypot(mx - cx, my - cy) || 1;
        const ox = ((mx - cx) / len) * 2;
        const oy = ((my - cy) / len) * 2;
        borders.push(
          `<line x1="${ (a[ 0 ] + ox).toFixed(1) }" y1="${ (a[ 1 ] + oy).toFixed(1) }" x2="${ (b[ 0 ] + ox).toFixed(1) }" y2="${ (b[ 1 ] + oy).toFixed(1) }" stroke="#99999999" stroke-width="1" stroke-linecap="round"/>`,
        );
      }
    }
  }

  parts.push(hexes.join('\n'));
  parts.push(borders.join('\n'));
  parts.push(circles.join('\n'));

  parts.push(`</svg>`);
  return parts.join('\n');
}

export function escapeXml(s: string): string {
  const map: Record<string, string> = { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' };
  return String(s).replace(/[<>&'"]/g, (c) => map[ c ] || c);
}
