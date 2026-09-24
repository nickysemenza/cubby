import { GridNineIcon as Grid3x3 } from "@phosphor-icons/react/dist/csr/GridNine";
import { ListIcon as List } from "@phosphor-icons/react/dist/csr/List";
import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";

import {
  parseExcludedMeals,
  type ShoppingListView,
  serializeExcludedMeals,
  shoppingListSearchDefaults,
  shoppingListSearchSchema,
} from "~/app/meals/meal-search";
import { ShoppingListPage } from "~/app/meals/shopping-list-page";
import { Page } from "~/components/page/Page";
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";
import { pageTitle } from "~/lib/page-title";

const VIEW_OPTIONS: ViewSwitcherOption<ShoppingListView>[] = [
  { value: "list", label: "List", icon: List },
  { value: "matrix", label: "Matrix", icon: Grid3x3 },
];

export const Route = createFileRoute("/_authenticated/meals/shopping-list")({
  validateSearch: shoppingListSearchSchema,
  search: { middlewares: [stripSearchParams(shoppingListSearchDefaults)] },
  component: ShoppingListRoute,
  head: () => ({ meta: [{ title: pageTitle("Shopping list") }] }),
});

function ShoppingListRoute() {
  const { view, from, to, excluded } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    <Page
      variant="list"
      title="Shopping list"
      layout="full"
      actions={
        <ViewSwitcher
          ariaLabel="Shopping list view"
          options={VIEW_OPTIONS}
          value={view ?? "list"}
          onValueChange={(next) =>
            void navigate({
              to: "/meals/shopping-list",
              // The default maps to undefined so stripSearchParams keeps a
              // plain link clean, same convention as meals.index.tsx.
              search: (prev) => ({
                ...prev,
                view: next === "list" ? undefined : next,
              }),
              replace: true,
            })
          }
        />
      }
    >
      <ShoppingListPage
        view={view ?? "list"}
        from={from}
        to={to}
        excluded={parseExcludedMeals(excluded)}
        onExcludedChange={(next) =>
          void navigate({
            to: "/meals/shopping-list",
            search: (prev) => ({
              ...prev,
              // Empty maps to undefined so stripSearchParams keeps `?excluded=`
              // out of a link where nothing is hidden.
              excluded:
                next.size === 0 ? undefined : serializeExcludedMeals(next),
            }),
            replace: true,
          })
        }
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
