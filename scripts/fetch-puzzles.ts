#!/usr/bin/env node
import type { PuzzlePayload } from '../solver/puzzle-utils.ts';

// Fetch all published puzzles and write dist/client/puzzles.json, which the
// SPA loads on mount (the gerrymandle.com API sends no CORS headers, so the
// browser can't fetch it directly in production).
//
// Uses the same shared helpers as the CLI and the web app (solver/puzzle-utils.ts).
//
// Published puzzle payloads are immutable, so when PUZZLES_BASE_URL points at
// the previously deployed site, its puzzles.json is reused and only new or
// missing days are fetched. That keeps frequent rebuilds (the GitHub Actions
// scheduler can create runs hours late) down to a handful of API requests
// instead of one per puzzle in the series.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { addDays, DAY_ONE, dayDiff, fetchPuzzle, latestPublishedDate } from '../solver/puzzle-utils.ts';

interface PuzzleEntry {
  day: number;
  date: string;
  payload: PuzzlePayload;
}

const OUT = path.join(fileURLToPath(new URL('..', import.meta.url)), 'dist', 'client', 'puzzles.json');

// URL of the previous deployment's puzzles.json (trailing slash optional).
// Unset -> full fetch (local builds, first deployment).
const BASE_URL = process.env.PUZZLES_BASE_URL;

// Re-fetch the newest days even when the base has them: a payload can be
// corrected shortly after publication, and the base may predate that.
const REFETCH_DAYS = 2;

async function probe(date: string) {
  try {
    const { data } = await fetchPuzzle(`https://gerrymandle.com/api/puzzle/gerry/${ date }`);
    return data;
  } catch {
    return null; // no (or not yet published) puzzle for this day
  }
}

function isEntry(value: unknown): value is PuzzleEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Partial<PuzzleEntry>;
  return typeof entry.day === 'number'
    && Number.isInteger(entry.day)
    && entry.day >= 1
    && typeof entry.date === 'string'
    && entry.date === addDays(DAY_ONE, entry.day - 1)
    && typeof entry.payload === 'object'
    && entry.payload !== null
    && Array.isArray(entry.payload.shape.hexes);
}

async function loadBase(): Promise<PuzzleEntry[]> {
  if (!BASE_URL) {
    return [];
  }
  const baseUrl = BASE_URL.endsWith('/')
    ? BASE_URL
    : `${ BASE_URL }/`;
  try {
    const res = await fetch(new URL('puzzles.json', baseUrl));
    if (!res.ok) {
      return [];
    }
    const raw: unknown = await res.json();
    if (!Array.isArray(raw)) {
      return [];
    }
    const byDay = new Map<number, PuzzleEntry>();
    for (const entry of raw) {
      if (isEntry(entry) && !byDay.has(entry.day)) {
        byDay.set(entry.day, entry);
      }
    }
    return [
      ...byDay.values(),
    ].sort((a, b) => a.day - b.day);
  } catch {
    return []; // unreachable or invalid base -> full fetch
  }
}

// Current day per the API (next === null), not per the build machine's clock:
// GitHub Actions runners are UTC while the site's day starts at midnight in
// its own timezone, so a UTC date can be one day behind the real puzzle day.
const latestDate = await latestPublishedDate(probe);
const base = await loadBase();
const baseLastDay = base.at(-1)?.day ?? 0;
// Trust a base entry even if the API reports an earlier day (transient lag).
const lastDay = Math.max(dayDiff(DAY_ONE, latestDate) + 1, baseLastDay);
const refetchFrom = Math.max(1, lastDay - REFETCH_DAYS + 1);

const entries = new Map<number, PuzzleEntry>();
for (const entry of base) {
  if (entry.day <= lastDay) {
    entries.set(entry.day, entry);
  }
}

// Fetch days the base is missing (gaps, the new day) and the recent tail.
const toFetch: number[] = [];
for (let day = 1; day <= lastDay; day++) {
  if (!entries.has(day) || day >= refetchFrom) {
    toFetch.push(day);
  }
}

let fetched = 0;
let failures = 0;
for (const day of toFetch) {
  const date = addDays(DAY_ONE, day - 1);
  try {
    const { data } = await fetchPuzzle(`https://gerrymandle.com/api/puzzle/gerry/${ date }`);
    entries.set(day, { day, date, payload: data.payload });
    fetched++;
  } catch {
    failures++; // keep the base entry (if any) when a re-fetch fails
  }
}

const list = [
  ...entries.values(),
].sort((a, b) => a.day - b.day);
if (list.length === 0) {
  throw new Error('fetch-puzzles: no puzzles could be fetched — refusing to write an empty puzzles.json');
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(list));
console.log(`fetch-puzzles: ${ list.length } puzzles (${ fetched } fetched, ${ failures } missing) -> ${ OUT }`);
