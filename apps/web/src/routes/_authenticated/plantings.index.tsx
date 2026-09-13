import { createFileRoute } from "@tanstack/react-router";

import { GardenHome } from "~/app/garden/garden-home";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { Page } from "~/components/page/Page";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/plantings/")({
  component: PlantingsPage,
  errorComponent: RouteErrorComponent,
  head: () => ({ meta: [{ title: pageTitle("Plantings") }] }),
});
function PlantingsPage() {
  return (
    <Page variant="list" title="Plantings" eyebrow="Garden" decoration="none">
      <GardenHome />
    </Page>
  );
}
