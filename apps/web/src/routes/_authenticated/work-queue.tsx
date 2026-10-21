import { workQueueHouseholdInput } from "@cubby/schemas/work-queue";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { RoutePending } from "~/entity/navigation/route-pending";
import { WorkQueuePage } from "~/features/work-queue/work-queue-page";
import { pageTitle } from "~/lib/page-title";
import { RouteErrorComponent } from "~/ui/feedback/route-error";

export const Route = createFileRoute("/_authenticated/work-queue")({
  // Column filters ride the URL as comma-joined lists with Any/No value
  // tokens; `buildQueueFilters` parses them against the household input.
  validateSearch: z.object({
    view: z.string().optional(),
    query: workQueueHouseholdInput.shape.query,
    entity: z.string().optional(),
    waitingFor: z.string().optional(),
    source: z.string().optional(),
    kind: z.string().optional(),
    check: z.string().optional(),
    vendor: z.string().optional(),
    sort: z.string().max(500).optional(),
    group: workQueueHouseholdInput.shape.group.catch(undefined),
  }),
  component: WorkQueuePage,
  pendingComponent: RoutePending,
  errorComponent: RouteErrorComponent,
  head: () => ({ meta: [{ title: pageTitle("Work queue") }] }),
});
