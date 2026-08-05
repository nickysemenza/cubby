import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import {
  shoppingListSearchDefaults,
  shoppingListSearchSchema,
} from "~/app/meals/meal-search";
import { ShoppingListPage } from "~/app/meals/shopping-list-page";
import { Page } from "~/components/page/Page";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/meals/shopping-list")({
  validateSearch: shoppingListSearchSchema,
  search: { middlewares: [stripSearchParams(shoppingListSearchDefaults)] },
  component: ShoppingListRoute,
  head: () => ({ meta: [{ title: pageTitle("Shopping list") }] }),
});

function ShoppingListRoute() {
  const { from, to } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    <Page variant="list" title="Shopping list" fullWidth>
      <ShoppingListPage
        from={from}
        to={to}
        onRangeChange={(range) =>
          void navigate({
            to: "/meals/shopping-list",
            // Merge, don't replace — a plain object here would drop every other
            // search param (the renderer `view`, and anything added later) on
            // each date change. Same trap meals.index.tsx documents.
            search: (prev) => ({ ...prev, from: range.from, to: range.to }),
            replace: true,
          })
        }
      />
    </Page>
  );
}
