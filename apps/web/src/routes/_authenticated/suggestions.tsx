import { createFileRoute, useNavigate, redirect } from "@tanstack/react-router";

import { RoutePending } from "~/entity/navigation/route-pending";
import { SuggestionsPage } from "~/entity/suggestions/queue/suggestions-page";
import { suggestionsSearchSchema } from "~/entity/suggestions/queue/suggestions-search";
import { pageTitle } from "~/lib/page-title";
import { RouteErrorComponent } from "~/ui/feedback/route-error";

export const Route = createFileRoute("/_authenticated/suggestions")({
  // `family`, `record` (`<kind>:<CODE>`) and `runId` scope the list; column
  // filters ride beside them under their column ids (`useTableState`).
  validateSearch: suggestionsSearchSchema,
  beforeLoad: ({ search }) => {
    if (search.status === "applied_automatically")
      throw redirect({
        to: "/suggestions",
        search: { ...search, status: "automatic" },
      });
  },
  component: SuggestionsRoute,
  pendingComponent: RoutePending,
  errorComponent: RouteErrorComponent,
  head: () => ({ meta: [{ title: pageTitle("Suggestions") }] }),
});

function SuggestionsRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  return (
    <SuggestionsPage
      search={search}
      onSearch={(patch, replace = false) =>
        void navigate({
          to: ".",
          replace,
          // A new family or status view starts from its own filters and order.
          search: (previous) =>
            ("family" in patch && patch.family !== previous.family) ||
            ("status" in patch && patch.status !== previous.status)
              ? {
                  record: previous.record,
                  runId: previous.runId,
                  sweep: previous.sweep,
                  family: previous.family,
                  auditFamily: previous.auditFamily,
                  status: previous.status,
                  ...patch,
                }
              : { ...previous, ...patch },
        })
      }
    />
  );
}
