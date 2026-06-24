import { createFileRoute } from "@tanstack/react-router";
import { ProblemsOverview } from "~/app/problems/problems-overview";
import { Page } from "~/components/page/Page";
import { RoutePending } from "~/components/route-pending";

export const Route = createFileRoute("/_authenticated/problems")({
  // Best-effort warm of the cheap DB-only group only — NON-blocking (void), like
  // every other loader here: the SSR trpc client targets localhost (unreachable
  // on CF Workers, unauthenticated in dev), so awaiting would throw into the
  // error boundary. useProblemsData fetches all five groups client-side (each its
  // own Worker invocation/CPU budget) and the page's skeleton covers cold loads.
  // The heavy WASM/network groups are deliberately NOT prefetched here — keeping
  // their CPU out of the SSR invocation is the whole point.
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(
      context.trpc.problems.getFast.queryOptions(),
    );
  },
  pendingComponent: RoutePending,
  component: ProblemsPage,
});

function ProblemsPage() {
  return (
    <Page variant="list" title="Data Problems">
      <ProblemsOverview />
    </Page>
  );
}
