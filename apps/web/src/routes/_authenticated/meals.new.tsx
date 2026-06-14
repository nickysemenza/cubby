import { createFileRoute } from "@tanstack/react-router";
import { MealNewPage } from "~/app/meals/meal-new-page";
import { EntityLayout } from "~/components/layouts/entity-layout";

export const Route = createFileRoute("/_authenticated/meals/new")({
  component: MealNewRoute,
  head: () => ({ meta: [{ title: "New Meal | cubby" }] }),
});

function MealNewRoute() {
  return (
    <EntityLayout title="New Meal" entity="meal">
      <MealNewPage />
    </EntityLayout>
  );
}
