import { createFileRoute } from "@tanstack/react-router";
import { NewEntityPage } from "~/components/entity/new-entity-page";
import { Page } from "~/components/page/Page";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/products/new")({
  head: () => ({ meta: [{ title: pageTitle("New product") }] }),
  component: NewProductPage,
});

function NewProductPage() {
  return (
    <Page variant="list" title="New product" compact>
      <NewEntityPage entity="product" />
    </Page>
  );
}
