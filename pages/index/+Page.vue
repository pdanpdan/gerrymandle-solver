<script setup lang="ts">
import type { PuzzleMeta } from '../../web/puzzle-list';
import type { ThemeMode } from '../../web/theme';

import { computed, onBeforeMount, onBeforeUnmount, onMounted, reactive, ref, toRaw, watch } from 'vue';

import { extract, fileStem, PALETTE, partyName, renderSVG, scorePartition } from '../../solver/puzzle-utils';
import { loadAllPuzzles } from '../../web/puzzle-list';
import { runSolve } from '../../web/solver';
import { DAISYUI_THEME } from '../../web/theme';

// ---------------------------------------------------------------------------
// Theme (light / dark / system)
// ---------------------------------------------------------------------------
// Client-only state: localStorage is unavailable (and must not be touched)
// during build/SSR, so the stored theme is read in beforeMount.
const theme = ref<ThemeMode>('system');

function applyTheme(mode: ThemeMode) {
  const root = document.documentElement;
  if (mode === 'system') {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = DAISYUI_THEME[ mode ];
  }
  localStorage.setItem('gerry-theme', mode);
}

function onSchemeChange() {
  if (theme.value === 'system') {
    applyTheme('system');
  }
}

// "/" focuses the puzzle filter from anywhere (except while typing).
function onFilterShortcut(e: KeyboardEvent) {
  const target = e.target;
  const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
  if (e.key === '/' && !typing) {
    e.preventDefault();
    document.querySelector<HTMLInputElement>('#puzzle-filter')?.focus();
  }
}

onBeforeMount(() => {
  const stored = localStorage.getItem('gerry-theme');
  if (stored === 'light' || stored === 'dark') {
    theme.value = stored;
  }
  applyTheme(theme.value);

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', onSchemeChange);
  window.addEventListener('keydown', onFilterShortcut);
});

onBeforeUnmount(() => {
  window.matchMedia('(prefers-color-scheme: dark)').removeEventListener('change', onSchemeChange);
  window.removeEventListener('keydown', onFilterShortcut);
});

watch(theme, applyTheme);

// ---------------------------------------------------------------------------
// Puzzle list + filter + selection
// ---------------------------------------------------------------------------
const puzzles = ref<PuzzleMeta[]>([]);
const puzzlesLoading = ref(true);
const puzzlesError = ref<string | null>(null);

onMounted(() => {
  reloadPuzzles();
});

async function reloadPuzzles() {
  puzzlesLoading.value = true;
  puzzlesError.value = null;
  try {
    puzzles.value = await loadAllPuzzles();
    restoreSolved();
  } catch (err) {
    puzzlesError.value = err instanceof Error ? err.message : String(err);
  } finally {
    puzzlesLoading.value = false;
  }
}

const filter = ref('');
const selected = ref<Set<number>>(new Set());
const statuses = reactive<Record<number, DayStatus>>({});
const page = ref(1);
const PAGE_SIZE = 12;
type ListView = 'all' | 'selected' | 'solved';
const listView = ref<ListView>('all');

const filteredPuzzles = computed<PuzzleMeta[]>(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) {
    return puzzles.value;
  }
  const n = Number(q);
  const byDay = Number.isInteger(n) && n >= 1 && n <= 999 ? (p: PuzzleMeta) => p.day === n : null;
  // Dates match on the MM-DD part (the year is the same for every day),
  // unless the query itself contains a year (e.g. a full YYYY-MM-DD date).
  const byDate = (p: PuzzleMeta) => q.includes('-') ? p.date.includes(q) : p.date.slice(5).includes(q);
  return puzzles.value.filter((p) => (byDay ? byDay(p) : false) || byDate(p));
});

const visiblePuzzles = computed<PuzzleMeta[]>(() => {
  // Most recent day first in every view.
  switch (listView.value) {
    case 'selected':
      return filteredPuzzles.value.filter((p) => selected.value.has(p.day)).reverse();
    case 'solved':
      return filteredPuzzles.value.filter((p) => statuses[ p.day ]?.state === 'done').reverse();
    default:
      return filteredPuzzles.value.slice().reverse();
  }
});

// Empty-list message depends on which view is active.
const emptyListMessage = computed(() => {
  if (filteredPuzzles.value.length === 0) {
    return 'No days match the filter.';
  }
  return listView.value === 'selected' ? 'No days selected yet.' : 'No solved days yet.';
});

