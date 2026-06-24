import { createFileRoute } from "@tanstack/react-router";
import { ProblemsOverview } from "~/app/problems/problems-overview";
import { EntityLayout } from "~/components/layouts/entity-layout";
import { RoutePending } from "~/components/route-pending";

export const Route = createFileRoute("/_authenticated/problems")({
  // Warm the (heavy) full-scan query before render — usually already cached from
  // the navbar badge, so this rarely blocks; RoutePending covers a cold load.
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(
      context.trpc.problems.getAllProblems.queryOptions(),
    );
  },
  pendingComponent: RoutePending,
  component: ProblemsPage,
});

function ProblemsPage() {
  return (
    <EntityLayout title="Data Problems">
      <ProblemsOverview />
    </EntityLayout>
  );
}
