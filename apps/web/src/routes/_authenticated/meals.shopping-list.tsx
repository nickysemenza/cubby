import { createFileRoute } from "@tanstack/react-router";
import { ShoppingListPage } from "~/app/meals/shopping-list-page";
import { EntityLayout } from "~/components/layouts/entity-layout";

export const Route = createFileRoute("/_authenticated/meals/shopping-list")({
  component: ShoppingListRoute,
  head: () => ({ meta: [{ title: "Shopping List | cubby" }] }),
});

function ShoppingListRoute() {
  return (
    <EntityLayout title="Shopping list" fullWidth>
      <ShoppingListPage />
    </EntityLayout>
  );
}
