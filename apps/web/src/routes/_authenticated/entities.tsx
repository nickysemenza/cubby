import { createFileRoute } from "@tanstack/react-router";
import { EntityManifestGrid } from "~/app/_components/entities/EntityManifestGrid";
import { Page } from "~/components/page/Page";

export const Route = createFileRoute("/_authenticated/entities")({
  component: EntitiesRoute,
  head: () => ({ meta: [{ title: "Entities | cubby" }] }),
});

function EntitiesRoute() {
  return (
    <Page variant="list" title="Entities" compact decoration="none">
      <EntityManifestGrid />
    </Page>
  );
}