const pageCount = computed(() => Math.max(1, Math.ceil(visiblePuzzles.value.length / PAGE_SIZE)));
const pageNumbers = computed(() => Array.from({ length: pageCount.value }, (_, i) => i + 1));
const pagedPuzzles = computed(() => visiblePuzzles.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE));

// Reset to page 1 whenever the filter or list view changes.
watch([ filter, listView ], () => {
  page.value = 1;
});

function selectAllFiltered() {
  for (const p of filteredPuzzles.value) {
    selected.value.add(p.day);
  }
}

function deselectAllFiltered() {
  for (const p of filteredPuzzles.value) {
    selected.value.delete(p.day);
  }
}

function invertSelection() {
  for (const p of filteredPuzzles.value) {
    if (selected.value.has(p.day)) {
      selected.value.delete(p.day);
    } else {
      selected.value.add(p.day);
    }
  }
}

// Select days that have not been solved yet: never tried (no status) or
// failed. Tied/lost days count as processed and are left alone.
function selectUnsolvedFiltered() {
  for (const p of filteredPuzzles.value) {
    const st = statuses[ p.day ];
    if (!st || st.state === 'failed') {
      selected.value.add(p.day);
    }
  }
}

// ---------------------------------------------------------------------------
// Solving
// ---------------------------------------------------------------------------
// Hard puzzles (tie-district cases like days 26/30/51) need up to ~60s per
// attempt; typical days finish far sooner. Each day races several parallel
// attempts with the CLI-proven seed sequence, so wall time stays ~60s.
const TIME_LIMIT_MS = 60000;
const ATTEMPTS_PER_DAY = 4;

type DayStatus
  = | { state: 'queued' | 'running' | 'done'; dots: number; won?: boolean; }
    | { state: 'failed'; dots: number; error: string; };

function statusBadge(st: DayStatus): { cls: string; label: string; } {
  if (st.state === 'done') {
    // Solved: green when won, yellow when the solver could not win.
    return st.won ? { cls: 'badge-success', label: 'Done' } : { cls: 'badge-warning', label: 'Failed' };
  }
  if (st.state === 'running') {
    return { cls: 'badge-info', label: 'running' };
  }
  if (st.state === 'queued') {
    return { cls: 'badge-soft', label: 'queued' };
  }
  return { cls: 'badge-error', label: 'failed' };
}

const solving = ref(false);

// Controls are inert while solving or while the puzzle list is unavailable.
const controlsDisabled = computed(() => solving.value || puzzlesLoading.value || puzzlesError.value !== null);
const toast = ref<string | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast(message: string) {
  toast.value = message;
  if (toastTimer) {
    clearTimeout(toastTimer);
  }
  toastTimer = setTimeout(() => {
    toast.value = null;
    toastTimer = null;
  }, 6000);
}
const results = ref<Record<number, { meta: PuzzleMeta; partArray: Array<number | null>; wins: number; isStrictWin: boolean; }>>({});

// Most recent day first, so solves start with the latest puzzle.
const selectedDays = computed(() => [ ...selected.value ].sort((a, b) => b - a));
const totalSelected = computed(() => selectedDays.value.length);
// Days of the current solve run — stable even though won days get
// deselected (and thus leave selectedDays) while the run is in flight.
const solveRunDays = ref<number[]>([]);
const finishedInRun = computed(() => solveRunDays.value.filter((d) => statuses[ d ]?.state === 'done' || statuses[ d ]?.state === 'failed').length);

const solveDialog = ref<HTMLDialogElement | null>(null);

// Solving many days at once is heavy: ask first, then solve.
function onSolveClick() {
  if (totalSelected.value > 10) {
    solveDialog.value?.showModal();
  } else {
    solveSelected();
  }
}

// ---------------------------------------------------------------------------
// Result rendering (SVGs)
// ---------------------------------------------------------------------------
interface RenderedDay {
  partArray: Array<number | null> | null; // result version this SVG was built from
  bestSvg: string;
  solvedSvg: string | null;
  bestFileSvg: string; // CLI-identical SVG for download
  solvedFileSvg: string | null;
  bestFileName: string;
  solvedFileName: string | null;
  playerName: string;
  bestScored: ReturnType<typeof scorePartition>;
  solvedScored: ReturnType<typeof scorePartition> | null;
}

const rendered = reactive<Record<number, RenderedDay>>({});

