import type { ProductCreateInput } from "@cubby/schemas/product";
import { createFileRoute } from "@tanstack/react-router";

import { ProductForm } from "~/app/_components/products/product-form";
import { Page } from "~/components/page/Page";
import { useEntityCreateController } from "~/entities/editing/use-entity-create-controller";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/products/new")({
  head: () => ({ meta: [{ title: pageTitle("New product") }] }),
  component: NewProductPage,
});

function NewProductPage() {
  const { error, isPending, submit, cancel } = useEntityCreateController<
    "product",
    ProductCreateInput
  >("product");
  return (
    <Page variant="list" title="New product" compact>
      <ProductForm
        mode="create"
        isPending={isPending}
        error={error}
        onCreate={submit}
        onCancel={cancel}
      />
    </Page>
  );
}
