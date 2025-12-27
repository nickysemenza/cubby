import { createFileRoute } from "@tanstack/react-router";
import { NewProduct } from "~/app/_components/products/new-product";
import { PageWrapper } from "~/components/layout/page-wrapper";

export const Route = createFileRoute("/products/new")({
  component: NewProductPage,
});

function NewProductPage() {
  return (
    <PageWrapper>
      <NewProduct />
    </PageWrapper>
  );
}
