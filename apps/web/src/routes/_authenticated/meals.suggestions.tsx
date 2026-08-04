import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import {
  mealSuggestionsSearchDefaults,
  mealSuggestionsSearchSchema,
} from "~/app/meals/meal-search";
import { MealSuggestionsPage } from "~/app/meals/suggestions-page";
import { Page } from "~/components/page/Page";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/meals/suggestions")({
  validateSearch: mealSuggestionsSearchSchema,
  search: { middlewares: [stripSearchParams(mealSuggestionsSearchDefaults)] },
  component: MealsSuggestionsRoute,
  head: () => ({ meta: [{ title: pageTitle("What can I make?") }] }),
});

function MealsSuggestionsRoute() {
  const { filter } = Route.useSearch();
  const navigate = useNavigate();

  return (
    <Page variant="list" title="What can I make?" fullWidth>
      <MealSuggestionsPage
        filter={filter ?? "all"}
        onFilterChange={(nextFilter) =>
          void navigate({
            to: "/meals/suggestions",
            search: {
              filter: nextFilter === "all" ? undefined : nextFilter,
            },
            replace: true,
          })
        }
      />
    </Page>
  );
}
