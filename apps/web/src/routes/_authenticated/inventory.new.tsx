import { createFileRoute } from "@tanstack/react-router";
import CreateInventoryItem from "~/app/inventory/new/new-inventory";
import { PageWrapper } from "~/components/layout/page-wrapper";

export const Route = createFileRoute("/_authenticated/inventory/new")({
  component: NewInventoryPage,
});

function NewInventoryPage() {
  return (
    <PageWrapper>
      <CreateInventoryItem />
    </PageWrapper>
  );
}
