// CF Workers production entry point.
//
// 1. Dynamic import catches module-level errors (which would otherwise be silent 500s)
// 2. Per-request database connections via withRequestDb — Hyperdrive provides pooled
//    TCP connections, but each Worker invocation still needs its own pg.Client handle.
// 3. Intercepts console.error to capture real error details for `wrangler tail`.

import { setCfEnv } from "./server/cf-env";
import { withRequestDb } from "./server/db";

// Cache the handler module promise so the dynamic import only runs once (on
// first request). We keep it lazy (not a top-level static import) so that
// module-level errors are caught in the fetch() try/catch rather than becoming
// silent 500s.
let handlerPromise: Promise<
  typeof import("@tanstack/react-start/server-entry")
>;
const getHandler = () => {
  handlerPromise ??= import("@tanstack/react-start/server-entry");
  return handlerPromise;
};

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
    // Bridge CF secrets → process.env for libraries that read from it
    // (better-auth reads BETTER_AUTH_SECRET from process.env at init time)
    process.env.BETTER_AUTH_SECRET ??= env.BETTER_AUTH_SECRET;
    process.env.ALLOW_SIGNUP ??= env.ALLOW_SIGNUP;

    // Expose service bindings to server code (clients pick binding fetch
    // over public URLs when present).
    setCfEnv(env);

    lastInterceptedError = null;

    try {
      return await withRequestDb(env.HYPERDRIVE.connectionString, async () => {
        const { default: handler } = await getHandler();
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
