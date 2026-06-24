import {
  createFileRoute,
  Link,
  stripSearchParams,
} from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { z } from "zod";
import { ProductList } from "~/app/products/productlist";
import { EntityLayout } from "~/components/layouts/entity-layout";
import { Button } from "~/components/ui/button";

const searchSchema = z.object({
  category: z.string().optional().catch(undefined),
});

const searchDefaults = { category: undefined } as const;

export const Route = createFileRoute("/_authenticated/products/")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  component: ProductsPage,
  head: () => ({ meta: [{ title: "Products | cubby" }] }),
});

function ProductsPage() {
  const { category } = Route.useSearch();

  return (
    <EntityLayout title="Products" fullWidth>
      <ProductList
        initialCategory={category}
        actions={
          <Link to="/products/new">
            <Button>
              <Plus />
              New
            </Button>
          </Link>
        }
      />
    </EntityLayout>
  );
}
