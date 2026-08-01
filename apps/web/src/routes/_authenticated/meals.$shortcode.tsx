import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { MealDetailPage } from "~/app/meals/meal-detail-page";
import { useTRPC } from "~/integrations/trpc/react";

export const Route = createFileRoute("/_authenticated/meals/$shortcode")({
  ssr: false,
  // The raw route param is validated by the query input schema; the loaded
  // meal then carries the branded public MealShortcode used by the page.
  loader: async ({ params, context }) => {
    const data = await context.queryClient.ensureQueryData(
      context.trpc.meal.getByShortcode.queryOptions({
        shortcode: params.shortcode,
      }),
    );
    if (!data) throw notFound();
  },
  component: MealDetailRoute,
  head: () => ({ meta: [{ title: "Meal | cubby" }] }),
});

function MealDetailRoute() {
  const { shortcode } = Route.useParams();
  const api = useTRPC();
  const { data: meal } = useSuspenseQuery(
    api.meal.getByShortcode.queryOptions({ shortcode }),
  );

  // The loader already threw notFound for an unknown code; this only satisfies
  // the nullable output type.
  if (!meal) return null;

  // MealDetailPage renders its own <Page> shell (title/heroStats depend on the
  // loaded meal), so the route doesn't wrap it.
  return <MealDetailPage mealId={meal.id} />;
}
