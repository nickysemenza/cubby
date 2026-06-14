import { createFileRoute } from "@tanstack/react-router";
// Meal planning calendar (week view).
import { MealCalendarPage } from "~/app/meals/calendar-page";
import { EntityLayout } from "~/components/layouts/entity-layout";

export const Route = createFileRoute("/_authenticated/meals/")({
  component: MealsIndexRoute,
  head: () => ({ meta: [{ title: "Meals | cubby" }] }),
});

function MealsIndexRoute() {
  return (
    <EntityLayout title="Meals" fullWidth>
      <MealCalendarPage />
    </EntityLayout>
  );
}
