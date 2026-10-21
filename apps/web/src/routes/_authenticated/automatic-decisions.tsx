import { assessmentFamily } from "@cubby/schemas/assessment";
import { parseShortcode } from "@cubby/shared";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

export const Route = createFileRoute("/_authenticated/automatic-decisions")({
  validateSearch: z.object({
    record: z.string().optional(),
    family: assessmentFamily.optional(),
  }),
  beforeLoad: ({ search }) => {
    const record = search.record ? parseShortcode(search.record) : null;
    throw redirect({
      to: "/suggestions",
      search: {
        status: "automatic",
        auditFamily: search.family,
        record: record ? `${record.type}:${record.shortcode}` : undefined,
      },
      replace: true,
    });
  },
});
