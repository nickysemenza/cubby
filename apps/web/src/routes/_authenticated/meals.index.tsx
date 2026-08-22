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
import {
  mealCalendarSearchDefaults,
  mealCalendarSearchSchema,
} from "~/app/meals/meal-search";
import { Page } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import { ViewSwitcher } from "~/components/ui/view-switcher";
import { mealCaptureRequest } from "~/entities/editing/editor-requests";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/meals/")({
  validateSearch: mealCalendarSearchSchema,
  search: { middlewares: [stripSearchParams(mealCalendarSearchDefaults)] },
  component: MealsIndexRoute,
  head: () => ({ meta: [{ title: pageTitle("Meals") }] }),
});

function MealsIndexRoute() {
  const search = Route.useSearch();
  const { period, view, week } = search;
  const navigate = useNavigate({ from: Route.fullPath });
  const routeView = view ?? "calendar";

  return (
    <Page
      variant="list"
      listChrome="workbench"
      title="Meals"
      layout="full"
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
    </Page>
  );
}
