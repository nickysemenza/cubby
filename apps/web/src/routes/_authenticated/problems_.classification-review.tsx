import { createFileRoute } from "@tanstack/react-router";

import { SuggestionQueue } from "~/features/ai/suggestion-queue";
import { pageTitle } from "~/lib/page-title";
import { RouteErrorComponent } from "~/ui/route-error";
import { RoutePending } from "~/ui/route-pending";

export const Route = createFileRoute(
  "/_authenticated/problems_/classification-review",
)({
  pendingComponent: RoutePending,
  errorComponent: RouteErrorComponent,
  component: SuggestionQueue,
  head: () => ({ meta: [{ title: pageTitle("Classification review") }] }),
});
