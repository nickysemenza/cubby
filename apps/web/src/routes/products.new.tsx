import { createFileRoute } from "@tanstack/react-router";
import { NewEntityPage } from "~/components/entity/new-entity-page";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { authMiddleware } from "~/lib/protected-route";

export const Route = createFileRoute("/products/new")({
  component: NewProductPage,
  server: {
    middleware: [authMiddleware],
  },
});

function NewProductPage() {
  return (
    <PageWrapper>
      <NewEntityPage entity="product" />
    </PageWrapper>
  );
}
