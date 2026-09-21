import { createFileRoute, redirect } from "@tanstack/react-router";

/** Compatibility for links made before Plantings used the dialog create flow. */
export const Route = createFileRoute("/_authenticated/plantings/new")({
  beforeLoad: () => {
    throw redirect({
      to: "/plantings",
      search: { create: true },
      replace: true,
    });
  },
});
