import { createFileRoute } from "@tanstack/react-router";
import { ProblemsOverview } from "~/app/problems/problems-overview";
import { Page } from "~/components/page/Page";
import { RoutePending } from "~/components/route-pending";

export const Route = createFileRoute("/_authenticated/problems")({
  // Ensure data exists before render, but only *block* on a truly cold load —
  // staleTime Infinity makes ensureQueryData reuse any cached scan (e.g. the
  // navbar badge's) without a blocking refetch. The page query revalidates in
  // the background on entry, so freshness is handled there, not by a wait here.
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData({
      ...context.trpc.problems.getAllProblems.queryOptions(),
      staleTime: Number.POSITIVE_INFINITY,
    });
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
