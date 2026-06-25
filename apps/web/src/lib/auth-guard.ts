import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { auth } from "~/lib/auth";
import { authClient } from "~/lib/auth-client";

/**
 * Server-side session read for the `_authenticated` route guard.
 *
 * Runs the handler in-process during SSR — so an unauthenticated direct or
 * refresh load to a protected route redirects on the server, before any
 * protected markup or route chunks load.
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
 *
 * The root `beforeLoad` only invokes this on the SERVER (`import.meta.env.SSR`);
 * on client navigations it uses {@link getClientAuthed} instead, so an in-app
 * navigation no longer pays a `/_serverFn/` round-trip. The server fn is the only
 * consumer of `~/lib/auth`, so that (server-only) import is stripped from the
 * client bundle by the server-fn split.
 */
export const getGuardSession = createServerFn({ method: "GET" }).handler(
  async () => {
    const session = await auth.api.getSession({
      headers: getRequest().headers,
    });
    return session?.user ? { userId: session.user.id } : null;
  },
);

// Client-only cache of the last *resolved* auth state from better-auth's
// in-memory session store. Defaults optimistically to `true` so the brief
// pre-resolve (`isPending`) window on a cold client start never bounces the
// (effectively always logged-in) owner to sign-in. This is a per-tab module var,
// never shared across users; the real security boundary is unchanged — SSR gates
// direct/refresh loads via `getGuardSession`, and every tRPC `protectedProcedure`
// re-checks the session server-side.
let lastResolvedAuthed = true;

/**
 * Synchronous, network-free read of the current auth state from better-auth's
 * in-memory session store (`$store.atoms.session`), for the root `beforeLoad` on
 * CLIENT navigations — so an in-app navigation doesn't fire a `/_serverFn/` RPC
 * just to re-learn the already-known auth state (unlike `authClient.getSession()`,
 * which hits the network). While the store is still resolving, returns the last
 * resolved value (optimistic `true` on a cold start).
 */
export const getClientAuthed = (): boolean => {
  const state = authClient.$store.atoms.session?.get() as
    | { data?: { user?: unknown } | null; isPending?: boolean }
    | undefined;
  if (state && state.isPending !== true) {
    lastResolvedAuthed = !!state.data?.user;
  }
  return lastResolvedAuthed;
};
