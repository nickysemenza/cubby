import { useRouteContext } from "@tanstack/react-router";
import { authClient } from "~/lib/auth-client";
import { useHydrated } from "./useHydrated";

/**
 * SSR-accurate auth state for nav chrome (MainNav, BottomNav).
 *
 * The better-auth client session is `isPending` (no data) during SSR and the
 * first client render, so branching on it alone makes the nav flash: optimistic
 * code shows the authed nav and then collapses for logged-out users; the
 * inverse flashes the public nav at the signed-in primary user. Neither is
 * acceptable.
 *
 * The root route's `beforeLoad` reads the signed session cookie server-side and
 * exposes `isAuthed` on the route context. We use that during the pre-resolve
 * window — it is identical on SSR and the first client render (serialized from
 * the server), so there is no hydration mismatch — then switch to the live
 * client session once it resolves, so sign-in / sign-out update the nav without
 * a reload.
 */
export function useNavAuthed(): boolean {
  const { isAuthed } = useRouteContext({ from: "__root__" });
  const { data, isPending } = authClient.useSession();
  const hydrated = useHydrated();

  // Before hydration, or while the client session is still resolving, trust the
  // server-rendered value; afterwards prefer the live session.
  if (!hydrated || isPending) return isAuthed;
  return !!data?.user;
}
