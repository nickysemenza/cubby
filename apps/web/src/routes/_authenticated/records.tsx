import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/records")({
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
});
