import { GitMergeIcon } from "@phosphor-icons/react/dist/csr/GitMerge";
import { createFileRoute, Link } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

import { problems } from "~/integrations/tanstack-query/generated/catalog.gen";
import { pageTitle } from "~/lib/page-title";
import { SimpleLoading } from "~/ui/feedback/loading-skeletons";
import { Stack } from "~/ui/layout";
import { Page } from "~/ui/page/Page";
import { Button } from "~/ui/primitives/button";
import { RouteErrorComponent } from "~/ui/route-error";
import { RoutePending } from "~/ui/route-pending";

// The overview pulls in all five independently loaded Problems lanes plus the
// declarative assembly UI. It is only useful on this dedicated route, so keep
// it out of the app shell while preserving its own loading
// semantics once the route is opened.
const ProblemsOverview = lazy(async () => {
  const module = await import("~/app/problems/problems-overview");
  return { default: module.ProblemsOverview };
});
export const Route = createFileRoute("/_authenticated/problems")({
  // Best-effort warm of the cheap DB-only group only — NON-blocking (void), like
  // every other loader here: awaiting would add the detector to the critical
  // SSR path. useProblemsData fetches all hot groups independently (each in its
  // own Worker invocation/CPU budget) and the page's skeleton covers cold loads.
  // The heavy WASM/network groups are deliberately NOT prefetched here — keeping
  // their CPU out of the SSR invocation is the whole point.
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(problems.getFast.queryOptions());
  },
  pendingComponent: RoutePending,
  errorComponent: RouteErrorComponent,
  component: ProblemsPage,
  head: () => ({ meta: [{ title: pageTitle("Problems") }] }),
});

function ProblemsPage() {
  return (
    <Page
      variant="list"
      title="Data Problems"
      actions={
        // The product match queue is a review surface, not a Problems lane:
        // its detector needs vector lookups the DB-only fast lane forbids.
        <Button
          size="sm"
          variant="outline"
          render={
            <Link
              to="/recommendations/workbench"
              search={{ kind: "product-match" }}
            />
          }
          nativeButton={false}
        >
          <GitMergeIcon className="size-3.5" />
          Product matches
        </Button>
      }
    >
      <Stack gap="lg">
        <ProblemsContent />
      </Stack>
    </Page>
  );
}

function ProblemsContent() {
  return (
    <Suspense fallback={<SimpleLoading text="Loading Problems..." />}>
      <ProblemsOverview />
    </Suspense>
  );
}
