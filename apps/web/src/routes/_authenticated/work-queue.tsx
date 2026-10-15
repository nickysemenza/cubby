import { workQueueHouseholdInput } from "@cubby/schemas/work-queue";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { WorkQueuePage } from "~/features/work-queue/work-queue-page";
import { pageTitle } from "~/lib/page-title";
import { RouteErrorComponent } from "~/ui/feedback/route-error";
import { RoutePending } from "~/ui/feedback/route-pending";

export const Route = createFileRoute("/_authenticated/work-queue")({
  validateSearch: workQueueHouseholdInput
    .omit({ sort: true, pageIndex: true, pageSize: true })
    .extend({
      waitingFor: workQueueHouseholdInput.shape.waitingFor.unwrap().optional(),
      sort: z.string().max(500).optional(),
    }),
  component: WorkQueuePage,
  pendingComponent: RoutePending,
  errorComponent: RouteErrorComponent,
  head: () => ({ meta: [{ title: pageTitle("Work queue") }] }),
});
