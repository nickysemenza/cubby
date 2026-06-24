import { createFileRoute } from "@tanstack/react-router";
// Meal planning calendar (week view).
import { MealCalendarPage } from "~/app/meals/calendar-page";
import { Page } from "~/components/page/Page";

export const Route = createFileRoute("/_authenticated/meals/")({
  component: MealsIndexRoute,
  head: () => ({ meta: [{ title: "Meals | cubby" }] }),
});

function MealsIndexRoute() {
  return (
    <Page variant="list" title="Meals" entity="meal" fullWidth>
      <MealCalendarPage />
    </Page>
  );
}
