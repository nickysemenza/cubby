import type { Metadata } from "next";
import { EntityLayout } from "~/components/layouts/entity-layout";
import { ProblemsOverview } from "./problems-overview";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Data Problems",
  description: "Data consistency and integrity issues that need attention",
};

export default function ProblemsPage() {
  return (
    <EntityLayout title="Data Problems">
      <ProblemsOverview />
    </EntityLayout>
  );
}
