import {
  createFileRoute,
  Link,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { Plus } from "lucide-react";

import { listPage } from "~/app/_components/routing/entity-routes";
import {
  PRODUCT_VIEW_OPTIONS,
  ProductList,
  type ProductListView,
} from "~/app/products/productlist";
import { Button } from "~/components/ui/button";
import { ViewSwitcher } from "~/components/ui/view-switcher";
import { ensureEntityListSsr } from "~/entities/entity-list-ssr";
import {
  productSearchDefaults,
  productSearchSchema,
} from "~/entities/list-search";
import { pageTitle } from "~/lib/page-title";

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
