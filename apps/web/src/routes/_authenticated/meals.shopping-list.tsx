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
  const navigate = useNavigate();

  return (
    <Page variant="list" title="Shopping list" fullWidth>
      <ShoppingListPage
        from={from}
        to={to}
        onRangeChange={(range) =>
          void navigate({
            to: "/meals/shopping-list",
            search: {
              from: range.from,
              to: range.to,
            },
            replace: true,
          })
        }
      />
    </Page>
  );
}
