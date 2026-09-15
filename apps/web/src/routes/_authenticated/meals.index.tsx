import {
  createFileRoute,
  Link,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { ShoppingCart } from "lucide-react";

import { CreateDialogAction } from "~/app/_components/forms/create-dialog-action";
// Meal planning calendar (month overview and weekly focus).
import { MEAL_VIEW_OPTIONS, MealCalendarPage } from "~/app/meals/calendar-page";
import { DailyNutrition } from "~/app/meals/daily-nutrition";
import {
  mealCalendarSearchDefaults,
  mealCalendarSearchSchema,
} from "~/app/meals/meal-search";
import { meal } from "~/app/meals/meal.functions";
import { Page } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import { ViewSwitcher } from "~/components/ui/view-switcher";
import { mealCaptureRequest } from "~/entities/editing/editor-requests";
import { ensureEntityListSsr } from "~/entities/entity-list-ssr";
import { householdLocalDate } from "~/lib/household-date";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/meals/")({
  validateSearch: mealCalendarSearchSchema,
  search: { middlewares: [stripSearchParams(mealCalendarSearchDefaults)] },
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps, abortController }) => {
    const today = householdLocalDate();
    if (deps.view === "nutrition")
      await context.queryClient.ensureQueryData(
        meal.getNutrition.queryOptions({ date: deps.date ?? today }),
      );
    await ensureEntityListSsr({
      queryClient: context.queryClient,
      entity: "meal",
      search: deps,
      active: deps.view === "table",
      signal: abortController.signal,
    });
    return { today };
  },
  component: MealsIndexRoute,
  head: () => ({ meta: [{ title: pageTitle("Meals") }] }),
});

function MealsIndexRoute() {
  const search = Route.useSearch();
  const { today } = Route.useLoaderData();
  const { period, view, week } = search;
  const navigate = useNavigate({ from: Route.fullPath });
  const routeView = view ?? "calendar";

  return (
    <Page
      variant="list"
      listChrome="workbench"
      title="Meals"
      layout="full"
      bodyGutter={routeView === "table" ? "none" : "standard"}
      workbenchControls={
        <ViewSwitcher
          ariaLabel="Meals view"
          options={MEAL_VIEW_OPTIONS}
          value={routeView}
          onValueChange={(nextView) =>
            void navigate({
              to: "/meals",
              search: (prev) => ({
                ...prev,
                view: nextView === "calendar" ? undefined : nextView,
              }),
              replace: true,
            })
          }
        />
      }
      actions={
        <>
          <Link to="/meals/shopping-list">
            <Button type="button" variant="outline" size="sm">
              <ShoppingCart />
              Shopping list
            </Button>
          </Link>
          <CreateDialogAction request={mealCaptureRequest()} />
        </>
      }
    >
      {routeView === "nutrition" ? (
        <DailyNutrition
          date={search.date}
          initialToday={today}
          onDateChange={(date) =>
            void navigate({
              to: "/meals",
              search: (prev) => ({ ...prev, date }),
              replace: true,
            })
          }
        />
      ) : (
        <MealCalendarPage
          view={routeView}
          period={period ?? "month"}
          week={week}
          onWeekChange={(nextWeek) =>
            void navigate({
              to: "/meals",
              search: (prev) => ({ ...prev, week: nextWeek }),
              replace: true,
            })
          }
          onPeriodChange={(nextPeriod) =>
            void navigate({
              to: "/meals",
              search: (prev) => ({
                ...prev,
                period: nextPeriod === "month" ? undefined : nextPeriod,
              }),
              replace: true,
            })
          }
        />
      )}
    </Page>
  );
}
