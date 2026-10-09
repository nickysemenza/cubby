import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { SmartCollectionProvider } from "~/app/collections/smart-collection-state";
import { recipebridgeWasmPreload } from "~/lib/wasm-preload";

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: ({ context }) => {
    // The root reads the signed session cookie server-side (see __root
    // beforeLoad / getGuardSession), so a direct load to a protected route is
    // gated during SSR — before any protected markup or chunks ship — and we
    // avoid a second session read here.
    if (!context.isAuthed) {
      throw redirect({
        to: "/auth/$authView",
        params: { authView: "sign-in" },
      });
    }
  },
  // Nearly every authenticated page renders amounts or units through WASM.
  head: () => ({ links: [recipebridgeWasmPreload] }),
  component: () => (
    <SmartCollectionProvider>
      <Outlet />
    </SmartCollectionProvider>
  ),
});
