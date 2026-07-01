import { createFileRoute } from "@tanstack/react-router";
import CreateInventoryItem from "~/app/inventory/new/new-inventory";
import { Page } from "~/components/page/Page";

export const Route = createFileRoute("/_authenticated/inventory/new")({
  component: NewInventoryPage,
});

function NewInventoryPage() {
  return (
    <Page variant="list" title="New inventory" compact>
      <CreateInventoryItem />
    </Page>
  );
}
