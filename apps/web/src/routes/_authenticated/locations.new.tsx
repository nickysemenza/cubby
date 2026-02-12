import { createFileRoute } from "@tanstack/react-router";
import { NewEntityPage } from "~/components/entity/new-entity-page";
import { PageWrapper } from "~/components/layout/page-wrapper";

export const Route = createFileRoute("/_authenticated/locations/new")({
  component: NewLocationPage,
});

function NewLocationPage() {
  return (
    <PageWrapper>
      <NewEntityPage entity="location" />
    </PageWrapper>
  );
}
