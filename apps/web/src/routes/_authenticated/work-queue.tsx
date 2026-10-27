import { workQueueList } from "@cubby/schemas/work-queue";
import { createFileRoute } from "@tanstack/react-router";

import { RoutePending } from "~/entity/navigation/route-pending";
import { WorkQueuePage } from "~/features/work-queue/work-queue-page";
import { pageTitle } from "~/lib/page-title";
import { relationListSearch } from "~/ui/data-table/relation-list-search";
import { RouteErrorComponent } from "~/ui/feedback/route-error";

export const Route = createFileRoute("/_authenticated/work-queue")({
  validateSearch: relationListSearch(workQueueList),
  component: WorkQueuePage,
  pendingComponent: RoutePending,
  errorComponent: RouteErrorComponent,
  head: () => ({ meta: [{ title: pageTitle("Work queue") }] }),
});
