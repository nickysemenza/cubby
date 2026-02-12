import { createFileRoute } from "@tanstack/react-router";
import { ProblemsOverview } from "~/app/problems/problems-overview";
import { EntityLayout } from "~/components/layouts/entity-layout";

export const Route = createFileRoute("/_authenticated/problems")({
  component: ProblemsPage,
});

function ProblemsPage() {
  return (
    <EntityLayout title="Data Problems">
      <ProblemsOverview />
    </EntityLayout>
  );
}
