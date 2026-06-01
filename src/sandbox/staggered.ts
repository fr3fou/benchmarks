import type { ProviderConfig, TimingResult, StaggeredBenchmarkResult } from './types.js';
import { runIteration } from './benchmark.js';
import { computeStats } from '../util/stats.js';
import { randomUUID } from 'node:crypto';

interface StaggeredConfig extends ProviderConfig {
  concurrency: number;
  staggerDelayMs: number;
  /** Delay before this worker's first launch — used to interleave workers so
   *  the GLOBAL launch cadence stays one-per-(staggerDelayMs/workers). */
  startOffsetMs?: number;
  /** Shared across worker processes so reuse markers stay consistent. */
  runNonce?: string;
  /** Prefix for per-sandbox log lines (e.g. "[w0] ") when run under workers. */
  logPrefix?: string;
}

export async function runStaggeredBenchmark(config: StaggeredConfig): Promise<StaggeredBenchmarkResult> {
  const { name, concurrency, staggerDelayMs, timeout = 120_000, requiredEnvVars, sandboxOptions, destroyTimeoutMs, startOffsetMs = 0, logPrefix = '' } = config;

  // Check if all required credentials are available
  const missingVars = requiredEnvVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    return {
      provider: name,
      mode: 'staggered',
      concurrency,
      staggerDelayMs,
      iterations: [],
      summary: { ttiMs: { median: 0, p95: 0, p99: 0 } },
      wallClockMs: 0,
      timeToFirstReadyMs: 0,
      rampProfile: [],
      skipped: true,
      skipReason: `Missing: ${missingVars.join(', ')}`,
    };
  }

  const compute = config.createCompute();
  console.log(`\n--- Staggered Benchmark: ${name} (${concurrency} sandboxes, ${staggerDelayMs}ms apart) ---`);

  const wallStart = performance.now();
  const reuseDetector = {
    runNonce: config.runNonce ?? randomUUID(),
    seenSignals: new Map<string, Set<string>>(),
  };
  const promises: Promise<TimingResult>[] = [];
  const rampProfile: { launchedAt: number; readyAt: number; ttiMs: number }[] = [];

  // Interleave offset: stagger this worker's ramp so launchedAt values are
  // global (relative to the shared ~T0 fork instant), not worker-local.
  if (startOffsetMs > 0) {
    await new Promise(resolve => setTimeout(resolve, startOffsetMs));
  }

  for (let i = 0; i < concurrency; i++) {
    const launchedAt = performance.now() - wallStart;

    const p = runIteration(compute, timeout, sandboxOptions, destroyTimeoutMs, reuseDetector)
      .then(result => {
        const readyAt = performance.now() - wallStart;
        rampProfile.push({ launchedAt, readyAt, ttiMs: result.ttiMs });
        console.log(`${logPrefix}  Sandbox ${i + 1}/${concurrency}: TTI ${(result.ttiMs / 1000).toFixed(2)}s (launched at +${(launchedAt / 1000).toFixed(2)}s)`);
        return result;
      })
      .catch(err => {
        const error = err instanceof Error ? err.message : String(err);
        console.log(`${logPrefix}  Sandbox ${i + 1}/${concurrency}: FAILED — ${error}`);
        return { ttiMs: 0, error } as TimingResult;
      });

    promises.push(p);

    // Wait before launching next (except after the last one)
    if (i < concurrency - 1) {
      await new Promise(resolve => setTimeout(resolve, staggerDelayMs));
    }
  }

  const results = await Promise.all(promises);
  const wallClockMs = performance.now() - wallStart;

  const successful = results.filter(r => !r.error);

  const successfulTimes = successful.map(r => r.ttiMs);
  const timeToFirstReadyMs = successful.length > 0 ? Math.min(...successfulTimes) : 0;

  console.log(`  Wall clock: ${(wallClockMs / 1000).toFixed(2)}s | First ready: ${(timeToFirstReadyMs / 1000).toFixed(2)}s | Success: ${successful.length}/${concurrency}`);

  return {
    provider: name,
    mode: 'staggered',
    concurrency,
    staggerDelayMs,
    iterations: results,
    summary: {
      ttiMs: successful.length > 0
        ? computeStats(successfulTimes)
        : { median: 0, p95: 0, p99: 0 },
    },
    wallClockMs,
    timeToFirstReadyMs,
    rampProfile: rampProfile.sort((a, b) => a.launchedAt - b.launchedAt),
  };
}
