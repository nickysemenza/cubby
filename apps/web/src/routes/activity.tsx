import { createFileRoute } from "@tanstack/react-router";
import { AuditLogList } from "~/app/_components/audit-log/audit-log-list";
import { EntityLayout } from "~/components/layouts/entity-layout";
import { authMiddleware } from "~/lib/protected-route";

export const Route = createFileRoute("/activity")({
  component: ActivityPage,
  server: {
    middleware: [authMiddleware],
  },
});

function ActivityPage() {
  return (
    <EntityLayout title="Activity">
      <div className="max-w-3xl">
        <p className="mb-6 text-muted-foreground">
          Recent changes to products, locations, inventory, recipes, and
          ingredients.
        </p>
        <AuditLogList showEntityLink={true} />
      </div>
    </EntityLayout>
  );
}
