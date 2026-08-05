# Gerrymandle Solver

Solves the daily puzzles from [gerrymandle.com](https://gerrymandle.com): given
the day's hex board, find a district map that wins the election for the target
party. Available as a Node CLI and as a static web app that runs the solver
entirely in your browser.

## How it works

The solver combines several search strategies:

- **Constructive phase** — grows anchored player-winning districts into seeds,
  then climbs toward balanced partitions with a transfer-based site-style
  solver.
- **ReCom phase** — proposes new partitions by cutting and recombining spanning
  trees of merged districts.
- **Simulated annealing** — a deviation-aware annealed search drives the
  partition toward a strict election win, with a best-effort fallback when a
  win is spatially impossible (e.g. the opponent holds a forced majority).

Each solve races several attempts with fresh randomness against a time budget;
the first strict win is returned and the losing attempts are discarded.

## Web app

The web UI (Vike + Vue, daisyUI, Tailwind) is prerendered as a single static
page and deployed to GitHub Pages:

- pick the days you missed, press **Solve**, and compare the site's solution
  with the solver's map side by side
- won days are stored in localStorage: they stay marked as solved and their solution is re-rendered when you come back
- each solution SVG can be downloaded in the exact format the CLI writes (same bytes and `<date>_<day>_best|solv_<wins>_<districts>.svg` naming)
- light/dark/system themes
- runs entirely client-side in Web Workers — no server

Puzzle data is fetched from the gerrymandle.com API at build time into
`dist/client/puzzles.json` (the API sends no CORS headers, so the browser
cannot fetch it directly), and a scheduled GitHub Actions job rebuilds and
redeploys every two hours so new daily puzzles appear automatically.

## CLI

```sh
pnpm install
pnpm solver -- [--time MINUTES] [--best] <puzzle-url>
```

For example:

```sh
pnpm solver -- --time 1 https://gerrymandle.com/?date=2026-06-09
```

Writes `solutions/<date>_<day>_best_<wins>_<districts>.svg` (the site's optimum)
and `..._solv_...svg` (the solver's strict win) next to the repository.

Options:

| Flag | Meaning |
|---|---|
| `--time MINUTES` | time budget per puzzle batch (default 2 minutes) |
| `--best` | chase the theoretical maximum number of winning districts |
| `--debug` | verbose solver output |
| `--all` | solve every published puzzle |

## Development

```sh
pnpm dev        # Vike dev server (proxies /api to gerrymandle.com)
pnpm build      # production build + puzzles.json fetch
pnpm preview    # serve the built site
pnpm lint       # ESLint (antfu config, all files)
pnpm typecheck  # vue-tsc --noEmit
```

## Project layout

```
solver/    shared solver engine (hex utils, constructive/site-style/ReCom solvers, CLI)
web/       browser-side code (puzzle loader, Web Worker solver, theme mapping)
pages/     Vike app (config, layout, head, the single page)
scripts/   build-time puzzle fetch
public/    pre-paint theme script
```

## License

[MIT](LICENSE)
