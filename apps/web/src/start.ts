/**
 * TanStack Start configuration
 * Global middleware is registered here
 */
import { createCsrfMiddleware, createStart } from "@tanstack/react-start";

import { notifyNativeWorkspaceResponse } from "~/lib/native-workspace-bridge";
import { fetchWithRequestDiagnostics } from "~/lib/request-id";
import { labelStartRequest } from "~/lib/start-dispatch-url";
import { nativeWorkspaceClientGate } from "~/server/operation-runtime/middleware/native-workspace";
import { privateServerFunctionResponses } from "~/server/operation-runtime/middleware/private-server-functions";
import { tracingMiddleware } from "~/server/operation-runtime/middleware/tracing";

// Restores the framework-default CSRF protection that defining a custom start
// instance otherwise replaces (TanStack only auto-applies it when no start
// instance exists). Scoped to server functions; SSR is unaffected.
const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

export const startInstance = createStart(() => ({
  serverFns: {
    fetch: (input, init) =>
      fetchWithRequestDiagnostics(
        globalThis.fetch,
        labelStartRequest(input, init),
        init,
      ).then(notifyNativeWorkspaceResponse),
  },
  // Request middleware runs on every server request (SSR, server routes, server functions)
  requestMiddleware: [
    tracingMiddleware,
    nativeWorkspaceClientGate,
    csrfMiddleware,
    privateServerFunctionResponses,
  ],
}));
