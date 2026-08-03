import type { SolveRequest, SolveResult, WorkerMessage } from './solver-worker';

function runSolveOnce(req: SolveRequest, onDot: () => void): Promise<SolveResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./solver-worker.ts', import.meta.url), { type: 'module' });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('solver worker timed out'));
    }, req.timeLimitMs + 30000);

    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const msg = e.data;
      if (msg.type === 'dot') {
        onDot();
        return;
      }
      clearTimeout(timer);
      worker.terminate();
      resolve(msg.result);
    };
    worker.onerror = (err) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(err.message));
    };
    worker.postMessage(req);
  });
}

// Run one puzzle with several parallel solver attempts (different seeds —
// the constructive phase draws fresh randomness each attempt, so one of them
// usually lands a strict win fast). Resolves with the first strict win, or
// the best result if no attempt wins; every losing worker is terminated.
export async function runSolve(req: SolveRequest, attempts: number, onDot: () => void): Promise<SolveResult> {
  const jobs = Array.from({ length: attempts }, (_, i) =>
    runSolveOnce({ ...req, seed: req.seed + i * 97 }, onDot));
  const results = await Promise.allSettled(jobs);
  const settled = results
    .filter((r): r is PromiseFulfilledResult<SolveResult> => r.status === 'fulfilled')
    .map((r) => r.value);
  if (settled.length === 0) {
    const first = results.find((r) => r.status === 'rejected');
    throw new Error((first as PromiseRejectedResult).reason?.message ?? 'all solver attempts failed');
  }
  return settled.find((r) => r.isStrictWin && r.wins > 0) ?? settled.reduce((best, r) => (r.wins > best.wins ? r : best));
}
