import { createFileRoute } from "@tanstack/react-router";
import { Page } from "~/components/page/Page";
import { EntityEditPage } from "~/entities/editing";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/locations/new")({
  head: () => ({ meta: [{ title: pageTitle("New location") }] }),
  component: NewLocationPage,
});

function NewLocationPage() {
  return (
    <Page variant="list" title="New location" compact>
      <EntityEditPage entity="location" />
    </Page>
  );
}
