import { createFileRoute } from "@tanstack/react-router";
import { MealNewPage } from "~/app/meals/meal-new-page";
import { Page } from "~/components/page/Page";

export const Route = createFileRoute("/_authenticated/meals/new")({
  component: MealNewRoute,
  head: () => ({ meta: [{ title: "New Meal | cubby" }] }),
});

function MealNewRoute() {
  return (
    <Page variant="list" title="New Meal">
      <MealNewPage />
    </Page>
  );
}
