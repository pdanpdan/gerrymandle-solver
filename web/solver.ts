import type { SolveRequest, SolveResult, WorkerMessage } from './solver-worker';

function runSolveOnce(req: SolveRequest, onDot: () => void, workers: Worker[]): Promise<SolveResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./solver-worker.ts', import.meta.url), { type: 'module' });
    workers.push(worker);
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

// Run one puzzle with several parallel solver attempts. Attempts use the
// CLI-proven seed sequence 1..N (the constructive phase also draws fresh
// randomness each attempt, so one of them usually lands a strict win fast).
// Resolves with the first strict win — terminating the losing workers — or
// with the best result when no attempt wins.
export async function runSolve(req: SolveRequest, attempts: number, onDot: () => void): Promise<SolveResult> {
  return await new Promise((resolve, reject) => {
    const workers: Worker[] = [];
    const results: SolveResult[] = [];
    let settled = 0;
    let done = false;

    const finish = (result?: SolveResult) => {
      if (done) {
        return;
      }
      done = true;
      for (const w of workers) {
        w.terminate();
      }
      if (result) {
        resolve(result);
      } else {
        reject(new Error('all solver attempts failed'));
      }
    };

    for (let i = 0; i < attempts; i++) {
      runSolveOnce({ ...req, seed: i + 1 }, onDot, workers)
        .then((r) => {
          if (r.isStrictWin && r.wins > 0) {
            finish(r);
            return;
          }
          results.push(r);
          if (++settled === attempts) {
            finish(results.reduce((best, x) => (x.wins > best.wins ? x : best)));
          }
        })
        .catch(() => {
          if (++settled === attempts) {
            finish(results.length > 0
              ? results.reduce((best, x) => (x.wins > best.wins ? x : best))
              : undefined);
          }
        });
    }
  });
}
