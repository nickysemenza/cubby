import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
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
    <EntityLayout title="Products">
      <ProductList
        initialCategory={category}
        actions={
          <Link to="/products/new">
            <Button size="sm" className="h-7 gap-1 text-xs">
              <Plus className="h-3.5 w-3.5" />
              New
            </Button>
          </Link>
        }
      />
    </EntityLayout>
  );
}
