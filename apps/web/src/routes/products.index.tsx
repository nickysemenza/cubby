import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { ProductList } from "~/app/products/productlist";
import { EntityLayout } from "~/components/layouts/entity-layout";
import { Button } from "~/components/ui/button";

const searchSchema = z.object({
  category: z.string().optional(),
});

export const Route = createFileRoute("/products/")({
  validateSearch: searchSchema,
  component: ProductsPage,
  head: () => ({ meta: [{ title: "Products | RecipeHub" }] }),
});

function ProductsPage() {
  const { category } = Route.useSearch();

  return (
    <EntityLayout
      title="Products"
      actions={
        <Link to="/products/new">
          <Button>Create New Product</Button>
        </Link>
      }
    >
      <ProductList initialCategory={category} />
    </EntityLayout>
  );
}