// Per-day expand/collapse state of the result cards.
const openResults = reactive(new Set<number>());
// Remember the last Expand/Collapse-all action; new results follow it.
const defaultOpen = ref(true);

// ---------------------------------------------------------------------------
// Won-solve persistence (localStorage)
// ---------------------------------------------------------------------------
// Only strict wins are stored — their status (Done) and solution survive
// reloads so the list can mark them solved and re-render the result.
const SOLVED_KEY = 'gerry-solved';

interface StoredSolve {
  partArray: Array<number | null>;
  wins: number;
}

const solvedStore = reactive<Record<number, StoredSolve>>({});

function saveSolves() {
  try {
    localStorage.setItem(SOLVED_KEY, JSON.stringify(solvedStore));
  } catch {
    // Storage unavailable (private mode, quota): wins just aren't persisted.
  }
}

function loadSolves(): Record<number, StoredSolve> {
  try {
    const raw = localStorage.getItem(SOLVED_KEY);
    if (!raw) {
      return {};
    }
    const out: Record<number, StoredSolve> = {};
    // Tolerate a stale/corrupt entry (old shape, hand-edited value) instead
    // of crashing the page; invalid days are skipped.
    for (const [ key, value ] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
      const day = Number(key);
      const entry = value as StoredSolve | null;
      if (Number.isInteger(day) && day > 0 && Array.isArray(entry?.partArray) && Number.isInteger(entry?.wins)) {
        out[ day ] = { partArray: entry.partArray, wins: entry.wins };
      }
    }
    return out;
  } catch {
    return {};
  }
}

// Replay stored wins onto the (re)loaded puzzle list: mark the day as
// solved, restore its result entry so the solution SVG renders, and
// deselect it exactly like a fresh solve does.
function restoreSolved() {
  for (const [ dayStr, stored ] of Object.entries(loadSolves())) {
    const day = Number(dayStr);
    const meta = puzzles.value.find((p) => p.day === day);
    if (!meta) {
      continue;
    }
    statuses[ day ] = { state: 'done', dots: 0, won: true };
    results.value[ day ] = { meta, partArray: stored.partArray, wins: stored.wins, isStrictWin: true };
    selected.value.delete(day);
    solvedStore[ day ] = stored;
    if (defaultOpen.value) {
      openResults.add(day);
    }
  }
}

async function solveSelected() {
  const days = selectedDays.value;
  if (days.length === 0 || solving.value) {
    return;
  }
  solving.value = true;
  solveRunDays.value = days;
  // Reset only the days being solved; already-processed days that are not
  // selected for this run keep their statuses and results untouched.
  for (const d of days) {
    statuses[ d ] = { state: 'queued', dots: 0 };
  }

  // Keep the total worker count reasonable: attempts × days in flight.
  const concurrency = Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 8) / ATTEMPTS_PER_DAY)));
  let next = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (next < days.length) {
      const day = days[ next++ ];
      const meta = puzzles.value.find((p) => p.day === day);
      if (!meta) {
        continue;
      }
      statuses[ day ] = { state: 'running', dots: 0 };
      try {
        const result = await runSolve(
          // toRaw: the ref stores payloads as reactive proxies, which
          // structuredClone (worker postMessage) refuses to serialize.
          { payload: toRaw(meta.payload), timeLimitMs: TIME_LIMIT_MS },
          ATTEMPTS_PER_DAY,
          () => { statuses[ day ].dots++; },
        );
        if (result.partArray) {
          results.value[ day ] = { meta, partArray: result.partArray, wins: result.wins, isStrictWin: result.isStrictWin };
          statuses[ day ] = { state: 'done', dots: 0, won: result.isStrictWin };
          if (defaultOpen.value) {
            openResults.add(day);
          } else {
            openResults.delete(day);
          }
          // A won puzzle is deselected so a new Solve click does not
          // re-solve it; tied/lost days stay selected for retry.
          if (result.isStrictWin) {
            selected.value.delete(day);
            // Remember the win (status + solution) so it survives reloads.
            solvedStore[ day ] = { partArray: result.partArray, wins: result.wins };
            saveSolves();
          }
        } else {
          statuses[ day ] = { state: 'failed', dots: 0, error: 'No solution found' };
        }
      } catch (err) {
        statuses[ day ] = { state: 'failed', dots: 0, error: err instanceof Error ? err.message : String(err) };
      }
    }
  });
  await Promise.all(workers);
  solving.value = false;
  const done = solveRunDays.value.filter((d) => statuses[ d ]?.state === 'done').length;
  const failed = solveRunDays.value.length - done;
  showToast(failed === 0 ? `Solved all ${ done } day${ done === 1 ? '' : 's' }.` : `Solved ${ done } of ${ solveRunDays.value.length } day${ solveRunDays.value.length === 1 ? '' : 's' }.`);
}

