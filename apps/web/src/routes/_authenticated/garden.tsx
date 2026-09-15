import { createFileRoute } from "@tanstack/react-router";

import { GardenHome } from "~/app/garden/garden-home";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { Page } from "~/components/page/Page";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/garden")({
  component: GardenPage,
  errorComponent: RouteErrorComponent,
  head: () => ({ meta: [{ title: pageTitle("Garden") }] }),
});
function GardenPage() {
  return (
    <Page
      variant="list"
      title="Garden"
      listChrome="workbench"
      mobileTitleVisible
    >
      <GardenHome />
    </Page>
  );
}
