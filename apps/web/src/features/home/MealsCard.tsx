import { MEAL_KIND_LABELS } from "@cubby/schemas/meal-classification";
import { ForkKnifeIcon } from "@phosphor-icons/react/dist/csr/ForkKnife";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { format, isSameDay, parseISO } from "date-fns";
import { useId } from "react";

import { formatMealCost, mealListLabel } from "~/app/meals/meal-format";
import { mealKindIcon, mealTypeIcon } from "~/app/meals/meal-options";
import { meal } from "~/integrations/tanstack-query/generated/catalog.gen";
import { RecordList, RecordRow } from "~/ui/common/record-list";
import { Row, Stack, SectionHeading } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { Skeleton } from "~/ui/primitives/skeleton";

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
      <SectionHeading
        id={titleId}
        title={
          <>
            <ForkKnifeIcon
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-hidden
            />
            Meals ahead
          </>
        }
        description="The next seven days."
        actions={
          <Button
            render={<Link to="/meals" />}
            nativeButton={false}
            variant="ghost"
            size="sm"
            className="h-11 shrink-0 text-xs sm:h-7"
          >
            Calendar
          </Button>
        }
      />

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
        ) : (
          <RecordList
            aria-label="Meals ahead"
            empty={
              <span className="block min-h-12 content-center text-sm">
                Nothing planned this week.
              </span>
            }
          >
            {meals.map((meal) => {
              const date = parseISO(meal.date);
              const isToday = isSameDay(date, today);
              const mealLabel = mealListLabel(meal);
              const SlotIcon = mealTypeIcon(meal.mealType);
              const KindIcon = mealKindIcon(meal.mealKind);
              return (
                <RecordRow
                  key={meal.id}
                  leading={
                    <Row align="center" gap="xs">
                      <span className="font-mono text-2xs text-slate uppercase tabular-nums">
                        {isToday ? "Today" : format(date, "EEE d")}
                      </span>
                      <SlotIcon
                        className="size-3.5 shrink-0 text-slate"
                        aria-hidden
                      />
                    </Row>
                  }
                  primary={
                    <Link
                      to="/meals/$shortcode"
                      params={{ shortcode: meal.id }}
                      title={mealLabel}
                      className="flex min-h-11 min-w-0 items-center hover:underline sm:min-h-0"
                    >
                      <span className="truncate">{mealLabel}</span>
                    </Link>
                  }
                  trailing={
                    <Row align="center" gap="xs">
                      {KindIcon && (
                        <KindIcon
                          className="size-3.5 text-slate"
                          aria-label={MEAL_KIND_LABELS[meal.mealKind]}
                        />
                      )}
                      <span>{formatMealCost(meal.totals)}</span>
                    </Row>
                  }
                />
              );
            })}
          </RecordList>
        )}
      </Stack>
    </section>
  );
}
