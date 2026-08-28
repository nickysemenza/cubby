import { createFileRoute } from "@tanstack/react-router";

import { CollectionsIndexPage } from "~/app/collections/collections-index-page";
import { Page } from "~/components/page/Page";
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
