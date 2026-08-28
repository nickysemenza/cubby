/**
 * TanStack Start configuration
 * Global middleware is registered here
 */
import { createCsrfMiddleware, createStart } from "@tanstack/react-start";

import { fetchWithRequestDiagnostics } from "~/lib/request-id";
import { privateServerFunctionResponses } from "~/server/middleware/private-server-functions";
import { tracingMiddleware } from "~/server/middleware/tracing";

// Restores the framework-default CSRF protection that defining a custom start
// instance otherwise replaces (TanStack only auto-applies it when no start
// instance exists). Scoped to server functions; SSR is unaffected.
const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

export const startInstance = createStart(() => ({
  serverFns: {
    fetch: (input, init) =>
      fetchWithRequestDiagnostics(globalThis.fetch, input, init),
  },
  // Request middleware runs on every server request (SSR, server routes, server functions)
  requestMiddleware: [
    tracingMiddleware,
    csrfMiddleware,
    privateServerFunctionResponses,
  ],
}));
