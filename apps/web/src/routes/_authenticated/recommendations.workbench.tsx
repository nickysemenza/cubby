import { recommendationWorkbenchSearch } from "@cubby/schemas/recommendations";
import { createFileRoute } from "@tanstack/react-router";

import { RecommendationWorkbench } from "~/app/recommendations/recommendation-workbench";
import { Page } from "~/components/page/Page";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute(
  "/_authenticated/recommendations/workbench",
)({
  validateSearch: recommendationWorkbenchSearch,
  component: RecommendationWorkbenchPage,
  head: () => ({ meta: [{ title: pageTitle("Recommendations workbench") }] }),
});

function RecommendationWorkbenchPage() {
  const { kind, inventory, source, candidate } = Route.useSearch();
  return (
    <Page variant="list" title="Recommendations Workbench" layout="full">
      {kind === "placement" && inventory ? (
        <RecommendationWorkbench inventoryId={inventory} kind={kind} />
      ) : kind === "product-match" ? (
        <RecommendationWorkbench
          sourceId={source}
          candidateId={candidate}
          kind={kind}
        />
      ) : kind && source ? (
        <RecommendationWorkbench sourceId={source} kind={kind} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Open this workbench from a current recommendation.
        </p>
      )}
    </Page>
  );
}
