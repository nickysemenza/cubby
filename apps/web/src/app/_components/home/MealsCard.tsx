import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { addDays, format, isSameDay, parseISO } from "date-fns";
import { UtensilsCrossed } from "lucide-react";
import { formatMealCost } from "~/app/meals/meal-format";
import { Row, Stack } from "~/components/layout";
import { DashboardCard } from "~/components/layout/dashboard-card";
import { Skeleton } from "~/components/ui/skeleton";
import { useHydrated } from "~/hooks/useHydrated";
import { useTRPC } from "~/integrations/trpc/react";
import { authClient } from "~/lib/auth-client";

/** A glance, not the calendar — the rest lives one click away on /meals. */
const MAX_ROWS = 4;

/**
 * Home-page meals tile: what's planned between today and a week out, read from
 * the same `meal.getByDateRange` query the calendar uses (date-only bounds, so
 * the range matches whole days).
 *
 * The date window is client-local, so the query is hydration-gated alongside
 * auth (see useHydrated): SSR and the first client render agree, then the real
 * local "today" resolves.
 */
export function MealsCard() {
  const api = useTRPC();
  const session = authClient.useSession();
  const hydrated = useHydrated();
  const isAuthenticated = hydrated && !!session.data?.user;

  const today = hydrated ? new Date() : new Date(0);
  const from = format(today, "yyyy-MM-dd");
  const to = format(addDays(today, 6), "yyyy-MM-dd");

  const { data, isLoading } = useQuery({
    ...api.meal.getByDateRange.queryOptions({ from, to }),
    enabled: isAuthenticated,
  });

  const meals = (data ?? []).slice(0, MAX_ROWS);

  return (
    <DashboardCard
      icon={UtensilsCrossed}
      title="Meals"
      description="Planned for the next 7 days"
      action={
        <Link
          to="/meals"
          className="font-mono text-2xs text-muted-foreground uppercase transition-colors hover:text-foreground"
        >
          Calendar
        </Link>
      }
    >
      <Stack gap="xs">
        {isLoading || !data ? (
          <>
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-3/4" />
          </>
        ) : meals.length === 0 ? (
          <span className="text-muted-foreground text-xs">
            Nothing planned this week.
          </span>
        ) : (
          meals.map((meal) => {
            const date = parseISO(meal.date);
            const isToday = hydrated && isSameDay(date, today);
            const mealLabel =
              meal.name ||
              meal.recipes.map((r) => r.recipe.name).join(", ") ||
              "Untitled meal";
            return (
              <Link
                key={meal.id}
                to="/meals/$shortcode"
                params={{ shortcode: meal.shortcode }}
                className="flex min-w-0 items-center justify-between gap-2 border-[var(--border)] border-b pb-1 text-sm last:border-b-0 hover:bg-muted/50"
              >
                <Row align="baseline" gap="xs" className="min-w-0">
                  <span className="shrink-0 font-mono text-2xs text-slate uppercase tabular-nums">
                    {isToday ? "Today" : format(date, "EEE d")}
                  </span>
                  <span className="truncate" title={mealLabel}>
                    {mealLabel}
                  </span>
                </Row>
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  {formatMealCost(meal.totals)}
                </span>
              </Link>
            );
          })
        )}
      </Stack>

      <Row gap="md" className="mt-4">
        <Link
          to="/meals/suggestions"
          className="font-mono text-2xs text-muted-foreground uppercase transition-colors hover:text-foreground"
        >
          What can I make?
        </Link>
        <Link
          to="/meals/shopping-list"
          className="font-mono text-2xs text-muted-foreground uppercase transition-colors hover:text-foreground"
        >
          Shopping list
        </Link>
      </Row>
    </DashboardCard>
  );
}
