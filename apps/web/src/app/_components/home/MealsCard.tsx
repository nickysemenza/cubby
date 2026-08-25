import { MEAL_KIND_LABELS } from "@cubby/schemas/meal-classification";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { addDays, format, isSameDay, parseISO } from "date-fns";
import { UtensilsCrossed } from "lucide-react";
import { mealUpcomingSummaryQueryOptions } from "~/app/meals/meal.functions";
import { formatMealCost, mealListLabel } from "~/app/meals/meal-format";
import { mealKindIcon, mealTypeIcon } from "~/app/meals/meal-options";
import { Row, Stack } from "~/components/layout";
import {
  CardActionLink,
  DashboardCard,
} from "~/components/layout/dashboard-card";
import { Skeleton } from "~/components/ui/skeleton";
import { useHydrated } from "~/hooks/useHydrated";
import { authClient } from "~/lib/auth-client";

/**
 * Home-page meals tile: what's planned between today and a week out, read from
 * a bounded projection over the calendar's canonical date ordering.
 *
 * The date window is client-local, so the query is hydration-gated alongside
 * auth (see useHydrated): SSR and the first client render agree, then the real
 * local "today" resolves.
 */
export function MealsCard() {
  const session = authClient.useSession();
  const hydrated = useHydrated();
  const isAuthenticated = hydrated && !!session.data?.user;

  const today = hydrated ? new Date() : new Date(0);
  const from = format(today, "yyyy-MM-dd");
  const to = format(addDays(today, 6), "yyyy-MM-dd");

  const { data, isLoading } = useQuery({
    ...mealUpcomingSummaryQueryOptions({ from, to }),
    enabled: isAuthenticated,
  });

  const meals = data ?? [];

  return (
    <DashboardCard
      icon={UtensilsCrossed}
      title="Meals"
      description="Planned for the next 7 days"
      action={<CardActionLink to="/meals">Calendar</CardActionLink>}
    >
      <Stack gap="xs">
        {isLoading || !data ? (
          <>
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-3/4" />
          </>
        ) : meals.length === 0 ? (
          // An empty week states the absence and offers the one thing the
          // footer links below can't: somewhere to start. "What can I make?"
          // is deliberately not repeated here — it already sits directly
          // beneath, and an empty card showing the same link twice reads as a
          // rendering fault.
          <Stack gap="sm" className="py-1">
            <span className="text-muted-foreground text-xs">
              Nothing planned this week.
            </span>
            <Row gap="md">
              <CardActionLink to="/calendar">Plan a meal</CardActionLink>
            </Row>
          </Stack>
        ) : (
          meals.map((meal) => {
            const date = parseISO(meal.date);
            const isToday = hydrated && isSameDay(date, today);
            const mealLabel = mealListLabel(meal);
            const SlotIcon = mealTypeIcon(meal.mealType);
            const KindIcon = mealKindIcon(meal.mealKind);
            return (
              <Link
                key={meal.id}
                to="/meals/$shortcode"
                params={{ shortcode: meal.id }}
                className="flex min-h-11 min-w-0 items-center justify-between gap-2 border-[var(--border)] border-b py-1 text-sm last:border-b-0 hover:bg-muted/50 md:min-h-0 md:py-0 md:pb-1"
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

      {/* Tighter on phones: the links there carry their own 44px touch height,
          so a full 1rem on top of it reads as a hole in the card. */}
      <Row gap="md" className="mt-1 sm:mt-4">
        <CardActionLink to="/meals/suggestions">
          What can I make?
        </CardActionLink>
        <CardActionLink to="/meals/shopping-list">Shopping list</CardActionLink>
      </Row>
    </DashboardCard>
  );
}
