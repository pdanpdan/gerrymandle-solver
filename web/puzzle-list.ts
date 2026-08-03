import type { PuzzlePayload } from '../solver/puzzle-utils.ts';

import { addDays, DAY_ONE, dayDiff, fetchPuzzle, todayLocal } from '../solver/puzzle-utils.ts';

export interface PuzzleMeta {
  day: number;
  date: string;
  payload: PuzzlePayload;
}

// Fetch every published puzzle, oldest first (day 1 .. today).
// In dev the browser talks to /api/* through the Vite proxy (the API sends
// no CORS headers); in production the build script writes the same data to
// dist/client/puzzles.json, served same-origin by GitHub Pages.
export async function loadAllPuzzles(): Promise<PuzzleMeta[]> {
  const lastDay = dayDiff(DAY_ONE, todayLocal()) + 1;
  const days = Array.from({ length: lastDay }, (_, i) => i + 1);

  if (import.meta.env.DEV) {
    const entries = await Promise.all(days.map(async (day) => {
      const date = addDays(DAY_ONE, day - 1);
      try {
        // Absolute URL on the dev server origin — the Vite proxy forwards
        // /api to the real API (no CORS headers there).
        const { data } = await fetchPuzzle(`${ location.origin }/api/puzzle/gerry/${ date }`);
        return { day, date, payload: data.payload } as PuzzleMeta;
      } catch {
        return null; // no (or not yet published) puzzle for this day
      }
    }));
    return entries.filter((e): e is PuzzleMeta => e !== null);
  }

  const res = await fetch(`${ import.meta.env.BASE_URL }puzzles.json`);
  if (!res.ok) {
    throw new Error(`Failed to load puzzles.json: HTTP ${ res.status }`);
  }
  const list = await res.json() as PuzzleMeta[];
  // The build script and the client share the same data contract; guard
  // against a stale/empty artifact instead of rendering a broken list.
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('puzzles.json is empty — rebuild the site');
  }
  return list;
}