function renderDay(day: number) {
  const entry = results.value[ day ];
  if (!entry) {
    return;
  }
  // Already rendered for this exact result. A re-solve stores a NEW
  // partArray, so the version check re-renders when the new result lands.
  if (rendered[ day ] && rendered[ day ].partArray === entry.partArray) {
    return;
  }
  // number/date feed the CLI-style header ("Day 083 (2026-08-01) ...") that
  // renderSVG emits when a title is given; extract() defaults them to 0/''.
  const puzzle = extract({ payload: entry.meta.payload, number: entry.meta.day, date: entry.meta.date });
  const playerName = partyName(puzzle.playerParty, puzzle);
  const bestScored = scorePartition(puzzle.optimumPartition, puzzle);
  const solvedScored = entry.partArray ? scorePartition(entry.partArray, puzzle) : null;
  rendered[ day ] = {
    partArray: entry.partArray,
    // No SVG title: the result card summary already shows day/date.
    // Web mode: transparent background + currentColor so the SVGs follow
    // the page theme (light and dark).
    bestSvg: renderSVG(puzzle, puzzle.optimumPartition, null, bestScored, { web: true }),
    solvedSvg: solvedScored
      ? renderSVG(puzzle, entry.partArray, null, solvedScored, { web: true })
      : null,
    // Download versions replicate the CLI output byte-for-byte: same title,
    // scored summary, and explicit (non-web) colors.
    bestFileSvg: renderSVG(
      puzzle,
      puzzle.optimumPartition,
      `Day ${ day } - best: ${ playerName } ${ bestScored.wins }/${ puzzle.regionCount }`,
      bestScored,
    ),
    solvedFileSvg: solvedScored
      ? renderSVG(
        puzzle,
        entry.partArray,
        `Day ${ day } - solv: ${ playerName } ${ solvedScored.wins }/${ puzzle.regionCount }`,
        solvedScored,
      )
      : null,
    // Same naming schema as the CLI:
    // solutions/<date>_<day>_best|solv_<wins>_<districts>.svg
    bestFileName: `${ fileStem(entry.meta.date, day, bestScored.wins, puzzle.regionCount, 'best') }.svg`,
    solvedFileName: solvedScored
      ? `${ fileStem(entry.meta.date, day, solvedScored.wins, puzzle.regionCount, 'solv') }.svg`
      : null,
    playerName,
    bestScored,
    solvedScored,
  };
}

// All processed days, most recent first (a won day is deselected but its
// result stays visible).
const solvedDays = computed(() => Object.keys(results.value).map(Number).sort((a, b) => b - a));

function setAllResults(open: boolean) {
  defaultOpen.value = open;
  if (open) {
    for (const d of solvedDays.value) {
      openResults.add(d);
    }
  } else {
    openResults.clear();
  }
}

function onResultToggle(day: number, e: Event) {
  const details = e.currentTarget as HTMLDetailsElement;
  if (details.open) {
    openResults.add(day);
  } else {
    openResults.delete(day);
  }
}

