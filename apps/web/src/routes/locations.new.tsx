import { createFileRoute } from "@tanstack/react-router";
import { NewLocation } from "~/app/_components/locations/new-location";
import { PageWrapper } from "~/components/layout/page-wrapper";

export const Route = createFileRoute("/locations/new")({
  component: NewLocationPage,
});

function NewLocationPage() {
  return (
    <PageWrapper>
      <NewLocation />
    </PageWrapper>
  );
}
