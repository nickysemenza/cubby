import { plainDate } from "@cubby/schemas/project";
import {
  createFileRoute,
  Link,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { z } from "zod";

import { listPage } from "~/app/_components/routing/entity-routes";
import {
  PRODUCT_VIEW_OPTIONS,
  ProductList,
  type ProductListView,
} from "~/app/products/productlist";
import { Button } from "~/components/ui/button";
import { ViewSwitcher } from "~/components/ui/view-switcher";
import { ensureEntityListSsr } from "~/entities/entity-list-ssr";
import { entitySearch } from "~/entities/generated/entity-search.gen";
import { pageTitle } from "~/lib/page-title";

const PRODUCT_LIST_VIEWS = ["table", "shelf", "events", "lifecycles"] as const;

// Route-only keys on top of the generated product search: the renderer and
// the movement window the events/lifecycles views read.
const productSearchSchema = z.object({
  ...entitySearch.product.schema.shape,
  view: z.enum(PRODUCT_LIST_VIEWS).optional().catch(undefined),
  movementFrom: plainDate.optional().catch(undefined),
  movementTo: plainDate.optional().catch(undefined),
  movementOrder: z.enum(["asc", "desc"]).optional().catch(undefined),
});
const productSearchDefaults = {
  ...entitySearch.product.defaults,
  view: undefined,
  movementFrom: undefined,
  movementTo: undefined,
  movementOrder: undefined,
};

function useProductsView(): ProductListView {
  const { view } = Route.useSearch();
  return view ?? "table";
}

function ProductsListBody() {
  const { category } = Route.useSearch();
  return <ProductList initialCategory={category} view={useProductsView()} />;
}

function ProductsWorkbenchControls() {
  const activeView = useProductsView();
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    <ViewSwitcher
      ariaLabel="Products view"
      options={PRODUCT_VIEW_OPTIONS}
      value={activeView}
      compactOnMobile
      onValueChange={(nextView) =>
        navigate({
          search: (previous) => ({
            ...previous,
            view: nextView === "table" ? undefined : nextView,
          }),
        })
      }
    />
  );
}

// Table stays flush to the viewport edge; every other renderer wants the
// standard gutter.
function useProductsBodyGutter(): "none" | "standard" {
  return useProductsView() === "table" ? "none" : "standard";
}

// Bound to a const, not inlined into the options object: see the splitter
// note atop `entity-routes.tsx`.
const ProductsPage = listPage({
  title: "Products",
  list: ProductsListBody,
  workbenchControls: () => <ProductsWorkbenchControls />,
  bodyGutter: useProductsBodyGutter,
  actions: () => (
    <Link to="/products/new">
      <Button>
        <Plus />
        New
      </Button>
    </Link>
  ),
});

export const Route = createFileRoute("/_authenticated/products/")({
  validateSearch: productSearchSchema,
  search: { middlewares: [stripSearchParams(productSearchDefaults)] },
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps, abortController }) =>
    ensureEntityListSsr({
      queryClient: context.queryClient,
      entity: "product",
      search: deps,
      signal: abortController.signal,
    }),
  component: ProductsPage,
  head: () => ({ meta: [{ title: pageTitle("Products") }] }),
});
