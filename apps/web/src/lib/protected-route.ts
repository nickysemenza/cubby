import { redirect } from "@tanstack/react-router";
import { createMiddleware } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { auth } from "~/lib/auth";

/**
 * Authentication middleware that protects routes from unauthenticated access.
 *
 * This middleware:
 * 1. Retrieves the Better-Auth session using request headers
 * 2. Redirects to login if no valid session exists
 * 3. Preserves the intended destination for post-login redirect
 *
 * Usage: Apply to routes via the `server.middleware` array.
 *
 * @example
 * ```typescript
 * import { authMiddleware } from "~/lib/protected-route";
 *
 * export const Route = createFileRoute("/products/")({
 *   component: ProductsPage,
 *   server: {
 *     middleware: [authMiddleware],
 *   },
 * });
 * ```
 */
export const authMiddleware = createMiddleware().server(
  async ({ next, request }) => {
    const headers = getRequestHeaders();
    const session = await auth.api.getSession({ headers });

    if (!session) {
      // Extract pathname from request URL for redirect
      const url = new URL(request.url);
      throw redirect({
        to: "/auth/sign-in",
        search: {
          redirect: url.pathname + url.search,
        },
      });
    }

    return await next();
  },
);
