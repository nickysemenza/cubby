import { createFileRoute } from "@tanstack/react-router";
import { MealSuggestionsPage } from "~/app/meals/suggestions-page";
import { EntityLayout } from "~/components/layouts/entity-layout";

export const Route = createFileRoute("/_authenticated/meals/suggestions")({
  component: MealsSuggestionsRoute,
  head: () => ({ meta: [{ title: "What can I make? | cubby" }] }),
});

function MealsSuggestionsRoute() {
  return (
    <EntityLayout title="What can I make?" fullWidth>
      <MealSuggestionsPage />
    </EntityLayout>
  );
}
