// Multi-process orchestrator for the burst / staggered TTI benchmarks.
//
// Forks N worker processes (tti-worker.ts), each running its share of
// `concurrency` through the full create → exec → exec → destroy lifecycle, so
// one job saturates all cores instead of one event loop. Workers report their
// TimingResult[] over IPC; this orchestrator merges them into ONE result of the
// standard ConcurrentBenchmarkResult / StaggeredBenchmarkResult shape, so the
// table printer, scoring, and JSON writers are untouched.
//
// Why processes (child_process.fork), not threads: each fork is a fresh
// `node --import tsx` process (execArgv inherited), giving every worker its own
// event loop, V8 heap, HTTP/WS connections, and core — which is the whole point
// for an exec-holding workload.
//
// Staggered cadence: running W workers each at `staggerDelayMs` would make the
// real ramp W× faster — a different test. So each worker uses an internal
// cadence of `staggerDelayMs × W` and starts at offset `i × staggerDelayMs`,
// interleaving to a global one-per-`staggerDelayMs` ramp.

import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeStats } from '../util/stats.js';
import type {
  ProviderConfig,
  TimingResult,
  ConcurrentBenchmarkResult,
  StaggeredBenchmarkResult,
} from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.resolve(__dirname, 'tti-worker.ts');

type RampPoint = { launchedAt: number; readyAt: number; ttiMs: number };

interface WorkerResult {
  iterations: TimingResult[];
  wallClockMs: number;
  timeToFirstReadyMs: number;
  rampProfile?: RampPoint[];
}

function splitEvenly(total: number, n: number): number[] {
  const base = Math.floor(total / n);
  const rem = total % n;
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
}

function spawnWorker(env: Record<string, string>): Promise<WorkerResult | null> {
  return new Promise(resolve => {
    const child = fork(WORKER_PATH, [], {
      // execArgv defaults to process.execArgv → inherits `--import tsx`.
      env: { ...process.env, ...env },
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    });
    let message: WorkerResult | null = null;
    child.on('message', m => {
      message = m as WorkerResult;
    });
    child.on('exit', code => {
      if (!message) console.warn(`[tti-cluster] worker ${env.CT_WORKER_ID} exited (code ${code}) with no result`);
      resolve(message);
    });
    child.on('error', err => {
      console.warn(`[tti-cluster] worker ${env.CT_WORKER_ID} error: ${err.message}`);
      resolve(message);
    });
  });
}

interface ClusterOpts {
  concurrency: number;
  staggerDelayMs: number;
  workers: number;
}

export async function runClusteredBenchmark(
  mode: 'burst' | 'staggered',
  providerConfig: ProviderConfig,
  opts: ClusterOpts,
): Promise<ConcurrentBenchmarkResult | StaggeredBenchmarkResult> {
  const { name, requiredEnvVars } = providerConfig;
  const { concurrency, staggerDelayMs, workers } = opts;

  // Same credential gate as the single-process functions → emit a skipped result.
  const missingVars = requiredEnvVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    const base = {
      provider: name,
      concurrency,
      iterations: [] as TimingResult[],
      summary: { ttiMs: { median: 0, p95: 0, p99: 0 } },
      wallClockMs: 0,
      timeToFirstReadyMs: 0,
      skipped: true,
      skipReason: `Missing: ${missingVars.join(', ')}`,
    };
    return mode === 'staggered'
      ? { ...base, mode: 'staggered', staggerDelayMs, rampProfile: [] }
      : { ...base, mode: 'concurrent' };
  }

  const shares = splitEvenly(concurrency, workers);
  const label = mode === 'staggered' ? 'Staggered' : 'Concurrent';
  const suffix = mode === 'staggered' ? `, ${staggerDelayMs}ms apart` : '';
  console.log(`\n--- ${label} Benchmark: ${name} (${concurrency} sandboxes${suffix}) across ${workers} workers ---`);
  console.log(`  Per-worker concurrency: ${shares.join(', ')}`);

  const runNonce = randomUUID();
  const wallStart = performance.now();

  const partials = await Promise.all(
    shares.map((share, i) => {
      const env: Record<string, string> = {
        CT_MODE: mode === 'staggered' ? 'staggered' : 'burst',
        CT_PROVIDER: name,
        CT_CONCURRENCY: String(share),
        CT_WORKER_ID: String(i),
        CT_RUN_NONCE: runNonce,
      };
      if (mode === 'staggered') {
        // Interleave: internal cadence × workers, start offset = i × original.
        env.CT_STAGGER_MS = String(staggerDelayMs * workers);
        env.CT_START_OFFSET_MS = String(i * staggerDelayMs);
      }
      return spawnWorker(env);
    }),
  );
  const orchestratorWallMs = performance.now() - wallStart;

  const ok = partials.filter((p): p is WorkerResult => p !== null);
  if (ok.length < workers) {
    console.warn(`[tti-cluster] only ${ok.length}/${workers} workers returned results`);
  }

  // Merge: iterations concatenate, stats recompute over all successes.
  const iterations = ok.flatMap(p => p.iterations);
  const successful = iterations.filter(r => !r.error);
  const successfulTimes = successful.map(r => r.ttiMs);
  const timeToFirstReadyMs = successful.length > 0 ? Math.min(...successfulTimes) : 0;
  // Wall clock = slowest worker's first-launch-to-last-ready (excludes fork
  // overhead; the staggered worker with the largest offset finishes last).
  const wallClockMs = ok.length > 0 ? Math.max(...ok.map(p => p.wallClockMs)) : orchestratorWallMs;
  const summary = {
    ttiMs: successful.length > 0 ? computeStats(successfulTimes) : { median: 0, p95: 0, p99: 0 },
  };

  console.log(`  Wall clock: ${(wallClockMs / 1000).toFixed(2)}s | First ready: ${(timeToFirstReadyMs / 1000).toFixed(2)}s | Success: ${successful.length}/${concurrency}`);

  if (mode === 'staggered') {
    const rampProfile = ok
      .flatMap(p => p.rampProfile ?? [])
      .sort((a, b) => a.launchedAt - b.launchedAt);
    return {
      provider: name,
      mode: 'staggered',
      concurrency,
      staggerDelayMs,
      iterations,
      summary,
      wallClockMs,
      timeToFirstReadyMs,
      rampProfile,
    };
  }

  return {
    provider: name,
    mode: 'concurrent',
    concurrency,
    iterations,
    summary,
    wallClockMs,
    timeToFirstReadyMs,
  };
}
