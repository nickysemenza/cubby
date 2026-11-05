import { runShortcode } from "@cubby/schemas/identifiers";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

/**
 * The retired Jobs list. Links to it still land somewhere useful: a filter on one Run
 * opens that Run, whose page shows its Jobs, and anything else opens Work.
 */
export const Route = createFileRoute("/_authenticated/jobs/")({
  validateSearch: z.object({
    runId: runShortcode.optional().catch(undefined),
  }),
  beforeLoad: ({ search }) => {
    if (search.runId)
      throw redirect({
        to: "/runs/$shortcode",
        params: { shortcode: search.runId },
        replace: true,
      });
    throw redirect({
      to: "/activity",
      search: { from: "jobs" },
      replace: true,
    });
  },
});