// Save an SVG as a file download, byte-for-byte the same string the CLI
// writes into solutions/.
function downloadSvg(fileName: string, svg: string) {
  const blob = new Blob([ svg ], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadSolvedSvg(day: number) {
  const r = rendered[ day ];
  if (r?.solvedFileName && r.solvedFileSvg) {
    downloadSvg(r.solvedFileName, r.solvedFileSvg);
  }
}

// ---------------------------------------------------------------------------
// Per-day summary info (districts, district size, target player color)
// ---------------------------------------------------------------------------
interface DayInfo {
  playerName: string;
  regionCount: number;
  housesPerDistrict: number;
  playerColor: string;
}

const dayInfoCache = new Map<number, DayInfo>();

function dayInfo(day: number): DayInfo | null {
  const entry = results.value[ day ];
  if (!entry) {
    return null;
  }
  let info = dayInfoCache.get(day);
  if (!info) {
    const puzzle = extract({ payload: entry.meta.payload });
    info = {
      playerName: partyName(puzzle.playerParty, puzzle),
      regionCount: puzzle.regionCount,
      housesPerDistrict: puzzle.housesPerDistrict,
      playerColor: PALETTE[ puzzle.partyColours[ puzzle.playerParty ] ]?.fill ?? '#64748b',
    };
    dayInfoCache.set(day, info);
  }
  return info;
}
</script>

<template>
  <div class="navbar bg-base-100 sticky top-0 z-10 shadow-sm">
    <div class="flex-1 text-xl mx-2">
      Gerrymandle Solver
    </div>
    <div class="flex-none mx-2">
      <label class="select select-sm">
        <span class="label hidden sm:flex">Theme</span>
        <select v-model="theme" class=" min-w-22">
          <option value="light">Light</option>
          <option value="dark">Dark</option>
          <option value="system">System</option>
        </select>
      </label>
    </div>
  </div>

  <section class="hero bg-base-200 py-10">
    <div class="hero-content text-center">
      <div class="max-w-xl">
        <h1 class="text-4xl font-bold">
          Gerrymandle Solver
        </h1>
        <p class="py-4 text-base-content/80">
          Solve the daily
          <a class="link link-hover" href="https://gerrymandle.com" target="_blank" rel="noopener">gerrymandle.com</a>
          puzzle: pick the days you missed, and the solver finds a winning district map right in your browser.
        </p>
      </div>
    </div>
  </section>

  <main class="mx-auto max-w-6xl p-4 flex-1 w-full">
    <!-- Controls -->
    <div class="card bg-base-content/4 shadow-sm">
      <div class="card-body">
        <div class="flex flex-wrap items-end gap-4">
          <div class="flex-1 basis-64">
            <label class="label mb-2" for="puzzle-filter">
              Filter puzzles
              <kbd class="kbd kbd-sm">/</kbd>
            </label>
            <input
              id="puzzle-filter"
              v-model="filter"
              type="search"
              placeholder="Day number or date, e.g. 26 or 2026-06-05"
              class="input input-sm w-full"
              :disabled="controlsDisabled"
            />
          </div>
          <div class="flex flex-wrap gap-2">
            <div class="join gap-0.5">
              <button
                class="join-item btn btn-sm"
                type="button"
                :disabled="controlsDisabled || filteredPuzzles.length === 0"
                @click="selectAllFiltered"
              >
                Select all ({{ filteredPuzzles.length }})
              </button>
              <button
                class="join-item btn btn-sm"
                type="button"
                :disabled="controlsDisabled"
                @click="deselectAllFiltered"
              >
                Deselect all
              </button>
              <button
                class="join-item btn btn-sm"
                type="button"
                popovertarget="selection-menu"
                style="anchor-name:--selection-menu"
                :disabled="controlsDisabled || filteredPuzzles.length === 0"
              >
                More
              </button>
            </div>
            <ul
              id="selection-menu"
              class="dropdown dropdown-end menu bg-base-200 rounded-box p-2 mt-1 shadow-sm"
              popover
              style="position-anchor:--selection-menu"
            >
              <li>
                <button type="button" :disabled="solving" @click="selectUnsolvedFiltered">
                  Select unsolved
                </button>
              </li>
              <li>
                <button type="button" :disabled="solving" @click="invertSelection">
                  Invert selection
                </button>
              </li>
              <li>
                <button type="button" :disabled="solving" @click="deselectAllFiltered">
                  Clear selection
                </button>
              </li>
            </ul>
            <div class="tooltip tooltip-top tooltip-end" data-tip="Solves each selected day in your browser (parallel attempts)">
              <button
                class="btn btn-sm btn-primary min-w-30"
                type="button"
                :disabled="controlsDisabled || totalSelected === 0"
                @click="onSolveClick"
              >
                <span v-if="solving" class="loading loading-spinner loading-sm" />
                {{ solving ? 'Solving…' : `Solve (${ totalSelected })` }}
              </button>
            </div>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2 text-sm text-base-content/70">
          <span>{{ filteredPuzzles.length }} of {{ puzzles.length }} days shown</span>
          <span aria-hidden="true">·</span>
          <span>{{ totalSelected }} selected</span>
          <template v-if="solving">
            <span aria-hidden="true">·</span>
            <span class="flex items-center gap-1">
              <span class="loading loading-spinner loading-xs" />
              {{ finishedInRun }}/{{ solveRunDays.length }} done
            </span>
            <progress class="progress progress-info w-32" :value="finishedInRun" :max="solveRunDays.length" :aria-label="`${ finishedInRun } out of ${ solveRunDays.length } done`" />
          </template>
        </div>
      </div>
    </div>

    <!-- Puzzle list -->
    <div class="card bg-base-content/4 mt-4 shadow-sm">
      <div class="card-body">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h2 class="card-title">
            Days
          </h2>
          <span id="list-view-label" class="sr-only">List view</span>
          <form id="list-view-filter" class="join gap-0.5" aria-labelledby="list-view-label">
            <input
              v-model="listView"
              type="radio"
              name="list-view"
              class="join-item btn btn-sm"
              value="all"
              aria-label="All"
            />
            <input
              v-model="listView"
              type="radio"
              name="list-view"
              class="join-item btn btn-sm"
              value="selected"
              aria-label="Selected"
            />
            <input
              v-model="listView"
              type="radio"
              name="list-view"
              class="join-item btn btn-sm"
              value="solved"
              aria-label="Solved"
            />
          </form>
        </div>

        <div v-if="puzzlesLoading" class="flex flex-col gap-2" aria-label="Loading puzzles">
          <div class="skeleton h-9 w-full" />
          <div class="skeleton h-9 w-full" />
          <div class="skeleton h-9 w-full" />
          <div class="skeleton h-9 w-full" />
        </div>

        <div v-else-if="puzzlesError" role="alert" class="alert alert-error">
          <span class="grow">
            Could not load the puzzle list: {{ puzzlesError }}
          </span>
          <button
            class="btn btn-sm"
            type="button"
            :disabled="solving"
            @click="reloadPuzzles"
          >
            Retry
          </button>
        </div>

        <template v-else>
          <p v-if="visiblePuzzles.length === 0" class="text-sm text-base-content/70">
            {{ emptyListMessage }}
          </p>
          <ul v-else class="list gap-1 sm:grid sm:grid-cols-2 lg:grid-cols-3">
            <li v-for="p in pagedPuzzles" :key="p.day" class="list-row">
              <label class="label flex list-col-grow gap-3 rounded-box px-2 py-1.5 hover:bg-base-content/8">
                <input
                  v-model="selected"
                  type="checkbox"
                  class="checkbox checkbox-sm"
                  :value="p.day"
                  :disabled="solving"
                />
                <span class="grow tabular-nums">
                  {{ p.date }} · Day {{ p.day }}
                </span>
                <span
                  v-if="statuses[p.day]"
                  class="badge badge-sm self-end"
                  :class="statusBadge(statuses[p.day]).cls"
                >
                  {{ statusBadge(statuses[p.day]).label }}
                  <template v-if="statuses[p.day].state === 'running' && statuses[p.day].dots > 0">
                    · {{ statuses[p.day].dots }}
                  </template>
                </span>
              </label>
            </li>
            <li />
          </ul>

          <div v-if="pageCount > 1" class="join gap-0.5 mt-3 justify-center">
            <button
              class="join-item btn btn-sm"
              type="button"
              :disabled="page === 1"
              aria-label="Previous page"
              @click="page--"
            >
              «
            </button>
            <button
              v-for="n in pageNumbers"
              :key="n"
              class="join-item btn btn-sm"
              :class="{ 'btn-active': n === page }"
              type="button"
              :aria-label="`Page ${ n }`"
              @click="page = n"
            >
              {{ n }}
            </button>
            <button
              class="join-item btn btn-sm"
              type="button"
              :disabled="page === pageCount"
              aria-label="Next page"
              @click="page++"
            >
              »
            </button>
          </div>
        </template>
      </div>
    </div>

    <!-- Results -->
    <section v-if="solvedDays.length > 0 || Object.keys(rendered).length > 0" class="card bg-base-content/4 shadow-sm mt-4">
      <div class="card-body px-2">
        <h2 class="card-title px-4">
          <span>Results</span>
          <div class="ms-auto flex gap-2">
            <button class="btn btn-sm" :disabled="solvedDays.length === 0" @click="setAllResults(true)">
              Expand all
            </button>
            <button class="btn btn-sm" :disabled="solvedDays.length === 0" @click="setAllResults(false)">
              Collapse all
            </button>
          </div>
        </h2>

        <div class="flex flex-col gap-4">
          <details
            v-for="day in solvedDays"
            :key="day"
            class="collapse collapse-arrow bg-base-content/4 shadow-sm"
            :open="openResults.has(day)"
            @toggle="onResultToggle(day, $event)"
          >
            <summary class="collapse-title">
              <span class="card-title text-sm flex-wrap">
                Day {{ day }}
                <span class="ml-1 text-sm font-normal text-base-content/60">{{ results[day]?.meta.date }}</span>
                <template v-if="dayInfo(day)">
                  ·
                  <span class="text-sm font-normal text-base-content/60">
                    {{ dayInfo(day)?.regionCount }} districts
                  </span>
                  ·
                  <span class="text-sm font-normal text-base-content/60">
                    {{ dayInfo(day)?.housesPerDistrict }} tiles/district
                  </span>
                  ·
                  <span class="font-bold uppercase" :style="{ color: dayInfo(day)?.playerColor }">
                    {{ dayInfo(day)?.playerName }}
                  </span>
                </template>
                <span
                  v-if="results[day]"
                  class="badge badge-sm text-nowrap"
                  :class="results[day].isStrictWin ? 'badge-success' : 'badge-warning'"
                >
                  {{ results[day].isStrictWin ? 'WINS' : 'tie/lost' }} · {{ results[day].wins }} districts
                </span>
              </span>
            </summary>
            <div class="collapse-content" @vue:mounted="renderDay(day)" @vue:updated="renderDay(day)">
              <div v-if="rendered[day]" class="grid grid-cols-1 gap-2 md:grid-cols-2">
                <figure class="flex flex-col rounded-box bg-base-content/4">
                  <figcaption class="font-bold mt-2 flex items-center justify-between gap-2 px-2">
                    <span>Site solution ({{ rendered[day].bestScored.wins }} wins)</span>
                    <button
                      type="button"
                      class="btn btn-xs"
                      :aria-label="`Download day ${ day } site solution SVG`"
                      @click="downloadSvg(rendered[day].bestFileName, rendered[day].bestFileSvg)"
                    >
                      Download SVG
                    </button>
                  </figcaption>
                  <div class="overflow-x-auto w-full" v-html="rendered[day].bestSvg" />
                </figure>

                <figure class="flex flex-col rounded-box bg-base-content/4">
                  <figcaption class="font-bold mt-2 flex items-center justify-between gap-2 px-2">
                    <span>Solved ({{ rendered[day].solvedScored?.wins ?? 0 }} wins)</span>
                    <button
                      v-if="rendered[day].solvedFileName"
                      type="button"
                      class="btn btn-xs"
                      :aria-label="`Download day ${ day } solution SVG`"
                      @click="downloadSolvedSvg(day)"
                    >
                      Download SVG
                    </button>
                  </figcaption>
                  <div v-if="rendered[day].solvedSvg" class="overflow-x-auto w-full" v-html="rendered[day].solvedSvg" />
                  <p v-else class="text-sm text-base-content/70">
                    No solution found.
                  </p>
                </figure>
              </div>
            </div>
          </details>
        </div>
      </div>
    </section>

    <p v-if="!solving && totalSelected === 0" class="mt-4 text-sm text-base-content/70">
      Select one or more days above, then press Solve. The solver runs in your browser.
    </p>
  </main>

  <footer class="footer footer-center bg-base-200 p-4">
    <aside>
      <p>
        Runs entirely in your browser — no server. Puzzles from
        <a class="link link-hover" href="https://gerrymandle.com" target="_blank" rel="noopener">gerrymandle.com</a>.
      </p>
    </aside>
  </footer>

  <dialog ref="solveDialog" class="modal">
    <div class="modal-box">
      <h3 class="text-lg font-bold">
        Solve {{ totalSelected }} days?
      </h3>
      <p class="py-4">
        Each day races four solver attempts in parallel workers; hard puzzles can take up to
        about half a minute each. Your browser stays responsive, but this many runs will keep
        several cores busy.
      </p>
      <div class="modal-action">
        <form method="dialog">
          <button class="btn btn-sm" type="submit">
            Cancel
          </button>
        </form>
        <form method="dialog" @submit="solveSelected">
          <button class="btn btn-sm btn-primary" type="submit">
            Solve
          </button>
        </form>
      </div>
    </div>
    <form method="dialog" class="modal-backdrop">
      <button type="submit">close</button>
    </form>
  </dialog>

  <div v-if="toast" class="toast toast-end toast-bottom" role="status">
    <div class="alert alert-success">
      <span>{{ toast }}</span>
    </div>
  </div>
</template>
