import { createFileRoute } from "@tanstack/react-router";

import { Page } from "~/entity/page/page";
import { IsometricPantry } from "~/features/inventory/pantry-view/isometric-pantry";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/pantry-view")({
  component: PantryViewPage,
  head: () => ({ meta: [{ title: pageTitle("Pantry view") }] }),
});

function PantryViewPage() {
  return (
    <Page variant="bare" layout="viewport">
      <IsometricPantry />
    </Page>
  );
}
