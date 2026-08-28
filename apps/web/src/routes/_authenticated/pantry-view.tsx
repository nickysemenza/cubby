import { createFileRoute } from "@tanstack/react-router";

import { IsometricPantry } from "~/app/pantry-view/IsometricPantry";
import { Page } from "~/components/page/Page";
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
