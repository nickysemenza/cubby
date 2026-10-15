import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { SmartCollectionProvider } from "~/features/collection/smart-collection-state";
import { installFeatures } from "~/features/registry";

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: ({ context, search }) => {
    // The root reads the signed session cookie server-side (see __root
    // beforeLoad / getGuardSession), so a direct load to a protected route is
    // gated during SSR — before any protected markup or chunks ship — and we
    // avoid a second session read here.
    if (!context.isAuthed) {
      throw redirect({
        to: "/auth/$authView",
        params: { authView: "sign-in" },
        search: { nativeWorkspace: search.nativeWorkspace },
      });
    }
  },
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  // The feature registry installs from code-split chunks, not router.tsx, so
  // feature code stays out of the Worker's first-request closure. Route
  // chunks load before SSR render and hydration; idempotent.
  installFeatures();
  return (
    <SmartCollectionProvider>
      <Outlet />
    </SmartCollectionProvider>
  );
}
