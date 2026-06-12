import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { getGuardSession } from "~/lib/auth-guard";

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async () => {
    // Server-side session read (see getGuardSession): runs during SSR so direct
    // loads to protected routes redirect on the server, before any protected
    // markup or chunks ship. Runs as a single RPC on client navigations.
    const session = await getGuardSession();
    if (!session) {
      throw redirect({
        to: "/auth/$authView",
        params: { authView: "sign-in" },
      });
    }
    return { session };
  },
  component: () => <Outlet />,
});
