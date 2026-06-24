import { createFileRoute } from "@tanstack/react-router";
import { ShoppingListPage } from "~/app/meals/shopping-list-page";
import { Page } from "~/components/page/Page";

export const Route = createFileRoute("/_authenticated/meals/shopping-list")({
  component: ShoppingListRoute,
  head: () => ({ meta: [{ title: "Shopping List | cubby" }] }),
});

function ShoppingListRoute() {
  return (
    <Page variant="list" title="Shopping list" fullWidth>
      <ShoppingListPage />
    </Page>
  );
}
