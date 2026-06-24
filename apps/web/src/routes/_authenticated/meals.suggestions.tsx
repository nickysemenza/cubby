import { createFileRoute } from "@tanstack/react-router";
import { MealSuggestionsPage } from "~/app/meals/suggestions-page";
import { Page } from "~/components/page/Page";

export const Route = createFileRoute("/_authenticated/meals/suggestions")({
  component: MealsSuggestionsRoute,
  head: () => ({ meta: [{ title: "What can I make? | cubby" }] }),
});

function MealsSuggestionsRoute() {
  return (
    <Page variant="list" title="What can I make?" fullWidth>
      <MealSuggestionsPage />
    </Page>
  );
}
