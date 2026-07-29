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
import { entityFilterSearchFields } from "~/entities/filter-manifest";

const searchSchema = z.object({
  category: z.string().optional().catch(undefined),
  ...tableSearchFields,
  ...entityFilterSearchFields("product"),
  // `entityFilterSearchFields` returns a `Record<string, …>`, so its keys are
  // not statically known to `<Link search={…}>`. Re-declaring the one key we
  // navigate to programmatically (the "Fits With" tag chips) with the identical
  // shape makes those links type-safe without duplicating the manifest.
  tags: z.string().optional().catch(undefined),
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
    <Page variant="list" title="Products" fullWidth>
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
