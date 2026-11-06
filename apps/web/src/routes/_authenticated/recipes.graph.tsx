import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/recipes/graph")({
  beforeLoad: () => {
    throw redirect({ to: "/entities", search: { tab: "recipes" } });
  },
});
