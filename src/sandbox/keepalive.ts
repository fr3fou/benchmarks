import http from 'node:http';
import https from 'node:https';

// HTTP keep-alive / connection pooling for the Northflank API client.
//
// The fix from the slide: `new ApiClient(contextProvider, agent)` where `agent`
// is a keepAlive https.Agent. We can't apply it there directly — this repo uses
// the vendored `@computesdk/northflank`, whose buildClient() does
// `new ApiClient(ctx, { throwErrorOnHttpErrorCode: true })` with no agent and
// exposes no agent passthrough. So we inject the same agent one layer down.
//
// The js-client's REST layer uses node-fetch v2. With no agent it sets
// `Connection: close` and opens a fresh TCP + TLS connection for every API call;
// under burst/staggered load that's a full handshake per request. We patch
// http(s).request (the same hook traceparent.ts uses) to attach a shared
// keepAlive agent and drop node-fetch's `Connection: close` so the socket pool
// actually gets reused.
//
// Installed in BOTH run.ts (single-process / sequential) and the forked
// tti-worker.ts (burst / staggered), so the pooling applies regardless of the
// worker clustering. Each forked worker is its own process with its own agent
// and socket pool — that's intentional; pooling is per-process.
//
// Disable for an A/B run with NF_HTTP_KEEPALIVE=0.

const KEEPALIVE_OPTS = {
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 128, // concurrent connections cap
  maxFreeSockets: 32, // idle connections to keep around
  scheduling: 'lifo' as const,
  timeout: 60_000,
};

export const httpsKeepAliveAgent = new https.Agent(KEEPALIVE_OPTS);
export const httpKeepAliveAgent = new http.Agent(KEEPALIVE_OPTS);

let installed = false;

export function installKeepAliveAgent(): void {
  if (process.env.NF_HTTP_KEEPALIVE === '0') return;
  if (installed) return;
  installed = true;

  for (const [mod, agent] of [
    [http, httpKeepAliveAgent],
    [https, httpsKeepAliveAgent],
  ] as const) {
    const orig = mod.request.bind(mod) as (...args: any[]) => any;
    (mod as { request: (...args: any[]) => any }).request = (...args: any[]) => {
      // Skip the URL/string/callback args; the options object holds agent + headers.
      const opts = args.find(a => a && typeof a === 'object' && !(a instanceof URL));
      if (opts) {
        // Only inject when the caller didn't pick an agent (node-fetch passes
        // `agent: undefined`; `agent: false` means "explicitly no pooling").
        if (opts.agent == null) opts.agent = agent;
        // node-fetch v2 forces `Connection: close` when no fetch-level agent is
        // set; strip only that so keep-alive engages. Leave `Connection: Upgrade`
        // (the ws command-exec / log-tail handshake) untouched.
        const headers = opts.headers;
        if (headers) {
          for (const k of Object.keys(headers)) {
            if (k.toLowerCase() === 'connection' && String(headers[k]).toLowerCase() === 'close') {
              delete headers[k];
            }
          }
        }
      }
      return orig(...args);
    };
  }

  console.log(
    `[keepalive] http(s) connection pooling enabled ` +
      `(maxSockets=${KEEPALIVE_OPTS.maxSockets}, maxFreeSockets=${KEEPALIVE_OPTS.maxFreeSockets}, ` +
      `keepAliveMsecs=${KEEPALIVE_OPTS.keepAliveMsecs}, scheduling=${KEEPALIVE_OPTS.scheduling})`,
  );
}
