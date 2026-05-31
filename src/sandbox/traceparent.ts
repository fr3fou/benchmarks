import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import http from 'node:http';
import https from 'node:https';

export interface TraceContext {
  traceparent: string;
  traceId: string;
  spanId: string;
}

// W3C trace-context: version-traceId-spanId-flags
// e.g. 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
export function newTraceparent(): TraceContext {
  const traceId = randomBytes(16).toString('hex');
  const spanId = randomBytes(8).toString('hex');
  return { traceparent: `00-${traceId}-${spanId}-01`, traceId, spanId };
}

const store = new AsyncLocalStorage<TraceContext>();

export function runWithTraceparent<T>(ctx: TraceContext, fn: () => T): T {
  return store.run(ctx, fn);
}

export function currentTraceparent(): string | undefined {
  return store.getStore()?.traceparent;
}

let installed = false;

// Patch http(s).request so every outgoing request made inside a
// runWithTraceparent() scope carries the active W3C traceparent. The js-client
// uses node-fetch v2 for REST and the bundled `ws` client for command-exec;
// both route through http(s).request, so this single hook covers REST + the WS
// upgrade handshake — no OTEL SDK, no edits to the js-client or computesdk.
export function installTraceparentPropagation(): void {
  if (installed) return;
  installed = true;
  for (const mod of [http, https]) {
    const orig = mod.request.bind(mod) as (...args: any[]) => any;
    (mod as { request: (...args: any[]) => any }).request = (...args: any[]) => {
      const tp = currentTraceparent();
      if (tp) {
        // Skip the URL/string/callback args; the options object holds headers.
        const opts = args.find(a => a && typeof a === 'object' && !(a instanceof URL));
        if (opts) opts.headers = { ...(opts.headers ?? {}), traceparent: tp };
      }
      return orig(...args);
    };
  }
}
