import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

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
  component: () => <Outlet />,
});
