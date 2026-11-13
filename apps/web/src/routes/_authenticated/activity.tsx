import { auditEntitySchema } from "@cubby/schemas/audit";
import { auditChannelSchema } from "@cubby/schemas/context";
import { fieldRefreshLocator } from "@cubby/schemas/field-explanation";
import { runShortcode } from "@cubby/schemas/identifiers";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

import { Page } from "~/entity/page/page";
import { WorkPage } from "~/features/activity/work-page";
import { pageTitle } from "~/lib/page-title";

/**
 * This page has no search state of its own. These keys are links into the views
 * it replaced (`tab=now&refresh=…` and older filters), which still resolve.
 */
const retiredSearch = z.object({
  tab: z
    .enum(["needs-you", "now", "improvements", "history", "maintenance"])
    .optional()
    .catch(undefined),
  entityKind: auditEntitySchema.optional().catch(undefined),
  channel: auditChannelSchema.optional().catch(undefined),
  kind: z.string().trim().min(1).max(100).optional().catch(undefined),
  runId: runShortcode.optional().catch(undefined),
  attention: z.boolean().optional().catch(undefined),
  refresh: fieldRefreshLocator.optional().catch(undefined),
  /** Arrived from a retired Jobs link, which the page explains once. */
  from: z.literal("jobs").optional().catch(undefined),
});

export const Route = createFileRoute("/_authenticated/activity")({
  validateSearch: retiredSearch,
  beforeLoad: ({ search }) => {
    // An exact Work locator named one value: its record's page explains it.
    // An old filter on one Run: its page shows that Run's Jobs.
    if (search.runId)
      throw redirect({
        to: "/runs/$shortcode",
        params: { shortcode: search.runId },
        replace: true,
      });
    if (search.refresh)
      throw redirect({
        to: "/$shortcode",
        params: { shortcode: search.refresh.entityId },
        replace: true,
      });
    if (search.tab === "maintenance")
      throw redirect({ to: "/settings", hash: "maintenance", replace: true });
    if (search.tab === "improvements")
      throw redirect({ to: "/suggestions", replace: true });
    if (search.tab === "history" || search.entityKind || search.channel)
      throw redirect({
        to: "/history",
        search: { entityKind: search.entityKind, channel: search.channel },
        replace: true,
      });
  },
  head: () => ({ meta: [{ title: pageTitle("Work") }] }),
  component: WorkRoute,
});

function WorkRoute() {
  const { from } = Route.useSearch();
  return (
    <Page variant="list" title="Work" layout="full" bodyGutter="standard">
      <WorkPage fromRetiredJobs={from === "jobs"} />
    </Page>
  );
}
