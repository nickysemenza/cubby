import { createFileRoute, redirect } from "@tanstack/react-router";

/** A retired Job page. A Job has no public record now, so its link opens Work. */
export const Route = createFileRoute("/_authenticated/jobs/$shortcode")({
  beforeLoad: () => {
    throw redirect({
      to: "/activity",
      search: { from: "jobs" },
      replace: true,
    });
  },
});
