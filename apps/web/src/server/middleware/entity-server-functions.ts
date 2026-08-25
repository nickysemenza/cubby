import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { authenticatedEntityRuntimeContext } from "~/server/entity-runtime.server";

/**
 * Resolves the authenticated actor once for each generic entity Start call.
 * The request signal reaches the runtime so cancellation is not silently
 * discarded at the transport boundary.
 */
export const authenticatedEntityServerFunction = createMiddleware({
  type: "function",
}).server(
  async ({ next, signal }) =>
    await next({
      context: {
        entityRuntime: await authenticatedEntityRuntimeContext({
          headers: getRequest().headers,
          signal,
        }),
      },
    }),
);
