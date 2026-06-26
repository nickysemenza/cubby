import { createFileRoute } from "@tanstack/react-router";
import { NewEntityPage } from "~/components/entity/new-entity-page";
import { Page } from "~/components/page/Page";

export const Route = createFileRoute("/_authenticated/locations/new")({
  component: NewLocationPage,
});

function NewLocationPage() {
  return (
    <Page variant="list" title="New location" entity="location" compact>
      <NewEntityPage entity="location" />
    </Page>
  );
}
