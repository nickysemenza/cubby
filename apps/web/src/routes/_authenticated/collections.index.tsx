import { createFileRoute } from "@tanstack/react-router";

import { Page } from "~/entity/page/page";
import { CollectionsIndexPage } from "~/features/collection/collections-index-page";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/collections/")({
  component: CollectionsRoute,
  head: () => ({ meta: [{ title: pageTitle("Collections") }] }),
});

function CollectionsRoute() {
  return (
    <Page title="Collections" eyebrow="Pantry" layout="full">
      <CollectionsIndexPage />
    </Page>
  );
}
