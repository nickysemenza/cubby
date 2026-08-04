import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { CreateDialogAction } from "~/app/_components/forms/create-dialog-action";
// Meal planning calendar (week view).
import { MealCalendarPage } from "~/app/meals/calendar-page";
import { CreateMealDialog } from "~/app/meals/create-meal-dialog";
import {
  mealCalendarSearchDefaults,
  mealCalendarSearchSchema,
} from "~/app/meals/meal-search";
import { Page } from "~/components/page/Page";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/meals/")({
  validateSearch: mealCalendarSearchSchema,
  search: { middlewares: [stripSearchParams(mealCalendarSearchDefaults)] },
  component: MealsIndexRoute,
  head: () => ({ meta: [{ title: pageTitle("Meals") }] }),
});

function MealsIndexRoute() {
  const { view, week } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const routeView = view ?? "calendar";

  return (
    <Page
      variant="list"
      title="Meals"
      fullWidth
      actions={<CreateDialogAction Dialog={CreateMealDialog} />}
    >
      <MealCalendarPage
        view={routeView}
        week={week}
        onViewChange={(nextView) =>
          // Merge, don't replace — a plain object here would drop the Table
          // view's sort/page/filter search params (and any other in-flight
          // search state) on every view switch. See tasks.index.tsx.
          void navigate({
            to: "/meals",
            search: (prev) => ({
              ...prev,
              view: nextView === "calendar" ? undefined : nextView,
            }),
            replace: true,
          })
        }
        onWeekChange={(nextWeek) =>
          void navigate({
            to: "/meals",
            search: (prev) => ({ ...prev, week: nextWeek }),
            replace: true,
          })
        }
      />
    </Page>
  );
}
