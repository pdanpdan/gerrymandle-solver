#!/usr/bin/env node
import type { PuzzlePayload } from '../solver/puzzle-utils.ts';

// Fetch all published puzzles and write dist/client/puzzles.json, which the
// SPA loads on mount (the gerrymandle.com API sends no CORS headers, so the
// browser can't fetch it directly in production).
//
// Uses the same shared helpers as the CLI and the web app (solver/puzzle-utils.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { addDays, DAY_ONE, dayDiff, fetchPuzzle, latestPublishedDate } from '../solver/puzzle-utils.ts';

const OUT = path.join(fileURLToPath(new URL('..', import.meta.url)), 'dist', 'client', 'puzzles.json');

async function probe(date: string) {
  try {
    const { data } = await fetchPuzzle(`https://gerrymandle.com/api/puzzle/gerry/${ date }`);
    return data;
  } catch {
    return null; // no (or not yet published) puzzle for this day
  }
}

// Current day per the API (next === null), not per the build machine's clock:
// GitHub Actions runners are UTC while the site's day starts at midnight in
// its own timezone, so a UTC date can be one day behind the real puzzle day.
const lastDay = dayDiff(DAY_ONE, await latestPublishedDate(probe)) + 1;
const list: { day: number; date: string; payload: PuzzlePayload; }[] = [];
let failures = 0;
for (let day = 1; day <= lastDay; day++) {
  const date = addDays(DAY_ONE, day - 1);
  try {
    const { data } = await fetchPuzzle(`https://gerrymandle.com/api/puzzle/gerry/${ date }`);
    list.push({ day, date, payload: data.payload });
  } catch {
    failures++; // no (or not yet published) puzzle for this day
  }
}
if (list.length === 0) {
  throw new Error('fetch-puzzles: no puzzles could be fetched — refusing to write an empty puzzles.json');
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(list));
console.log(`fetch-puzzles: ${ list.length } puzzles (${ failures } missing) -> ${ OUT }`);
