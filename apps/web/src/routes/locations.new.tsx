import { createFileRoute } from "@tanstack/react-router";
import { NewEntityPage } from "~/components/entity/new-entity-page";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { authMiddleware } from "~/lib/protected-route";

export const Route = createFileRoute("/locations/new")({
  component: NewLocationPage,
  server: {
    middleware: [authMiddleware],
  },
});

function NewLocationPage() {
  return (
    <PageWrapper>
      <NewEntityPage entity="location" />
    </PageWrapper>
  );
}
