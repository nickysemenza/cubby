import { createFileRoute } from "@tanstack/react-router";

import { IsometricPantry } from "~/app/pantry-view/IsometricPantry";
import { pageTitle } from "~/lib/page-title";
import { Page } from "~/ui/page/Page";

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
