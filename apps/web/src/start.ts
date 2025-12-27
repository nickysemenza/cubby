/**
 * TanStack Start configuration
 * Global middleware is registered here
 */
import { createStart } from "@tanstack/react-start";
import { tracingMiddleware } from "~/server/middleware/tracing";

export const startInstance = createStart(() => ({
  // Request middleware runs on every server request (SSR, server routes, server functions)
  requestMiddleware: [tracingMiddleware],
}));
