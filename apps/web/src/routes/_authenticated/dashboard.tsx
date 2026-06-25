import { createFileRoute, redirect } from "@tanstack/react-router";

// `/dashboard` was an orphaned placeholder — the real dashboard is the home
// route (`/`). Permanently redirect so any stale link / bookmark lands on home.
export const Route = createFileRoute("/_authenticated/dashboard")({
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
});
