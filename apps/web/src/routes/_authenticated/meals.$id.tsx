import { unsafeMealId } from "@cubby/schemas/identifiers";
import { createFileRoute } from "@tanstack/react-router";
import { MealDetailPage } from "~/app/meals/meal-detail-page";

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
  // MealDetailPage renders its own <Page> shell (title/heroStats depend on the
  // loaded meal), so the route doesn't wrap it.
  return <MealDetailPage mealId={id} />;
}
