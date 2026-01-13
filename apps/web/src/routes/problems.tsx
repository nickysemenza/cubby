import { createFileRoute } from "@tanstack/react-router";
import { ProblemsOverview } from "~/app/problems/problems-overview";
import { EntityLayout } from "~/components/layouts/entity-layout";
import { authMiddleware } from "~/lib/protected-route";

export const Route = createFileRoute("/problems")({
  component: ProblemsPage,
  server: {
    middleware: [authMiddleware],
  },
});

function ProblemsPage() {
  return (
    <EntityLayout title="Data Problems">
      <ProblemsOverview />
    </EntityLayout>
  );
}
