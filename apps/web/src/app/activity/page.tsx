import { type Metadata } from "next";
import { EntityLayout } from "~/components/layouts/entity-layout";
import { AuditLogList } from "~/app/_components/audit-log/audit-log-list";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Activity",
  description: "Recent changes across your organization",
};

export default function ActivityPage() {
  return (
    <EntityLayout title="Activity">
      <div className="max-w-3xl">
        <p className="text-muted-foreground mb-6">
          Recent changes to products, locations, inventory, recipes, and
          ingredients across your organization.
        </p>
        <AuditLogList showEntityLink={true} />
      </div>
    </EntityLayout>
  );
}
