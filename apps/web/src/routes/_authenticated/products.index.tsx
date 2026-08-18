import { plainDate } from "@cubby/schemas/project";
import {
  createFileRoute,
  Link,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { z } from "zod";
import { tableSearchFields } from "~/app/_components/data-table/table-search";
import { ProductList, type ProductListView } from "~/app/products/productlist";
import { Page } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import {
  entityFilterSearchFields,
  routeFilterValues,
} from "~/entities/filter-search-fields";
import { pageTitle } from "~/lib/page-title";
import {
  urlEnumListParam,
  urlShortcodeListParam,
  urlStringParam,
} from "~/lib/search-params";

const productListView = z.enum(["table", "shelf", "events", "lifecycles"]);

export const productSearchSchema = z.object({
  view: productListView.optional().catch(undefined),
  movementFrom: plainDate.optional().catch(undefined),
  movementTo: plainDate.optional().catch(undefined),
  movementOrder: z.enum(["asc", "desc"]).optional().catch(undefined),
  ...tableSearchFields,
  ...entityFilterSearchFields("product"),
  category: urlEnumListParam(z.enum(routeFilterValues.productCategory)),
  // `entityFilterSearchFields` returns a `Record<string, …>`, so its keys are
  // not statically known to `<Link search={…}>`. Re-declaring the keys we
  // navigate to programmatically (the "Fits With" tag chips; the Problems
  // page's manufacturer-spelling cards) with the identical shape makes those
  // links type-safe without duplicating the manifest. `urlStringParam`, not a
  // bare `z.string()` — these sit after the spread and override it, so a plain
  // string schema would reinstate the silently-dropped-value hole.
  tags: urlStringParam,
  manufacturer: urlStringParam,
  model: urlStringParam,
  ingredient: urlShortcodeListParam("ING"),
});

const searchDefaults = {
  category: undefined,
  view: undefined,
  movementFrom: undefined,
  movementTo: undefined,
  movementOrder: undefined,
} as const;

export const Route = createFileRoute("/_authenticated/products/")({
  validateSearch: productSearchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  component: ProductsPage,
  head: () => ({ meta: [{ title: pageTitle("Products") }] }),
});

function ProductsPage() {
  const { category, view } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const activeView: ProductListView = view ?? "table";

  return (
    <Page variant="list" title="Products" fullWidth>
      <ProductList
        initialCategory={category}
        view={activeView}
        onViewChange={(nextView) =>
          navigate({
            search: (previous) => ({
              ...previous,
              view: nextView === "table" ? undefined : nextView,
            }),
          })
        }
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
