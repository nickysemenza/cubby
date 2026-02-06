// CF Workers entry point.
//
// Key differences from the Vercel/node-server entry:
// 1. Dynamic import catches module-level errors (which would otherwise be silent 500s)
// 2. Per-request database connections via withRequestDb — Hyperdrive provides pooled
//    TCP connections, but each Worker invocation still needs its own pg.Client handle.
//
// Also intercepts console.error to capture real error details that Nitro's
// HTTPError.toJSON() strips from unhandled errors (always returns
// {"status":500,"message":"HTTPError"} with no stack trace or cause).

import { withRequestDb } from "./server/db";

let lastInterceptedError: {
  name: string;
  message: string;
  stack?: string;
  cause?: unknown;
} | null = null;

const _origError = console.error;
console.error = (...args: unknown[]) => {
  for (const arg of args) {
    if (arg instanceof Error) {
      lastInterceptedError = {
        name: arg.constructor.name,
        message: arg.message,
        stack: arg.stack,
        cause:
          arg.cause instanceof Error
            ? {
                name: arg.cause.constructor.name,
                message: arg.cause.message,
                stack: arg.cause.stack,
              }
            : arg.cause
              ? String(arg.cause)
              : undefined,
      };
    }
  }
  _origError(...args);
};

export default {
  async fetch(request: Request, env: Env) {
    lastInterceptedError = null;

    try {
      return await withRequestDb(env.HYPERDRIVE.connectionString, async () => {
        const { default: handler } = await import(
          "@tanstack/react-start/server-entry"
        );
        const response = await handler.fetch(request);

        // If Nitro returned a 500 and we intercepted a real error, log the details
        // so they appear in `wrangler tail` (Nitro's response body is useless).
        if (response.status >= 500 && lastInterceptedError) {
          console.error(
            "[cf-server] Unhandled error:",
            JSON.stringify(lastInterceptedError, null, 2),
          );
        }

        return response;
      });
    } catch (error) {
      console.error("[cf-server]", error);
      const msg =
        error instanceof Error
          ? `${error.constructor.name}: ${error.message}\n${error.stack}`
          : String(error);
      return new Response(msg, { status: 500 });
    }
  },
};
