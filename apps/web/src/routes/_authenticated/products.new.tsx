import { createFileRoute } from "@tanstack/react-router";
import { NewEntityPage } from "~/components/entity/new-entity-page";
import { PageWrapper } from "~/components/layout/page-wrapper";

export const Route = createFileRoute("/_authenticated/products/new")({
  component: NewProductPage,
});

function NewProductPage() {
  return (
    <PageWrapper>
      <NewEntityPage entity="product" />
    </PageWrapper>
  );
}
