import { createFileRoute } from "@tanstack/react-router";
import { Page } from "~/components/page/Page";
import { EntityEditPage } from "~/entities/editing";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/products/new")({
  head: () => ({ meta: [{ title: pageTitle("New product") }] }),
  component: NewProductPage,
});

function NewProductPage() {
  return (
    <Page variant="list" title="New product" compact>
      <EntityEditPage entity="product" />
    </Page>
  );
}
