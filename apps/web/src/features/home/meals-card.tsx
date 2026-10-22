import { MEAL_TYPE_LABELS } from "@cubby/schemas/meal-classification";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { format, parseISO } from "date-fns";

import { actionsForSurface } from "~/entity/actions/action-items";
import { entities, entityDetailParams } from "~/entity/entities";
import { mealListLabel } from "~/features/meal/meal-format";
import { meal } from "~/integrations/tanstack-query/generated/catalog/meal.gen";
import { EmptyState } from "~/ui/feedback/empty-state";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Section } from "~/ui/layout";

import type { HomeAsOfWindow } from "./home-as-of-window";
import { HomeList, HomeRow, HomeRowsLoading } from "./home-list";

export interface TodayMealsOperations {
  upcomingSummary: typeof meal.upcomingSummary;
}

const MEAL_ROWS = 5;

/** The recurring meal verbs: "What can I make?" and the shopping list. */
const mealActions = actionsForSurface("home-quick");

/**
 * Home's Meals rail: what's planned between today and a week out, read from a
 * bounded projection over the calendar's canonical date ordering.
 *
 * The date window is computed once in the household timezone by the route
 * loader, so SSR and hydration use the same query key and the same "today".
 */
export function TodayMeals({
  asOf,
  operations,
}: {
  asOf: HomeAsOfWindow;
  /** Replaces the upcoming-summary transport for a local browser host. */
  operations?: TodayMealsOperations;
}) {
  const upcomingSummary = operations?.upcomingSummary ?? meal.upcomingSummary;
  const mealsQuery = useQuery(upcomingSummary.queryOptions(asOf.meals));
  const meals = mealsQuery.data ?? [];
  const later = meals.length - MEAL_ROWS;
  return (
    <Section
      title="Meals"
      headingAs="h2"
      ruled
      actions={<Link to="/meals">Plan</Link>}
    >
      {mealsQuery.isError ? (
        <ErrorDisplay
          error={mealsQuery.error}
          title="meals"
          onRetry={() => void mealsQuery.refetch()}
          className="mt-2"
        />
      ) : mealsQuery.data === undefined ? (
        <HomeRowsLoading label="Loading meals" rows={2} />
      ) : meals.length === 0 ? (
        <EmptyState size="inline" className="mt-2">
          Nothing planned this week. <Link to="/meals">Plan a meal</Link>.
        </EmptyState>
      ) : (
        <HomeList label="Meals ahead">
          {meals.slice(0, MEAL_ROWS).map((item) => {
            const label = mealListLabel(item);
            const slot = item.mealType ? MEAL_TYPE_LABELS[item.mealType] : null;
            return (
              <HomeRow
                key={item.id}
                leading={
                  item.date === asOf.meals.from
                    ? "Today"
                    : format(parseISO(item.date), "EEE")
                }
              >
                <Link
                  to={entities.meal.routes.detail}
                  params={entityDetailParams(item.id)}
                  title={label}
                  className="truncate underline-offset-2 outline-none hover:text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {slot && slot !== label ? `${slot} · ${label}` : label}
                </Link>
              </HomeRow>
            );
          })}
        </HomeList>
      )}
      <p className="flex flex-wrap gap-x-3 pt-2 text-xs text-muted-foreground [&>a]:inline-flex [&>a]:items-center [&>a]:hover:text-foreground [&>a]:hover:underline [&>a]:max-md:min-h-11">
        {later > 0 && <span>{later} more this week</span>}
        {mealActions.map((action) => (
          <Link key={action.id} to={action.path} search={action.search}>
            {action.name}
          </Link>
        ))}
      </p>
    </Section>
  );
}
