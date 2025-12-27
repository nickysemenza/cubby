import { createFileRoute } from "@tanstack/react-router";
import { AuditLogList } from "~/app/_components/audit-log/audit-log-list";
import { EntityLayout } from "~/components/layouts/entity-layout";

export const Route = createFileRoute("/activity")({
  component: ActivityPage,
});

function ActivityPage() {
  return (
    <EntityLayout title="Activity">
      <div className="max-w-3xl">
        <p className="mb-6 text-muted-foreground">
          Recent changes to products, locations, inventory, recipes, and
          ingredients across your organization.
        </p>
        <AuditLogList showEntityLink={true} />
      </div>
    </EntityLayout>
  );
}
