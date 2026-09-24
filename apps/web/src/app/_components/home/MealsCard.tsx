import { MEAL_KIND_LABELS } from "@cubby/schemas/meal-classification";
import { ForkKnifeIcon } from "@phosphor-icons/react/dist/csr/ForkKnife";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { format, isSameDay, parseISO } from "date-fns";
import { useId } from "react";

import { formatMealCost, mealListLabel } from "~/app/meals/meal-format";
import { mealKindIcon, mealTypeIcon } from "~/app/meals/meal-options";
import { meal } from "~/app/meals/meal.functions";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";

import type { HomeAsOfWindow } from "./home-as-of-window";

export interface TodayMealsOperations {
  upcomingSummary: typeof meal.upcomingSummary;
}

/**
 * Home-page meals tile: what's planned between today and a week out, read from
 * a bounded projection over the calendar's canonical date ordering.
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
  const titleId = useId();
  const today = parseISO(asOf.meals.from);
  const upcomingSummary = operations?.upcomingSummary ?? meal.upcomingSummary;
  const mealsQuery = useQuery(upcomingSummary.queryOptions(asOf.meals));
  const meals = mealsQuery.data ?? [];

  return (
    <section aria-labelledby={titleId} className="min-w-0">
      <div className="flex items-start justify-between gap-3 border-b border-border pb-2">
        <div className="flex min-w-0 items-start gap-2">
          <ForkKnifeIcon
            className="mt-0.5 size-4 shrink-0 text-slate"
            aria-hidden
          />
          <div className="min-w-0">
            <h2 id={titleId} className="font-heading text-base font-semibold">
              Meals ahead
            </h2>
            <p className="text-xs text-muted-foreground">
              The next seven days.
            </p>
          </div>
        </div>
        <Button
          render={<Link to="/meals" />}
          nativeButton={false}
          variant="ghost"
          size="sm"
          className="h-11 shrink-0 text-xs sm:h-7"
        >
          Calendar
        </Button>
      </div>

      <Stack gap="xs" className="mt-2">
        {mealsQuery.isLoading ? (
          <>
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-3/4" />
          </>
        ) : mealsQuery.isError ? (
          <div className="flex min-h-16 items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              Meals are unavailable right now.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 shrink-0 sm:min-h-0"
              onClick={() => mealsQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : meals.length === 0 ? (
          <p className="min-h-12 content-center text-sm text-muted-foreground">
            Nothing planned this week.
          </p>
        ) : (
          meals.map((meal) => {
            const date = parseISO(meal.date);
            const isToday = isSameDay(date, today);
            const mealLabel = mealListLabel(meal);
            const SlotIcon = mealTypeIcon(meal.mealType);
            const KindIcon = mealKindIcon(meal.mealKind);
            return (
              <Link
                key={meal.id}
                to="/meals/$shortcode"
                params={{ shortcode: meal.id }}
                className="flex min-h-11 min-w-0 items-center justify-between gap-2 border-b border-border py-1 text-sm last:border-b-0 hover:bg-muted/50 sm:min-h-0 sm:py-0 sm:pb-1"
              >
                <Row align="center" gap="xs" className="min-w-0">
                  <span className="shrink-0 font-mono text-2xs text-slate uppercase tabular-nums">
                    {isToday ? "Today" : format(date, "EEE d")}
                  </span>
                  <SlotIcon
                    className="size-3.5 shrink-0 text-slate"
                    aria-hidden
                  />
                  <span className="truncate" title={mealLabel}>
                    {mealLabel}
                  </span>
                </Row>
                <Row align="center" gap="xs" className="shrink-0">
                  {KindIcon && (
                    <KindIcon
                      className="size-3.5 text-slate"
                      aria-label={MEAL_KIND_LABELS[meal.mealKind]}
                    />
                  )}
                  <span className="text-muted-foreground tabular-nums">
                    {formatMealCost(meal.totals)}
                  </span>
                </Row>
              </Link>
            );
          })
        )}
      </Stack>
    </section>
  );
}
