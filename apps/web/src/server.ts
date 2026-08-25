import { wrapFetchWithSentry } from "@sentry/tanstackstart-react";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";

// __CF_WORKERS__ is a build-time define (true only in build:cf). In production
// the Workers entry (cf-server.ts) wraps everything with @sentry/cloudflare's
// withSentry — the workerd-native SDK. wrapFetchWithSentry is built on
// @sentry/node: its error capture is safe, but its tracing (startSpan on the
// _serverFn path) assumes the Node OpenTelemetry runtime that workerd lacks.
// So apply it only in dev (Node via `vite dev`), where the node SDK is actually
// initialized by instrument.server.mjs. In prod, errors still reach Sentry via
// withSentry + the explicit captures in cf-server.ts / observed-request.ts.
//
// Two independent guards, and both matter. At RUNTIME `isCfBuild` is true in
// prod, so wrapFetchWithSentry is never *called*. At BUILD time `cfSentryShim`
// (vite.config.ts) resolves this import to src/lib/sentry-cf-shim.ts for the
// SSR environment, where wrapFetchWithSentry is the identity function — so
// @sentry/node never enters the worker bundle at all. That second guard is
// what keeps ~600 KiB of Node-only OpenTelemetry code out of the eager chunk;
// the runtime guard alone left it shipped-but-unused.
declare const __CF_WORKERS__: boolean | undefined;
const isCfBuild =
  typeof __CF_WORKERS__ !== "undefined" && __CF_WORKERS__ === true;

const serverEntry = {
  async fetch(request: Request) {
    try {
      return await handler.fetch(request);
    } catch (error) {
      console.error("[server]", error);
      throw error;
    }
  },
};

export default createServerEntry(
  isCfBuild ? serverEntry : wrapFetchWithSentry(serverEntry),
);
