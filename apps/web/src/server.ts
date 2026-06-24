import { wrapFetchWithSentry } from "@sentry/tanstackstart-react";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";

// __CF_WORKERS__ is a build-time define (true only in build:cf). In production
// the Workers entry (cf-server.ts) wraps everything with @sentry/cloudflare's
// withSentry — the workerd-native SDK. wrapFetchWithSentry is built on
// @sentry/node: its error capture is safe, but its tracing (startSpan on the
// _serverFn path) assumes the Node OpenTelemetry runtime that workerd lacks.
// So apply it only in dev (Node via `vite dev`), where the node SDK is actually
// initialized by instrument.server.mjs. In prod, errors still reach Sentry via
// withSentry + the explicit captures in cf-server.ts / trpc.ts.
//
// Safety here is the RUNTIME guard, not tree-shaking: at runtime in prod
// `isCfBuild` is true, so wrapFetchWithSentry is never *called* — its
// node-tracing path can't execute on workerd regardless of whether the import
// is eliminated. The import itself is harmless: trpc.ts already pulls
// @sentry/tanstackstart-react into the Workers bundle for captureException, and
// it loads on workerd without side effects (the CF build/deploy is green).
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
