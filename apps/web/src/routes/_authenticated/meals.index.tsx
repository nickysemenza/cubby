import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
// Meal planning calendar (week view).
import { MealCalendarPage } from "~/app/meals/calendar-page";
import { MealActions } from "~/app/meals/meal-actions";
import {
  mealCalendarSearchDefaults,
  mealCalendarSearchSchema,
} from "~/app/meals/meal-search";
import { Page } from "~/components/page/Page";

export const Route = createFileRoute("/_authenticated/meals/")({
  validateSearch: mealCalendarSearchSchema,
  search: { middlewares: [stripSearchParams(mealCalendarSearchDefaults)] },
  component: MealsIndexRoute,
  head: () => ({ meta: [{ title: "Meals | cubby" }] }),
});

function MealsIndexRoute() {
  const { view, week } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const routeView = view ?? "calendar";

  return (
    <Page variant="list" title="Meals" fullWidth actions={<MealActions />}>
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
