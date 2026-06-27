import {
  createFileRoute,
  Link,
  stripSearchParams,
} from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { z } from "zod";
import { tableSearchFields } from "~/app/_components/data-table/table-search";
import { ProductList } from "~/app/products/productlist";
import { Page } from "~/components/page/Page";
import { Button } from "~/components/ui/button";

const searchSchema = z.object({
  category: z.string().optional().catch(undefined),
  ...tableSearchFields,
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
    <Page variant="list" title="Products" entity="product" fullWidth>
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
    </Page>
  );
}
