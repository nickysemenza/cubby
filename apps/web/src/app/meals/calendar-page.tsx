import type { MealOut } from "@cubby/schemas/meal";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  addDays,
  addWeeks,
  format,
  isSameDay,
  parseISO,
  startOfWeek,
} from "date-fns";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Plus,
  ShoppingCart,
  Table as TableIcon,
} from "lucide-react";
import { useState } from "react";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Button } from "~/components/ui/button";
import { useTRPC } from "~/trpc/react";
import { formatMealCost } from "./meal-format";
import { useInvalidateMeals } from "./use-meal-mutations";

type View = "calendar" | "table";

export function MealCalendarPage() {
  const [view, setView] = useState<View>("calendar");

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1">
        <div className="inline-flex overflow-hidden rounded-md border">
          <button
            type="button"
            onClick={() => setView("calendar")}
            className={`flex items-center gap-1.5 px-2.5 py-1 text-sm ${view === "calendar" ? "bg-accent font-medium" : "text-muted-foreground"}`} /* tight: segmented toggle icon+label */
          >
            <CalendarDays className="size-4" />
            Calendar
          </button>
          <button
            type="button"
            onClick={() => setView("table")}
            className={`flex items-center gap-1.5 border-l px-2.5 py-1 text-sm ${view === "table" ? "bg-accent font-medium" : "text-muted-foreground"}`} /* tight: segmented toggle icon+label */
          >
            <TableIcon className="size-4" />
            Table
          </button>
        </div>
        <Link to="/meals/shopping-list" className="ml-auto">
          <Button type="button" variant="outline" size="sm">
            <ShoppingCart className="size-4" />
            Shopping list
          </Button>
        </Link>
      </div>

      {view === "calendar" ? <CalendarView /> : <TableView />}
    </div>
  );
}

function CalendarView() {
  const api = useTRPC();
  const navigate = useNavigate();
  const invalidate = useInvalidateMeals();
  const [weekStart, setWeekStart] = useState(() =>
    startOfWeek(new Date(), { weekStartsOn: 0 }),
  );

  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  // Date-only bounds (no time) so the range matches the calendar's days exactly.
  const from = format(weekStart, "yyyy-MM-dd");
  const to = format(addDays(weekStart, 6), "yyyy-MM-dd");

  const { data: meals, isLoading } = useQuery(
    api.meal.getByDateRange.queryOptions({ from, to }),
  );

  const createMeal = useMutation(
    api.meal.create.mutationOptions({
      onSuccess: (meal) => {
        invalidate();
        void navigate({ to: "/meals/$id", params: { id: meal.id } });
      },
    }),
  );

  const today = new Date();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Previous week"
          onClick={() => setWeekStart((w) => addWeeks(w, -1))}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            setWeekStart(startOfWeek(new Date(), { weekStartsOn: 0 }))
          }
        >
          Today
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Next week"
          onClick={() => setWeekStart((w) => addWeeks(w, 1))}
        >
          <ChevronRight className="size-4" />
        </Button>
        <span className="ml-2 text-muted-foreground text-sm">
          {format(weekStart, "MMM d")} –{" "}
          {format(addDays(weekStart, 6), "MMM d, yyyy")}
        </span>
      </div>

      {isLoading ? (
        <SimpleLoading text="Loading your week..." />
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-7">
          {days.map((day) => {
            const dayStr = format(day, "yyyy-MM-dd");
            const dayMeals = (meals ?? []).filter((m) => m.date === dayStr);
            const isToday = isSameDay(day, today);
            return (
              <div
                key={dayStr}
                className="flex min-h-32 flex-col gap-1.5 rounded-lg border p-2" /* tight: calendar day cell */
              >
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground text-xs uppercase">
                    {format(day, "EEE")}
                  </span>
                  <span
                    className={
                      isToday
                        ? "flex size-5 items-center justify-center rounded-full bg-warning/20 font-semibold text-warning text-xs"
                        : "text-muted-foreground text-xs"
                    }
                  >
                    {format(day, "d")}
                  </span>
                </div>

                {dayMeals.map((m) => (
                  <MealChip key={m.id} meal={m} />
                ))}

                <button
                  type="button"
                  disabled={createMeal.isPending}
                  onClick={() => createMeal.mutate({ date: dayStr })}
                  className="mt-auto flex items-center justify-center gap-1 rounded-md border border-dashed py-1 text-muted-foreground text-xs transition-colors hover:bg-accent disabled:opacity-50"
                >
                  <Plus className="size-3" />
                  Meal
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TableView() {
  const api = useTRPC();
  const { data, isLoading } = useQuery(
    api.meal.list.queryOptions({
      filters: {},
      sort: { orderBy: "date", direction: "desc" },
      pagination: { pageIndex: 0, pageSize: 200 },
    }),
  );

  if (isLoading) return <SimpleLoading text="Loading meals..." />;
  const meals = data?.items ?? [];
  const total = data?.meta.totalCount ?? meals.length;
  if (meals.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No meals planned yet — switch to the calendar to add one.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {total > meals.length && (
        <p className="text-muted-foreground text-xs">
          Showing the {meals.length} most recent of {total} meals.
        </p>
      )}
      <div className="overflow-hidden rounded-lg border border-[var(--border-chunky)]">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-muted-foreground text-xs">
            <tr>
              <th className="px-2 py-2 text-left font-medium">Date</th>
              <th className="px-2 py-2 text-left font-medium">Meal</th>
              <th className="px-2 py-2 text-left font-medium">Recipes</th>
              <th className="px-2 py-2 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {meals.map((m) => (
              <tr key={m.id} className="border-t hover:bg-accent/40">
                <td className="whitespace-nowrap px-2 py-2 tabular-nums">
                  <Link
                    to="/meals/$id"
                    params={{ id: m.id }}
                    className="hover:underline"
                  >
                    {format(parseISO(m.date), "EEE, MMM d, yyyy")}
                  </Link>
                </td>
                <td className="px-2 py-2">{m.name || "—"}</td>
                <td className="px-2 py-2 text-muted-foreground">
                  {m.recipes.length === 0
                    ? "—"
                    : m.recipes
                        .map(
                          (r) =>
                            `${r.scale !== 1 ? `${r.scale}× ` : ""}${r.recipe.name}`,
                        )
                        .join(", ")}
                </td>
                <td className="px-2 py-2 text-right tabular-nums">
                  {formatMealCost(m.totals)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MealChip({ meal }: { meal: MealOut }) {
  return (
    <Link
      to="/meals/$id"
      params={{ id: meal.id }}
      className="flex flex-col gap-0.5 rounded-md border bg-card p-1.5 text-xs transition-colors hover:bg-accent" /* tight: calendar meal chip */
    >
      <div className="flex items-center justify-between gap-1">
        <span className="truncate font-medium">{meal.name || "Meal"}</span>
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {formatMealCost(meal.totals)}
        </span>
      </div>
      {meal.recipes.length === 0 ? (
        <span className="text-muted-foreground italic">empty</span>
      ) : (
        meal.recipes.map((r) => (
          <span key={r.id} className="truncate text-muted-foreground">
            {r.scale !== 1 ? `${r.scale}× ` : ""}
            {r.recipe.name}
          </span>
        ))
      )}
    </Link>
  );
}
