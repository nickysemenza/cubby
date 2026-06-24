import { unsafeMealId } from "@cubby/schemas/identifiers";
import { createFileRoute } from "@tanstack/react-router";
import { MealDetailPage } from "~/app/meals/meal-detail-page";
import { Page } from "~/components/page/Page";

export const Route = createFileRoute("/_authenticated/meals/$id")({
  // Brand the path param at the boundary so it's a `MealId` throughout.
  params: {
    parse: (raw) => ({ id: unsafeMealId(raw.id) }),
    stringify: (params) => ({ id: params.id }),
  },
  component: MealDetailRoute,
  head: () => ({ meta: [{ title: "Meal | cubby" }] }),
});

function MealDetailRoute() {
  const id = Route.useParams().id;
  return (
    <Page variant="list" title="Meal" entity="meal">
      <MealDetailPage mealId={id} />
    </Page>
  );
}
