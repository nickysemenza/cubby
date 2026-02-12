import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { authClient } from "~/lib/auth-client";

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async () => {
    // Auth client makes HTTP requests — skip during SSR where there's no browser context
    if (typeof window === "undefined") return {};

    const session = await authClient.getSession();
    if (!session.data) {
      throw redirect({
        to: "/auth/$authView",
        params: { authView: "sign-in" },
      });
    }
    return { session: session.data };
  },
  component: () => <Outlet />,
});
