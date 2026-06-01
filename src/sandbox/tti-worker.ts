// TTI benchmark WORKER process (burst / staggered).
//
// Forked by tti-cluster.ts, one per core. Runs its share of `concurrency`
// using the SAME runConcurrentBenchmark / runStaggeredBenchmark logic (full
// create → exec → exec → destroy lifecycle), then ships its TimingResult[]
// plus wall/first-ready/rampProfile back over IPC and exits. The orchestrator
// merges every worker's slice into one result of the standard shape.
//
// Env (set by the orchestrator at fork time):
//   CT_MODE            — "burst" | "staggered"
//   CT_PROVIDER        — provider name to look up in providers[]
//   CT_CONCURRENCY     — this worker's share of sandboxes
//   CT_WORKER_ID       — index, for log prefixes
//   CT_RUN_NONCE       — shared reuse-marker nonce across all workers
//   CT_STAGGER_MS      — (staggered) per-worker cadence = staggerDelayMs × workers
//   CT_START_OFFSET_MS — (staggered) delay before first launch = workerId × staggerDelayMs

// Match run.ts ordering: install the traceparent http patch and load .env
// before the js-client is first used.
import { installTraceparentPropagation } from './traceparent.js';
installTraceparentPropagation();
import { installKeepAliveAgent } from './keepalive.js';
installKeepAliveAgent();
import '../env.js';

import { providers } from './providers.js';
import { runConcurrentBenchmark } from './concurrent.js';
import { runStaggeredBenchmark } from './staggered.js';

async function main() {
  const mode = process.env.CT_MODE!;
  const providerName = process.env.CT_PROVIDER!;
  const concurrency = Number(process.env.CT_CONCURRENCY);
  const workerId = process.env.CT_WORKER_ID ?? '?';
  const runNonce = process.env.CT_RUN_NONCE;

  const providerConfig = providers.find(p => p.name === providerName);
  if (!providerConfig) {
    throw new Error(`Worker ${workerId}: unknown provider "${providerName}"`);
  }
  const logPrefix = `[w${workerId}]`;

  const result =
    mode === 'staggered'
      ? await runStaggeredBenchmark({
          ...providerConfig,
          concurrency,
          staggerDelayMs: Number(process.env.CT_STAGGER_MS),
          startOffsetMs: Number(process.env.CT_START_OFFSET_MS || '0'),
          runNonce,
          logPrefix,
        })
      : await runConcurrentBenchmark({
          ...providerConfig,
          concurrency,
          runNonce,
          logPrefix,
        });

  const partial = {
    iterations: result.iterations,
    wallClockMs: result.wallClockMs,
    timeToFirstReadyMs: result.timeToFirstReadyMs,
    rampProfile: (result as any).rampProfile as
      | { launchedAt: number; readyAt: number; ttiMs: number }[]
      | undefined,
  };

  await new Promise<void>(resolve => {
    process.send!(partial, undefined, undefined, () => resolve());
  });
  process.exit(0);
}

main().catch(err => {
  console.error(`[w${process.env.CT_WORKER_ID ?? '?'}] failed:`, err);
  process.exit(1);
});
