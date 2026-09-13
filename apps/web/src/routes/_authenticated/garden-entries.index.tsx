import { createFileRoute } from "@tanstack/react-router";

import { GardenTimeline } from "~/app/garden/garden-timeline";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { Page } from "~/components/page/Page";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/garden-entries/")({
  component: GardenEntriesPage,
  errorComponent: RouteErrorComponent,
  head: () => ({ meta: [{ title: pageTitle("Garden entries") }] }),
});
function GardenEntriesPage() {
  return (
    <Page
      variant="list"
      title="Garden entries"
      eyebrow="Garden"
      decoration="none"
    >
      <GardenTimeline />
    </Page>
  );
}
