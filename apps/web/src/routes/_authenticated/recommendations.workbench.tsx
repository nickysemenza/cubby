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
  const { kind, source } = Route.useSearch();
  return (
    <Page variant="list" title="Recommendations Workbench" layout="full">
      {kind === "product-related" && source ? (
        <RecommendationWorkbench sourceId={source} />
      ) : (
        <p className="text-muted-foreground text-sm">
          Open this workbench from a product recommendation.
        </p>
      )}
    </Page>
  );
}
