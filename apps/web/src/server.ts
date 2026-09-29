import { wrapFetchWithSentry } from "@sentry/tanstackstart-react";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";

import { withErrorReporting } from "~/server/errors/report-error";

// Local and production Workers use cf-server.ts's workerd-native Sentry wrapper.
// The Node wrapper remains for unbundled Node/test entrypoints; its tracing
// assumes Node OpenTelemetry and must stay outside the Worker graph.
//
// Two independent guards, and both matter. At RUNTIME `isCfBuild` is true in
// prod, so wrapFetchWithSentry is never *called*. At BUILD time `cfSentryShim`
// (vite.config.ts) resolves this import to src/lib/sentry-cf-shim.ts for the
// SSR environment, where wrapFetchWithSentry is the identity function — so
// @sentry/node never enters the worker bundle at all. That second guard is
// what keeps ~600 KiB of Node-only OpenTelemetry code out of the eager chunk;
// the runtime guard alone left it shipped-but-unused.
declare const __CF_WORKERS__: boolean;
const isCfBuild = __CF_WORKERS__;

const serverEntry = {
  async fetch(request: Request) {
    try {
      return await withErrorReporting(
        () => handler.fetch(request),
        request.headers,
      );
    } catch (error) {
      console.error("[server]", error);
      throw error;
    }
  },
};

export default createServerEntry(
  isCfBuild ? serverEntry : wrapFetchWithSentry(serverEntry),
);
