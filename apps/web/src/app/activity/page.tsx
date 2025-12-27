import type { Metadata } from "next";
import { AuditLogList } from "~/app/_components/audit-log/audit-log-list";
import { EntityLayout } from "~/components/layouts/entity-layout";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Activity",
  description: "Recent changes across your organization",
};

export default function ActivityPage() {
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
