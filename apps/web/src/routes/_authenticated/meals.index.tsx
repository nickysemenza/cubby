import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
// Meal planning calendar (week view).
import { MealCalendarPage } from "~/app/meals/calendar-page";
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
  const navigate = useNavigate();
  const routeView = view ?? "calendar";
  const normalizedView = routeView === "calendar" ? undefined : routeView;

  return (
    <Page variant="list" title="Meals" fullWidth>
      <MealCalendarPage
        view={routeView}
        week={week}
        onViewChange={(nextView) =>
          void navigate({
            to: "/meals",
            search: {
              view: nextView === "calendar" ? undefined : nextView,
              week,
            },
            replace: true,
          })
        }
        onWeekChange={(nextWeek) =>
          void navigate({
            to: "/meals",
            search: { view: normalizedView, week: nextWeek },
            replace: true,
          })
        }
      />
    </Page>
  );
}
