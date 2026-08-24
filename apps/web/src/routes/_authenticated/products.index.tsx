import {
  createFileRoute,
  Link,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { Plus } from "lucide-react";
import {
  PRODUCT_VIEW_OPTIONS,
  ProductList,
  type ProductListView,
} from "~/app/products/productlist";
import { Page } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import { ViewSwitcher } from "~/components/ui/view-switcher";
import {
  productSearchDefaults,
  productSearchSchema,
} from "~/entities/list-search";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/products/")({
  validateSearch: productSearchSchema,
  search: { middlewares: [stripSearchParams(productSearchDefaults)] },
  component: ProductsPage,
  head: () => ({ meta: [{ title: pageTitle("Products") }] }),
});

function ProductsPage() {
  const { category, view } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const activeView: ProductListView = view ?? "table";

  return (
    <Page
      variant="list"
      listChrome="workbench"
      title="Products"
      layout="full"
      workbenchControls={
        <ViewSwitcher
          ariaLabel="Products view"
          options={PRODUCT_VIEW_OPTIONS}
          value={activeView}
          onValueChange={(nextView) =>
            navigate({
              search: (previous) => ({
                ...previous,
                view: nextView === "table" ? undefined : nextView,
              }),
            })
          }
        />
      }
      actions={
        <Link to="/products/new">
          <Button>
            <Plus />
            New
          </Button>
        </Link>
      }
    >
      <ProductList initialCategory={category} view={activeView} />
    </Page>
  );
}
