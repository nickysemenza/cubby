import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { auth } from "~/lib/auth";

/**
 * Server-side session read for the `_authenticated` route guard.
 *
 * Runs the handler in-process during SSR — so an unauthenticated direct or
 * refresh load to a protected route redirects on the server, before any
 * protected markup or route chunks load — and as a single RPC on client-side
 * navigations.
 *
 * This replaces the previous client-only `authClient.getSession()` in
 * `_authenticated.beforeLoad`, which had two problems: (1) it short-circuited
 * during SSR (`typeof window === "undefined"`) and TanStack Router does not
 * re-run `beforeLoad` on the client for the initial matched route, so direct
 * loads to protected URLs were never gated; (2) the imperative call did not
 * share an in-flight promise with the providers' hook-based `useSession()`, so
 * a cold start fanned out into several redundant `/api/auth/get-session` fetches.
 *
 * Reads only the signed session cookie (cookieCache is enabled in `lib/auth.ts`),
 * so this is cheap on CF Workers — no DB round-trip on the hot path.
 */
export const getGuardSession = createServerFn({ method: "GET" }).handler(
  async () => {
    const session = await auth.api.getSession({
      headers: getRequest().headers,
    });
    return session?.user ? { userId: session.user.id } : null;
  },
);
